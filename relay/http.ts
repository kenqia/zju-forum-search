import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { PlannerError } from '../frontend/src/extension/planner';
import { RelayService } from './service';
import { TrialError } from './store';

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new TrialError('trial_invalid', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TrialError('trial_invalid', 400); }
}

export function createRelayServer(service: RelayService) {
  const bursts = new Map<string, { count: number; expires: number }>();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = request.url;
      if (request.method === 'GET' && path === '/healthz') { response.end('{"ok":true}'); return; }
      // Only trust the immediate loopback reverse proxy, which replaces this header.
      const peer = request.socket.remoteAddress ?? '';
      const ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
        ? String(request.headers['x-real-ip'] ?? peer) : peer;
      const ipKey = createHash('sha256').update(ip).digest('hex');
      const now = Date.now();
      for (const [key, entry] of bursts) if (entry.expires <= now) bursts.delete(key);
      const entry = bursts.get(ipKey) ?? { count: 0, expires: now + 60_000 };
      entry.count++;
      if (bursts.size >= 10_000 && !bursts.has(ipKey)) throw new TrialError('trial_unavailable', 429);
      bursts.set(ipKey, entry);
      if (entry.count > 120) throw new TrialError('trial_unavailable', 429);
      if (path === '/v1/trial/register' && request.method === 'POST') {
        // Do not grant new credentials while the sponsor is disabled or out of budget.
        if (!service.store.available(service.config)) throw new TrialError('trial_unavailable');
        response.end(JSON.stringify({ ok: true, token: service.store.register(), remaining: 5, available: true }));
        return;
      }
      const token = String(request.headers.authorization ?? '').replace(/^Bearer /u, '');
      const owner = service.store.owner(token);
      if (path === '/v1/trial/status' && request.method === 'GET') {
        response.end(JSON.stringify({ ok: true, ...service.status(owner) })); return;
      }
      if (path === '/v1/trial/finish' && request.method === 'POST') {
        const input = await jsonBody(request) as { runId?: unknown };
        if (!input || typeof input.runId !== 'string' || input.runId.length !== 36) throw new TrialError('trial_invalid', 400);
        response.flushHeaders();
        await service.finish(owner, input.runId);
        response.end('{"ok":true}'); return;
      }
      if (path !== '/v1/trial/plan' || request.method !== 'POST') {
        response.statusCode = 404; response.end('{"ok":false}'); return;
      }
      const input = await jsonBody(request);
      const controller = new AbortController();
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      // MV3 fetch must receive headers within 30s; the JSON result may take 60s.
      response.flushHeaders();
      response.end(JSON.stringify(await service.plan(token, input, controller.signal)));
    } catch (error) {
      const known = error instanceof TrialError || error instanceof PlannerError;
      if (!response.headersSent) response.statusCode = error instanceof TrialError ? error.status : 503;
      if (!response.destroyed) response.end(JSON.stringify({ ok: false,
        code: known ? error.code : 'trial_unavailable',
        error: known ? error.message : '免费体验暂不可用，请稍后重试或配置自己的 API Key' }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
