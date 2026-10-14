import { PlannerClient, PlannerError, type PlannerTransport } from '../frontend/src/extension/planner';
import { DEFAULT_SETTINGS, MODEL_MAX_COMPLETION_TOKENS, MODEL_TIMEOUT_MS } from '../frontend/src/extension/types';
import type { RelayConfig } from './config';
import { parseRequest } from './input';
import { TrialError, TrialStore } from './store';

export class RelayService {
  private readonly busy = new Set<string>();
  private readonly busyOwners = new Set<string>();
  private inFlight = 0;
  constructor(readonly store: TrialStore, readonly config: RelayConfig, private readonly providerFetch = fetch) {}
  status(owner: string) {
    return { remaining: this.store.remaining(owner), available: this.store.available(this.config) };
  }
  async plan(token: string, raw: unknown, signal?: AbortSignal) {
    const owner = this.store.owner(token);
    const request = parseRequest(raw);
    if (this.busy.has(request.runId) || this.busyOwners.has(owner)) throw new TrialError('trial_invalid', 409);
    if (this.inFlight >= 4) throw new TrialError('trial_unavailable', 429);
    if (!this.store.available(this.config)) throw new TrialError('trial_unavailable');
    if (request.kind === 'first') this.store.begin(owner, request.runId);
    else {
      const run = this.store.run(owner, request.runId);
      if (run.state !== 'active' || (request.kind === 'feedback' && run.calls >= 31)) throw new TrialError('trial_invalid', 409);
    }
    this.busy.add(request.runId);
    this.busyOwners.add(owner);
    this.inFlight++;
    const transport: PlannerTransport = {
      chatCompletions: async (_settings, messages) => {
        const inputBound = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 1024;
        const reserved = (inputBound * this.config.inputPrice + MODEL_MAX_COMPLETION_TOKENS * this.config.outputPrice) / 1e6;
        const periods = this.store.reserve(owner, request.runId, reserved, this.config, request.kind === 'rerank');
        let actual = reserved;
        let failed = true;
        const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
        try {
          const response = await this.providerFetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST', redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
            body: JSON.stringify({ model: this.config.model, messages,
              response_format: { type: 'json_object' }, enable_thinking: false, max_completion_tokens: MODEL_MAX_COMPLETION_TOKENS }),
          });
          if (!response.ok) throw new TrialError('trial_unavailable');
          // Bound responses without writing provider output or errors into logs.
          const reader = response.body?.getReader();
          if (!reader) throw new TrialError('trial_unavailable');
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 128 * 1024) { await reader.cancel(); throw new TrialError('trial_unavailable'); }
            chunks.push(value);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const usage = body?.usage;
          if (Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0
            && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
            actual = (usage.prompt_tokens * this.config.inputPrice + usage.completion_tokens * this.config.outputPrice) / 1e6;
            // A provider exceeding the token reservation cannot safely stay enabled.
            if (actual > reserved) this.config.enabled = false;
          }
          const content = body?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') throw new TrialError('trial_unavailable');
          if (request.kind === 'first') this.store.commit(owner, request.runId);
          failed = false;
          return content;
        } catch (error) {
          if (timeout.aborted) throw new PlannerError('模型调用超过 60 秒', 'model_timeout');
          if (signal?.aborted) throw new PlannerError('模型请求已取消', 'model_cancelled');
          throw error instanceof TrialError ? error : new TrialError('trial_unavailable');
        } finally { this.store.settle(request.runId, periods, reserved, actual, failed); }
      },
    };
    const planner = new PlannerClient(transport, { ...DEFAULT_SETTINGS,
      modelSearchNarrowingEnabled: request.kind === 'feedback' && request.narrowing,
    }, { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' });
    try {
      if (request.kind === 'first') return { ok: true, plan: await planner.planFirstRound(request.query, signal) };
      if (request.kind === 'feedback') return { ok: true, feedback: await planner.planFeedback(request.input, signal) };
      return { ok: true, rerank: await planner.rerankResults(request.input, signal) };
    } catch (error) {
      if (request.kind === 'first') this.store.finish(owner, request.runId);
      throw error;
    } finally { this.busy.delete(request.runId); this.busyOwners.delete(owner); this.inFlight--; }
  }
}
