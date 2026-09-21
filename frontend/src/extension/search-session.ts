import type { FeedbackInput } from './planner';
import { hasExplicitTimeConstraint } from './planner';
import { folded, normalizeText } from './text';
import { rankAndFilterCandidates, type RankedCandidateView } from './ranking';
import { mergeHits } from './retrieval';
import { createFeedbackInput } from './feedback-payload';
import { applyFeedbackJudgments, selectFeedbackEvidence } from './feedback-evidence';
import { applyFinalRerankPlan, createFinalRerankSelection, type FinalRerankSelection } from './final-reranking';
import { PaginationCursorGuard, pagePredatesStart } from './pagination';
import {
  SourceError,
  type FeedbackPlan,
  type ModelQueryPlan,
  type PlannedSearch,
  type RetrievedCandidate,
  type SearchSourceSession,
  type TopicCandidate,
} from './types';

export type SearchStopReason =
  | 'model_stop'
  | 'no_new_candidates'
  | 'no_new_searches'
  | 'no_results'
  | 'request_limit'
  | 'user_stopped'
  | 'replaced'
  | 'not_logged_in'
  | 'rate_limited'
  | 'model_timeout'
  | 'failed';

export interface SearchSnapshot {
  query: string;
  phase: 'planning' | 'searching' | 'feedback' | 'reranking' | 'complete';
  round: number;
  requestsMade: number;
  plan: ModelQueryPlan | null;
  activeSearches: string[];
  executedSearches: string[];
  inactiveSearches: string[];
  results: TopicCandidate[];
  softIsolatedResults: TopicCandidate[];
  outOfRangeCount: number;
  planningNotice: string;
  stopReason: SearchStopReason | null;
  statusText: string;
  finalRerank: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
}

export interface SearchPlanner {
  planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan>;
  planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan>;
  planBlindExpansion(query: string, signal?: AbortSignal): Promise<ModelQueryPlan>;
  rerankResults?(input: import('./types').FinalRerankRequestInput, signal?: AbortSignal): Promise<import('./types').FinalRerankPlan>;
}

export interface SearchSessionDependencies {
  planner: SearchPlanner;
  source: SearchSourceSession;
  sleep?: (milliseconds: number) => Promise<void>;
  onUpdate?: (snapshot: SearchSnapshot) => void;
  finalRerankEnabled?: boolean;
  finalRerankTopM?: number;
}

export class SearchSessionError extends Error {
  constructor(message: string, readonly reason: SearchStopReason = 'failed') {
    super(message);
  }
}

