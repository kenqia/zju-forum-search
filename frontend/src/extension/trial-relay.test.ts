import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrialStore } from '../../../relay/store';
import { RelayService } from '../../../relay/service';
import { createRelayServer } from '../../../relay/http';
import type { RelayConfig } from '../../../relay/config';
import { TrialClient } from './trial';

const config = (): RelayConfig => ({ enabled: true, baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-test-key', model: 'synthetic',
  inputPrice: 3, outputPrice: 12, dailyBudget: 20, monthlyBudget: 100, searchBudget: 1.5 });
const plan = { summary: '课程资料', searches: [{ query: '高数', purpose: '课程', role: 'anchor' }, { query: '高数 资料', purpose: '资料', role: 'balanced' }],
  required_concepts: [], excluded_terms: [], time_constraint: { expression: '', start_date: null, end_date: null } };
const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
const stores: TrialStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.db.close()); });
const store = () => { const value = new TrialStore(':memory:'); stores.push(value); return value; };
const first = (runId = randomUUID()) => ({ kind: 'first', runId, query: '找高数课程资料' });
const feedback = (runId: string) => ({ kind: 'feedback', runId, input: { query: '找高数课程资料', executedSearches: [], candidates: [] } });

describe('sponsored trial relay', () => {
  it('charges one full search, including feedback and rerank; refuses a sixth search', async () => {
    const db = store(); const token = db.register(); const owner = db.owner(token);
    const provider = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const messages = JSON.parse(String(init!.body)).messages;
      return response(messages[0].content.includes('最终列表重排器') ? { ordered_keys: ['a', 'b'], remove_keys: [] }
        : messages[0].content.includes('语义反馈') ? { judgments: [], new_searches: [], should_stop: false } : plan);
    });
    const service = new RelayService(db, config(), provider);
    for (let index = 0; index < 5; index++) {
      const request = first();
      await service.plan(token, request);
      await service.plan(token, feedback(request.runId));
      await service.plan(token, { kind: 'rerank', runId: request.runId, input: { query: request.query, candidates: ['a', 'b'].map((key) =>
        ({ key, title: '高数', matchedQueries: ['高数'], independentQueryCount: 1, bestSourcePosition: 1 })) } });
      expect(service.status(owner).remaining).toBe(4 - index);
      db.finish(owner, request.runId);
    }
    await expect(service.plan(token, first())).rejects.toMatchObject({ code: 'trial_exhausted' });
    expect(provider).toHaveBeenCalledTimes(15);
  });

  it('refunds a first provider failure, retains possible provider spend, and charges an invalid successful plan', async () => {
    const db = store(); const token = db.register(); const owner = db.owner(token);
    const service = new RelayService(db, config(), vi.fn(async () => new Response('', { status: 502 })));
    await expect(service.plan(token, first())).rejects.toMatchObject({ code: 'trial_unavailable' });
    expect(service.status(owner).remaining).toBe(5);
    expect(Number(db.db.prepare('SELECT SUM(cost) AS cost FROM spend').get()!.cost)).toBeGreaterThan(0);
    const invalid = new RelayService(db, config(), vi.fn(async () => response({})));
    await expect(invalid.plan(token, first())).rejects.toThrow();
    expect(service.status(owner).remaining).toBe(4);
  });

  it('rejects parallel and replayed starts and unowned run IDs', async () => {
    const db = store(); const token = db.register(); const request = first();
    let resolve!: (value: Response) => void;
    const provider = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const service = new RelayService(db, config(), provider);
    const pending = service.plan(token, request);
    await expect(service.plan(token, request)).rejects.toMatchObject({ code: 'trial_invalid' });
    await expect(service.plan(token, first())).rejects.toMatchObject({ code: 'trial_invalid' });
    resolve(response(plan)); await pending;
    await expect(service.plan(db.register(), feedback(request.runId))).rejects.toMatchObject({ code: 'trial_invalid' });
    db.finish(db.owner(token), request.runId);
    await expect(service.plan(token, request)).rejects.toMatchObject({ code: 'trial_invalid' });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('reserves budget before concurrent upstream calls', async () => {
    const db = store(); let resolve!: (value: Response) => void;
    const provider = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const options = { ...config(), dailyBudget: 0.04 };
    const service = new RelayService(db, options, provider);
    const pending = service.plan(db.register(), first());
    await expect(service.plan(db.register(), first())).rejects.toMatchObject({ code: 'trial_unavailable' });
    expect(provider).toHaveBeenCalledOnce();
    resolve(response(plan)); await pending;
  });

  it('bounds feedback to 30 calls and seals the run after reranking', async () => {
    const db = store(); const token = db.register(); const request = first();
    const provider = vi.fn(async () => response(plan));
    const service = new RelayService(db, config(), provider);
    await service.plan(token, request);
    provider.mockImplementation(async () => response({ judgments: [], new_searches: [], should_stop: false }));
    for (let i = 0; i < 30; i++) await service.plan(token, feedback(request.runId));
    await expect(service.plan(token, feedback(request.runId))).rejects.toMatchObject({ code: 'trial_invalid' });
    expect(provider).toHaveBeenCalledTimes(31);
    provider.mockImplementation(async () => response({ ordered_keys: ['a', 'b'], remove_keys: [] }));
    await service.plan(token, { kind: 'rerank', runId: request.runId, input: { query: request.query, candidates: ['a', 'b'].map((key) =>
      ({ key, title: '高数', matchedQueries: ['高数'], independentQueryCount: 1, bestSourcePosition: 1 })) } });
    await expect(service.plan(token, feedback(request.runId))).rejects.toMatchObject({ code: 'trial_invalid' });
    expect(provider).toHaveBeenCalledTimes(32);
  });

  it('does not charge cancellation before the first response but retains a committed search on later cancellation', async () => {
    const db = store(); const token = db.register(); const owner = db.owner(token);
    const controller = new AbortController();
    const provider = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const service = new RelayService(db, config(), provider);
    const pending = service.plan(token, first(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'model_cancelled' });
    expect(db.remaining(owner)).toBe(5);
    const request = first();
    await new RelayService(db, config(), vi.fn(async () => response(plan))).plan(token, request);
    const later = new AbortController();
    const feedbackPending = service.plan(token, feedback(request.runId), later.signal);
    later.abort();
    await expect(feedbackPending).rejects.toMatchObject({ code: 'model_cancelled' });
    expect(db.remaining(owner)).toBe(4);
  });

  it('rejects forbidden fields before sending data to the provider', async () => {
    const db = store(); const provider = vi.fn(); const service = new RelayService(db, config(), provider); const token = db.register();
    for (const field of ['messages', 'baseUrl', 'apiKey', 'body', 'author', 'url']) {
      await expect(service.plan(token, { ...first(), [field]: 'forbidden' })).rejects.toMatchObject({ code: 'trial_invalid' });
    }
    await expect(service.plan(token, { ...feedback(randomUUID()), input: { query: '资料', executedSearches: [], candidates: [
      { key: 'a', title: '课程', matchedQueries: [], author: 'forbidden' },
    ] } })).rejects.toMatchObject({ code: 'trial_invalid' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('keeps usage and quota after restart without saving queries or model content', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zju-trial-test-')); const path = join(directory, 'test.sqlite');
    let db = new TrialStore(path);
    try {
      const token = db.register(); const owner = db.owner(token);
      const service = new RelayService(db, config(), vi.fn(async () => response(plan)));
      await service.plan(token, first());
      const spent = db.db.prepare('SELECT cost FROM spend ORDER BY period').all();
      db.db.close(); db = new TrialStore(path);
      expect(db.remaining(owner)).toBe(4);
      expect(db.db.prepare('SELECT cost FROM spend ORDER BY period').all()).toEqual(spent);
      const persisted = JSON.stringify(['installs', 'runs', 'spend'].map((table) => db.db.prepare(`SELECT * FROM ${table}`).all()));
      expect(persisted).not.toContain('高数'); expect(persisted).not.toContain(token);
    } finally { db.db.close(); rmSync(directory, { recursive: true }); }
  });

  it('connects the extension trial client through the HTTP server and persists only its anonymous credential', async () => {
    const db = store(); const provider = vi.fn(async () => response(plan));
    const server = createRelayServer(new RelayService(db, config(), provider));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    let credential: string | undefined;
    const client = new TrialClient({ get: async () => credential, set: async (token) => { credential = token; } },
      (url, init) => fetch(url.replace('https://api.kenqia.top', `http://127.0.0.1:${address.port}`), init));
    try {
      expect(await client.status()).toEqual({ remaining: 5, available: true });
      const request = first();
      expect(await client.plan({ type: 'planner:first', requestId: randomUUID(), runId: request.runId, query: request.query,
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } })).toMatchObject({ ok: true, plan: { summary: '课程资料' } });
      await client.finish(request.runId);
      expect(await client.status()).toEqual({ remaining: 4, available: true });
      expect(provider).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});
