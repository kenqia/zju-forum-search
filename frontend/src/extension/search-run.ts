import type { FeedbackInput } from './planner';
import { SearchSession, SearchSessionError, stopReasonText, type SearchPlanner, type SearchSnapshot } from './search-session';
import { sourceRegistry } from './source-registry';
import { SourceError, DEFAULT_SETTINGS, type SourceCapabilities, type ExtensionFailureCode, type ExtensionRequest, type ExtensionResponseFor, type FeedbackPlan, type FinalRerankPlan, type FinalRerankRequestInput, type ModelQueryPlan, type PublicExtensionSettings, type SearchSourceSession, type TrialStatus } from './types';

export interface RuntimeMessenger {
  send<Request extends ExtensionRequest>(message: Request): Promise<ExtensionResponseFor<Request>>;
  onOpenRequested?(listener: () => void): () => void;
}

export function responseError(response: { ok: false; error: string; code?: ExtensionFailureCode }, timeoutMessage?: string): Error {
  if (response.code === 'model_timeout') {
    return new SearchSessionError(timeoutMessage ?? '模型调用超过 60 秒，已停止搜索。', 'model_timeout');
  }
  return new Error(response.error || '扩展后台请求失败');
}

class BackgroundPlanner implements SearchPlanner {
  constructor(
    private readonly runtime: RuntimeMessenger,
    private readonly capabilities: SourceCapabilities,
    private readonly modelSearchNarrowingEnabled: boolean,
    private readonly runId: string = globalThis.crypto.randomUUID(),
  ) {}
  private withCancellation<T>(response: Promise<T>, requestId: string, signal?: AbortSignal): Promise<T> {
    if (!signal) return response;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        void this.runtime.send({ type: 'planner:cancel', requestId }).catch(() => undefined);
        reject(new DOMException('模型请求已取消', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void response.then(
        (value) => { signal.removeEventListener('abort', abort); resolve(value); },
        (error) => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }
  private async requestPlan(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const request = { type: 'planner:first' as const, requestId, runId: this.runId, query, capabilities: this.capabilities };
    const response = await this.withCancellation(this.runtime.send(request), requestId, signal);
    if (!response.ok) throw responseError(response, '模型调用超过 60 秒，未开始检索。');
    return response.plan;
  }
  private async requestFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const response = await this.withCancellation(this.runtime.send({
      type: 'planner:feedback', requestId, runId: this.runId, input, capabilities: this.capabilities,
      modelSearchNarrowingEnabled: this.modelSearchNarrowingEnabled,
    }), requestId, signal);
    if (!response.ok) throw responseError(response, '反馈模型调用超过 60 秒，已保留当前结果。');
    return response.feedback;
  }
  private async requestFinalRerank(input: FinalRerankRequestInput, signal?: AbortSignal): Promise<FinalRerankPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const response = await this.withCancellation(this.runtime.send({ type: 'planner:rerank', requestId, runId: this.runId, input, capabilities: this.capabilities }), requestId, signal);
    if (!response.ok) throw responseError(response, '最终列表重排超过 60 秒，已保留本地预排序。');
    return response.rerank;
  }
  planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    return this.requestPlan(query, signal);
  }
  planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    return this.requestFeedback(input, signal);
  }
  rerankResults(input: FinalRerankRequestInput, signal?: AbortSignal): Promise<FinalRerankPlan> {
    return this.requestFinalRerank(input, signal);
  }
}

export function createBackgroundPlanner(runtime: RuntimeMessenger, capabilities: SourceCapabilities, modelSearchNarrowingEnabled = DEFAULT_SETTINGS.modelSearchNarrowingEnabled): SearchPlanner {
  return new BackgroundPlanner(runtime, capabilities, modelSearchNarrowingEnabled);
}

const EMPTY_SNAPSHOT: SearchSnapshot = {
  query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
  activeSearches: [], executedSearches: [], inactiveSearches: [], results: [],
  softIsolatedResults: [],
  outOfRangeCount: 0, planningNotice: '', stopReason: null, statusText: '输入你想找的内容，结果会在每个检索波次后更新。', finalRerank: 'idle',
};

export interface SearchRunState {
  snapshot: SearchSnapshot;
  running: boolean;
  settling: boolean;
  trial: TrialStatus | null;
  trialLoading: boolean;
}

