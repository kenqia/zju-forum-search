import { createFeedbackInput } from './feedback-payload';
import type { ExtensionFailureCode, ExtensionRequest, TrialStatus } from './types';

export const TRIAL_BASE_URL = 'https://api.kenqia.top';
export interface TrialCredentialStorage {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
}
export class TrialClientError extends Error {
  constructor(message: string, readonly code: ExtensionFailureCode) { super(message); }
}

export class TrialClient {
  private registering?: Promise<string>;
  constructor(private readonly storage: TrialCredentialStorage, private readonly request: (input: string, init?: RequestInit) => Promise<Response>) {}
  private async call(path: string, token?: string, body?: unknown, signal?: AbortSignal) {
    try {
      const response = await this.request(`${TRIAL_BASE_URL}/v1/trial/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
        credentials: 'omit', redirect: 'error',
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        const code: ExtensionFailureCode = ['trial_exhausted', 'trial_invalid', 'trial_unavailable', 'model_timeout', 'model_cancelled', 'planner_failed'].includes(result.code) ? result.code : 'trial_unavailable';
        throw new TrialClientError(code === 'trial_exhausted' ? '免费体验额度已用完' : code === 'model_timeout' ? '模型调用超过 60 秒'
          : code === 'trial_invalid' ? '试用请求无效，请重新开始搜索' : '免费体验暂不可用，请稍后重试或配置自己的 API Key', code);
      }
      return result;
    } catch (error) {
      if (error instanceof TrialClientError) throw error;
      if (signal?.aborted) throw new TrialClientError('模型请求已取消', 'model_cancelled');
      throw new TrialClientError('免费体验暂不可用，请稍后重试或配置自己的 API Key', 'trial_unavailable');
    }
  }
  private async token() {
    const stored = await this.storage.get();
    if (stored) return stored;
    if (!this.registering) {
      this.registering = (async () => {
        const result = await this.call('register', undefined, {});
        if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/u.test(result.token)) throw new TrialClientError('免费体验暂不可用', 'trial_unavailable');
        await this.storage.set(result.token);
        return result.token as string;
      })();
    }
    try { return await this.registering; } finally { this.registering = undefined; }
  }
  async status(): Promise<TrialStatus> {
    const result = await this.call('status', await this.token());
    if (!Number.isInteger(result.remaining) || result.remaining < 0 || result.remaining > 5 || typeof result.available !== 'boolean') throw new TrialClientError('免费体验暂不可用', 'trial_unavailable');
    return { remaining: result.remaining, available: result.available };
  }
  async plan(request: Extract<ExtensionRequest, { type: 'planner:first' | 'planner:feedback' | 'planner:rerank' }>, signal?: AbortSignal) {
    if (!request.runId) throw new TrialClientError('请重新开始搜索', 'trial_invalid');
    const body = request.type === 'planner:first' ? { kind: 'first', runId: request.runId, query: request.query.trim().slice(0, 500) }
      : request.type === 'planner:feedback' ? { kind: 'feedback', runId: request.runId, input: createFeedbackInput(request.input),
        modelSearchNarrowingEnabled: request.modelSearchNarrowingEnabled }
        : { kind: 'rerank', runId: request.runId, input: { query: request.input.query.slice(0, 500),
          candidates: request.input.candidates.slice(0, 30).map((candidate) => ({
            key: candidate.key.slice(0, 40), title: candidate.title.slice(0, 80),
            ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt.slice(0, 40) } : {}),
            ...(candidate.section !== undefined ? { section: candidate.section.slice(0, 80) } : {}),
            ...(candidate.replyCount !== undefined ? { replyCount: candidate.replyCount } : {}),
            matchedQueries: candidate.matchedQueries.slice(0, 5).map((query) => query.slice(0, 120)),
            independentQueryCount: candidate.independentQueryCount, bestSourcePosition: candidate.bestSourcePosition,
          })) } };
    return this.call('plan', await this.token(), body, signal);
  }
  async finish(runId: string) {
    const token = await this.storage.get();
    if (token) await this.call('finish', token, { runId });
  }
}