export function stopReasonText(reason: SearchStopReason): string {
  const messages: Record<SearchStopReason, string> = {
    model_stop: '模型判断已有足够结果，搜索已停止。',
    no_new_candidates: '本轮没有新增候选，搜索已停止。',
    no_new_searches: '没有新的可执行检索词，搜索已停止。',
    no_results: '没有找到主题帖。',
    request_limit: '已达到站点检索请求次数上限，保留当前部分结果。',
    user_stopped: '已由用户停止，保留当前部分结果。',
    replaced: '已发起新查询，旧搜索已终止。',
    not_logged_in: '请先登录，然后刷新页面再试。',
    rate_limited: '搜索源暂时限制了搜索请求，保留当前部分结果。',
    model_timeout: '模型调用超过 20 秒，保留当前部分结果。',
    failed: '搜索失败，保留当前部分结果。',
  };
  return messages[reason];
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException(message, 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException(message, 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class SearchSession {
  private readonly planner: SearchPlanner;
  private readonly source: SearchSourceSession;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onUpdate?: (snapshot: SearchSnapshot) => void;
  private readonly finalRerankEnabled: boolean;
  private readonly finalRerankTopM: number;
  private controller = new AbortController();
  private rerankController: AbortController | null = null;
  private rerankCancelled = false;
  private requestedStop: SearchStopReason | null = null;
  private snapshot: SearchSnapshot = {
    query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
    activeSearches: [], executedSearches: [], inactiveSearches: [], results: [], softIsolatedResults: [],
    outOfRangeCount: 0, planningNotice: '', stopReason: null, statusText: '', finalRerank: 'idle',
  };

  constructor(dependencies: SearchSessionDependencies) {
    this.planner = dependencies.planner;
    this.source = dependencies.source;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onUpdate = dependencies.onUpdate;
    this.finalRerankEnabled = dependencies.finalRerankEnabled ?? true;
    this.finalRerankTopM = dependencies.finalRerankTopM ?? 30;
  }

  stop(reason: 'user_stopped' | 'replaced' = 'user_stopped'): void {
    if (reason === 'user_stopped' && this.snapshot.phase === 'reranking') {
      this.cancelFinalRerank();
      return;
    }
    this.requestedStop = reason;
    this.controller.abort();
    if (reason === 'replaced') this.rerankController?.abort();
  }

  cancelFinalRerank(): void {
    if (!this.rerankController) return;
    this.rerankCancelled = true;
    this.rerankController.abort();
  }

  private publish(patch: Partial<SearchSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.({ ...this.snapshot, results: [...this.snapshot.results], softIsolatedResults: [...this.snapshot.softIsolatedResults] });
  }

  private finishSync(reason: SearchStopReason, statusText = stopReasonText(reason)): SearchSnapshot {
    this.publish({ phase: 'complete', activeSearches: [], stopReason: reason, statusText });
    return this.snapshot;
  }

  /** 正常收尾和用户停止时，对至少两条主结果候选执行一次最终列表重排；被新查询替换时跳过。 */
  private async finish(
    reason: SearchStopReason,
    context: { view: RankedCandidateView; entries: RetrievedCandidate[]; query: string },
    statusText = stopReasonText(reason),
  ): Promise<SearchSnapshot> {
    const mayRerank = reason === 'model_stop' || reason === 'no_new_candidates' || reason === 'no_new_searches'
      || reason === 'request_limit' || reason === 'user_stopped';
    const selection = mayRerank && this.finalRerankEnabled && this.planner.rerankResults
      ? createFinalRerankSelection(context.query, context.view.results, context.entries, this.finalRerankTopM)
      : null;
    if (selection) {
      await this.rerank(context.view, selection);
      if (this.requestedStop === 'replaced') return this.finishSync('replaced');
      this.publish({
        phase: 'complete',
        stopReason: reason,
        statusText: `${statusText} ${this.snapshot.statusText}`,
      });
      return this.snapshot;
    }
    return this.finishSync(reason, statusText);
  }

  /** 原子应用一次列表响应；失败、超时、取消或非法负载都完整保留本地预排序。 */
  private async rerank(view: RankedCandidateView, selection: FinalRerankSelection): Promise<void> {
    this.rerankController = new AbortController();
    this.rerankCancelled = false;
    try {
      this.publish({ phase: 'reranking', activeSearches: [], finalRerank: 'running', statusText: `正在重排本地预排序前 ${selection.input.candidates.length} 条结果…` });
      const signal = this.rerankController.signal;
      const plan = await waitForAbortable(
        this.planner.rerankResults!(selection.input, signal),
        signal,
        '最终列表重排已取消',
      );
      if (this.requestedStop === 'replaced') return;
      if (this.rerankCancelled) {
        this.publish({
          phase: 'complete',
          finalRerank: 'cancelled',
          statusText: '已取消最终列表重排，保留本地预排序。',
        });
        return;
      }
      const outcome = applyFinalRerankPlan(view.results, selection, plan);
      this.publish({
        results: outcome.results,
        finalRerank: 'done',
        statusText: `最终列表重排完成，移除了 ${outcome.removedCount} 条结果。`,
      });
    } catch {
      if (this.requestedStop === 'replaced') return;
      const cancelled = this.rerankCancelled;
      this.publish({
        phase: 'complete',
        finalRerank: cancelled ? 'cancelled' : 'failed',
        statusText: cancelled ? '已取消最终列表重排，保留本地预排序。' : '最终列表重排未完成，已保留本地预排序。',
      });
    } finally {
      this.rerankController = null;
    }
  }

  async run(query: string, requestLimit: number, evidenceLimit = 30): Promise<SearchSnapshot> {
    const normalizedQuery = normalizeText(query);
    const enforceTimeRange = hasExplicitTimeConstraint(normalizedQuery);
    const timeOrderedSource = this.source.capabilities.resultOrdering === 'time-desc';
    const candidates = new Map<string, RetrievedCandidate>();
    const executed = new Map<string, { query: string; hitCount: number }>();
    const inactive = new Set<string>();
    let round = 1;
    let temporaryKeySequence = 0;
    let firstWave = true;
    let blindExpanded = false;
    let pendingFirstPages: PlannedSearch[] = [];
    const continuations = new Map<string, { search: PlannedSearch; cursor: string }>();
    const knownSearches = new Set<string>();
    const { maxSearchCalls, minRequestIntervalMs } = this.source.ratePolicy;
    const maxRequests = Math.min(maxSearchCalls, Math.max(1, Math.round(Number.isFinite(requestLimit) ? requestLimit : 1)));
    const maxEvidence = Math.min(100, Math.max(10, Math.round(Number.isFinite(evidenceLimit) ? evidenceLimit : 30)));
    const cursorGuard = new PaginationCursorGuard();
    let runContext = (): { view: RankedCandidateView; entries: RetrievedCandidate[]; query: string } => ({
      view: { results: [], outOfRangeCount: 0 }, entries: [...candidates.values()], query: normalizedQuery,
    });

    this.publish({ query: normalizedQuery, phase: 'planning', round, statusText: '正在规划首轮检索词…' });
    try {
      const plan = await waitForAbortable(
        this.planner.planFirstRound(normalizedQuery, this.controller.signal),
        this.controller.signal,
        '搜索运行已终止',
      );
      if (this.requestedStop) return this.finish(this.requestedStop, runContext());
      this.publish({
        plan,
        planningNotice: [
          plan.usedOriginalQueryFallback ? '模型计划无效，已直接搜索原词。' : '',
          this.source.capabilities.searchSurface === 'title'
            && (!plan.searches.some((search) => search.role === 'anchor')
              || !plan.searches.some((search) => search.role !== 'anchor'))
            ? '查询组合不完整，仍将执行现有检索词。'
            : '',
        ].filter(Boolean).join(' '),
      });
      const enqueueFirstPages = (searches: PlannedSearch[]) => {
        for (const search of searches) {
          const key = folded(search.query);
          if (!key || knownSearches.has(key)) continue;
          knownSearches.add(key);
          pendingFirstPages.push(search);
        }
      };
      const prioritizedSearches = (() => {
        if (this.source.capabilities.searchSurface !== 'title' || maxRequests < 2) return plan.searches;
        const anchor = plan.searches.find((search) => search.role === 'anchor');
        const nonAnchor = plan.searches.find((search) => search.role !== 'anchor');
        if (!anchor || !nonAnchor) return plan.searches;
        const protectedSearches = new Set([anchor, nonAnchor]);
        return [
          ...plan.searches.filter((search) => protectedSearches.has(search)),
          ...plan.searches.filter((search) => !protectedSearches.has(search)),
        ];
      })();
      enqueueFirstPages(prioritizedSearches);
      const startDate = plan.timeConstraint.startDate;

      const candidateView = () => {
        const ranked = rankAndFilterCandidates([...candidates.values()], plan, enforceTimeRange);
        const softIds = new Set([...candidates.values()]
          .filter((entry) => entry.relevanceGrade === 0)
          .map((entry) => entry.candidate.id));
        return {
          results: ranked.results.filter((candidate) => !softIds.has(candidate.id)),
          softIsolatedResults: ranked.results.filter((candidate) => softIds.has(candidate.id)),
          outOfRangeCount: ranked.outOfRangeCount,
          rankedIds: ranked.results.map((candidate) => candidate.id),
        };
      };
      const publishCandidateView = () => {
        const view = candidateView();
        this.publish({
          results: view.results,
          softIsolatedResults: view.softIsolatedResults,
          outOfRangeCount: view.outOfRangeCount,
        });
      };
      runContext = () => {
        const view = candidateView();
        return { view: { results: view.results, outOfRangeCount: view.outOfRangeCount }, entries: [...candidates.values()], query: normalizedQuery };
      };

      while (true) {
        if (this.requestedStop) return this.finish(this.requestedStop, runContext());
        if (this.snapshot.requestsMade >= maxRequests) return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
        const waveFirstPages = pendingFirstPages;
        pendingFirstPages = [];
        const waveKeys = new Set(waveFirstPages.map((search) => folded(search.query)));
        const queue: Array<{ search: PlannedSearch; cursor?: string }> = waveFirstPages.map((search) => ({ search }));
        for (const [key, continuation] of continuations) {
          if (!waveKeys.has(key)) queue.push(continuation);
        }
        if (!queue.length) return this.finish('no_new_searches', runContext());

        const beforeEvidence = new Map([...candidates].map(([id, entry]) => [id, entry.evidenceRevision ?? 0]));
        this.publish({
          phase: 'searching', round,
          activeSearches: queue.map(({ search }) => search.query),
          statusText: `正在执行第 ${round} 个检索波次…`,
        });

        while (queue.length) {
          if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          if (this.snapshot.requestsMade >= maxRequests) return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
          const current = queue.shift()!;
          const searchKey = folded(current.search.query);
          continuations.delete(searchKey);
          if (this.snapshot.requestsMade > 0) {
            await waitForAbortable(
              this.sleep(minRequestIntervalMs),
              this.controller.signal,
              '站点请求间隔已终止',
            );
            if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          }
          this.publish({ requestsMade: this.snapshot.requestsMade + 1 });
          const page = await waitForAbortable(
            this.source.search(current.search.query, current.cursor, this.controller.signal),
            this.controller.signal,
            '站点检索已终止',
          );
          if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          const previous = executed.get(searchKey);
          executed.set(searchKey, { query: current.search.query, hitCount: (previous?.hitCount ?? 0) + page.hits.length });
          if ((executed.get(searchKey)?.hitCount ?? 0) === 0) inactive.add(current.search.query);
          else inactive.delete(current.search.query);
          mergeHits(candidates, page.hits, current.search.query, round, () => `c${temporaryKeySequence++}`);
          publishCandidateView();
          // Per-search early stop: a fully-dated page already older than the
          // start date means later pages only get older on a time-desc source.
          const exhausted = timeOrderedSource && pagePredatesStart(page, startDate);
          if (!exhausted && cursorGuard.accepts(searchKey, current.cursor, page.nextCursor)) {
            continuations.set(searchKey, { search: current.search, cursor: page.nextCursor! });
          }
        }

        if (this.requestedStop) return this.finish(this.requestedStop, runContext());

        const view = candidateView();
        this.publish({
          results: view.results,
          softIsolatedResults: view.softIsolatedResults,
          outOfRangeCount: view.outOfRangeCount,
          activeSearches: [],
          executedSearches: [...executed.values()].map((search) => search.query),
          inactiveSearches: [...inactive],
          statusText: `第 ${round} 个检索波次完成。`,
        });

        if (firstWave && view.results.length === 0 && !blindExpanded) {
          if (this.snapshot.requestsMade >= maxRequests) {
            return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
          }
          this.publish({ phase: 'feedback', statusText: '首轮没有候选，正在进行一次盲扩展…' });
          const blind = await waitForAbortable(
            this.planner.planBlindExpansion(normalizedQuery, this.controller.signal),
            this.controller.signal,
            '搜索运行已终止',
          );
          if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          blindExpanded = true;
          enqueueFirstPages(blind.searches);
          firstWave = false;
          round += 1;
          continue;
        }
        firstWave = false;
        if (view.results.length === 0 && view.softIsolatedResults.length === 0) return this.finish('no_results', runContext());

        const evidenceChanged = [...candidates.values()].some((entry) => (entry.evidenceRevision ?? 0) > (beforeEvidence.get(entry.candidate.id) ?? 0));
        const selected = evidenceChanged
          ? selectFeedbackEvidence([...candidates.values()], view.rankedIds, maxEvidence)
          : { entries: [], candidates: [] };
        if (!selected.candidates.length) {
          if (this.snapshot.requestsMade >= maxRequests) {
            return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
          }
          if (!pendingFirstPages.length && !continuations.size) return this.finish('no_new_candidates', runContext());
          round += 1;
          continue;
        }

        this.publish({ phase: 'feedback', statusText: `正在判断第 ${round} 个检索波次的候选证据…` });
        const feedback = await waitForAbortable(this.planner.planFeedback(createFeedbackInput({
          query: normalizedQuery,
          executedSearches: [...executed.values()],
          candidates: selected.candidates,
        }), this.controller.signal), this.controller.signal, '反馈调用已终止');
        if (this.requestedStop) return this.finish(this.requestedStop, runContext());
        applyFeedbackJudgments(selected.entries, feedback.judgments);
        feedback.stopSuggestions.forEach((suggestion) => {
          const match = executed.get(folded(suggestion));
          if (match?.hitCount === 0) inactive.add(match.query);
        });
        const judgedView = candidateView();
        this.publish({
          results: judgedView.results,
          softIsolatedResults: judgedView.softIsolatedResults,
          outOfRangeCount: judgedView.outOfRangeCount,
          inactiveSearches: [...inactive],
        });
        if (this.snapshot.requestsMade >= maxRequests) {
          return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
        }
        if (feedback.shouldStop) return this.finish('model_stop', runContext());
        const positiveJudgmentKeys = new Set(feedback.judgments
          .filter((judgment) => judgment.grade === 2 || judgment.grade === 3)
          .map((judgment) => judgment.key));
        const nativeTitleKeys = new Set(selected.entries
          .filter((entry) => entry.candidate.titleOrigin === 'native' && entry.candidate.title.trim())
          .map((entry) => entry.temporaryKey));
        enqueueFirstPages(feedback.newSearches.filter((search) => {
          const supportKeys = [...new Set(search.supportKeys ?? [])];
          return search.basis === 'evidence'
            && supportKeys.length >= 1
            && supportKeys.length <= 3
            && supportKeys.every((key) => positiveJudgmentKeys.has(key) && nativeTitleKeys.has(key));
        }));
        round += 1;
      }
    } catch (error) {
      if (this.requestedStop) return this.finish(this.requestedStop, runContext());
      if (this.snapshot.phase === 'feedback') {
        const reason = error instanceof SearchSessionError ? error.reason : 'failed';
        const message = error instanceof Error ? error.message : stopReasonText(reason);
        return this.finishSync(reason, message);
      }
      if (error instanceof SearchSessionError) {
        return this.finish(error.reason, runContext(), error.message);
      }
      if (error instanceof SourceError) {
        const reason: SearchStopReason = error.code === 'rate_limited' ? 'rate_limited'
          : error.code === 'not_logged_in' ? 'not_logged_in'
          : 'failed';
        return this.finish(reason, runContext(), error.message);
      }
      const message = error instanceof Error ? error.message : stopReasonText('failed');
      return this.finish('failed', runContext(), message);
    }
  }
}