interface ActiveRun {
  id: string;
  controller: AbortController;
  session?: SearchSession;
  sponsored: boolean;
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('搜索已停止', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Owns the page's current run; retrieval behaviour stays in SearchSession. */
export class SearchRun {
  private active?: ActiveRun;
  private disposed = false;
  private readonly sponsoredRuns = new Set<string>();
  private readonly unfinishedRuns = new Set<string>();
  private trialRevision = 0;
  private currentState: SearchRunState = { snapshot: EMPTY_SNAPSHOT, running: false, settling: false, trial: null, trialLoading: false };
  constructor(private readonly dependencies: {
    runtime: RuntimeMessenger;
    createSource?: () => Promise<SearchSourceSession>;
    onUpdate?: (state: SearchRunState) => void;
  }) {}
  get state(): SearchRunState { return this.currentState; }
  private publish(patch: Partial<SearchRunState>) {
    if (this.disposed) return;
    this.currentState = { ...this.currentState, ...patch };
    this.dependencies.onUpdate?.(this.currentState);
  }
  canStart(settings: PublicExtensionSettings): boolean {
    return !this.disposed && (Boolean(settings.hasApiKey) || (!this.active && !this.sponsoredRuns.size
      && !this.unfinishedRuns.size && !this.state.trialLoading && Boolean(this.state.trial?.available && this.state.trial.remaining > 0)));
  }
  async refreshTrial(): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.trialRevision;
    this.publish({ trialLoading: true });
    let trial: TrialStatus | null = null;
    try {
      for (const id of this.unfinishedRuns) {
        const response = await this.dependencies.runtime.send({ type: 'planner:finish', runId: id });
        if (!response.ok) throw responseError(response);
        this.unfinishedRuns.delete(id);
      }
      const response = await this.dependencies.runtime.send({ type: 'trial:get' });
      if (response.ok) trial = response.trial;
    } catch { /* A failed refresh keeps sponsored admission closed until retry. */ }
    if (revision === this.trialRevision) this.publish({ trial, trialLoading: false });
  }
  async start(query: string, settings: PublicExtensionSettings): Promise<void> {
    query = query.trim();
    if (!query || !this.canStart(settings)) return;
    this.active?.session?.stop('replaced');
    this.active?.controller.abort();
    const current: ActiveRun = { id: crypto.randomUUID(), controller: new AbortController(), sponsored: !settings.hasApiKey };
    this.active = current;
    if (current.sponsored) this.sponsoredRuns.add(current.id);
    this.publish({ running: true, snapshot: { ...EMPTY_SNAPSHOT, query, phase: 'planning', statusText: '正在准备搜索…' } });
    try {
      const response = await untilAborted(this.dependencies.runtime.send({ type: 'planner:begin', runId: current.id }), current.controller.signal);
      if (!response.ok) throw responseError(response);
      const settings = response.settings;
      current.sponsored = !settings.hasApiKey;
      if (current.sponsored) this.sponsoredRuns.add(current.id);
      else this.sponsoredRuns.delete(current.id);
      const source = await untilAborted(this.dependencies.createSource ? this.dependencies.createSource() : this.createSource(), current.controller.signal);
      if (this.active !== current || current.controller.signal.aborted) return;
      const planner = new BackgroundPlanner(this.dependencies.runtime, source.capabilities, settings.modelSearchNarrowingEnabled, current.id);
      const sponsored = !settings.hasApiKey;
      const session = new SearchSession({ planner, source, finalRerankEnabled: settings.finalRerankEnabled,
        finalRerankTopM: sponsored ? Math.min(30, settings.finalRerankTopM) : settings.finalRerankTopM,
        modelSearchNarrowingEnabled: settings.modelSearchNarrowingEnabled,
        onUpdate: (snapshot) => { if (this.active === current) this.publish({ snapshot, running: snapshot.phase !== 'complete' }); },
      });
      current.session = session;
      await session.run(query, sponsored ? Math.min(30, settings.searchRequestLimit) : settings.searchRequestLimit, settings.feedbackEvidenceLimit);
    } catch (error) {
      if (this.active !== current || current.controller.signal.aborted) return;
      const stopReason = error instanceof SourceError && error.code === 'not_logged_in' ? 'not_logged_in'
        : error instanceof SourceError && error.code === 'rate_limited' ? 'rate_limited' : 'failed';
      this.publish({ running: false, snapshot: { ...EMPTY_SNAPSHOT, query, phase: 'complete', stopReason,
        statusText: error instanceof Error ? error.message : '无法创建搜索源。' } });
    } finally {
      if (current.sponsored) this.publish({ settling: true });
      let finished = false;
      try {
        const response = await this.dependencies.runtime.send({ type: 'planner:finish', runId: current.id });
        finished = response.ok;
      } catch { /* Retry failed sponsored cleanup through refreshTrial. */ }
      if (current.sponsored) {
        if (finished) await this.refreshTrial();
        else { this.unfinishedRuns.add(current.id); ++this.trialRevision; this.publish({ trial: null, trialLoading: false }); }
        this.sponsoredRuns.delete(current.id);
        this.publish({ settling: this.sponsoredRuns.size > 0 });
      }
      if (this.active === current) { this.active = undefined; this.publish({ running: false }); }
    }
  }
  private async createSource(): Promise<SearchSourceSession> {
    const adapter = sourceRegistry.resolve(location.href);
    if (!adapter) throw new Error('当前页面没有可用的搜索源。');
    return adapter.createSession({ url: location.href });
  }
  stop(reason: 'user_stopped' | 'replaced' = 'user_stopped') {
    if (!this.active) return;
    if (this.active.session) this.active.session.stop(reason);
    else {
      this.active.controller.abort();
      this.publish({ running: false, snapshot: { ...this.state.snapshot, phase: 'complete',
        stopReason: reason, statusText: stopReasonText(reason) } });
    }
  }
  dispose() {
    this.disposed = true;
    this.active?.session?.stop('replaced');
    this.active?.controller.abort();
  }
}
