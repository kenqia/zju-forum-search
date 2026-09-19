import type { FeedbackInput } from './planner';
import { hasExplicitTimeConstraint } from './planner';
import { folded, normalizeText } from './text';
import { rankAndFilterCandidates, type RankedCandidateView } from './ranking';
import { firstObservedRound, mergeHits } from './retrieval';
import { createFeedbackInput } from './feedback-payload';
import { runFinalScreening } from './screening';
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
  phase: 'planning' | 'searching' | 'feedback' | 'screening' | 'complete';
  round: number;
  requestsMade: number;
  plan: ModelQueryPlan | null;
  activeSearches: string[];
  executedSearches: string[];
  inactiveSearches: string[];
  learnedTerms: string[];
  results: TopicCandidate[];
  outOfRangeCount: number;
  planningNotice: string;
  stopReason: SearchStopReason | null;
  statusText: string;
  screening: 'idle' | 'running' | 'done' | 'failed';
}

export interface SearchPlanner {
  planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan>;
  planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan>;
  planBlindExpansion(query: string, signal?: AbortSignal): Promise<ModelQueryPlan>;
  screenResults?(input: import('./types').ScreeningRequestInput, signal?: AbortSignal): Promise<import('./types').ScreeningPlan>;
}

export interface SearchSessionDependencies {
  planner: SearchPlanner;
  source: SearchSourceSession;
  sleep?: (milliseconds: number) => Promise<void>;
  onUpdate?: (snapshot: SearchSnapshot) => void;
  intentFilterEnabled?: boolean;
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

export class SearchSession {
  private readonly planner: SearchPlanner;
  private readonly source: SearchSourceSession;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onUpdate?: (snapshot: SearchSnapshot) => void;
  private readonly intentFilterEnabled: boolean;
  private controller = new AbortController();
  private screeningController: AbortController | null = null;
  private requestedStop: SearchStopReason | null = null;
  private snapshot: SearchSnapshot = {
    query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
    activeSearches: [], executedSearches: [], inactiveSearches: [], learnedTerms: [], results: [],
    outOfRangeCount: 0, planningNotice: '', stopReason: null, statusText: '', screening: 'idle',
  };

  constructor(dependencies: SearchSessionDependencies) {
    this.planner = dependencies.planner;
    this.source = dependencies.source;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onUpdate = dependencies.onUpdate;
    this.intentFilterEnabled = dependencies.intentFilterEnabled ?? true;
  }

  stop(reason: 'user_stopped' | 'replaced' = 'user_stopped'): void {
    this.requestedStop = reason;
    this.controller.abort();
    if (reason === 'replaced') this.screeningController?.abort();
  }

  private publish(patch: Partial<SearchSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.({ ...this.snapshot, results: [...this.snapshot.results] });
  }

  private finishSync(reason: SearchStopReason, statusText = stopReasonText(reason)): SearchSnapshot {
    this.publish({ phase: 'complete', stopReason: reason, statusText });
    return this.snapshot;
  }

  /**
   * End path: intent screening runs on normal stops and user stops when it is
   * enabled and results exist. Zero-result and replaced runs skip it.
   */
  private async finish(
    reason: SearchStopReason,
    context: { view: RankedCandidateView; entries: RetrievedCandidate[]; query: string },
    statusText = stopReasonText(reason),
  ): Promise<SearchSnapshot> {
    if (reason !== 'replaced' && context.view.results.length > 0 && this.intentFilterEnabled && this.planner.screenResults) {
      await this.screen(context.view, context.entries, context.query);
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

  /**
   * Multi-batch intent screening: every recalled candidate enters exactly one
   * batch; removal keys merge only after all batches succeed. Any failure,
   * timeout, cancellation, or invalid payload discards every suggestion and
   * keeps the pre-screening list.
   */
  private async screen(view: RankedCandidateView, entries: RetrievedCandidate[], query: string): Promise<void> {
    this.screeningController = new AbortController();
    try {
      const outcome = await runFinalScreening({
        query,
        candidates: entries.map((entry) => entry.candidate),
        visibleResults: view.results,
        signal: this.screeningController.signal,
        onStart: (batchCount) => this.publish({
          phase: 'screening', screening: 'running', statusText: `正在筛选 ${entries.length} 条候选，共 ${batchCount} 批。全部成功后统一应用结果…`,
        }),
        onProgress: (completedBatchCount, batchCount) => this.publish({
          phase: 'screening', screening: 'running',
          statusText: `已完成 ${completedBatchCount}/${batchCount} 批候选筛选。全部成功后统一应用结果…`,
        }),
        request: (batch, signal) => this.planner.screenResults!(batch, signal),
      });
      if (this.requestedStop === 'replaced') return;
      this.publish({
        results: outcome.results,
        screening: 'done',
        statusText: `意图筛选完成，移除了 ${outcome.removedCount} 条结果。`,
      });
    } catch {
      if (this.requestedStop === 'replaced') return;
      this.publish({ phase: 'complete', screening: 'failed', statusText: '意图筛选未完成，已保留筛选前结果。' });
    } finally {
      this.screeningController = null;
    }
  }

  async run(query: string, requestLimit: number): Promise<SearchSnapshot> {
    const normalizedQuery = normalizeText(query);
    const enforceTimeRange = hasExplicitTimeConstraint(normalizedQuery);
    const timeOrderedSource = this.source.capabilities.resultOrdering === 'time-desc';
    const candidates = new Map<string, RetrievedCandidate>();
    const executed = new Map<string, { query: string; hitCount: number }>();
    const inactive = new Set<string>();
    const learned = new Set<string>();
    let round = 1;
    let searches: PlannedSearch[];
    const { maxSearchCalls, minRequestIntervalMs } = this.source.ratePolicy;
    const maxRequests = Math.min(maxSearchCalls, Math.max(1, Math.round(Number.isFinite(requestLimit) ? requestLimit : 1)));
    const cursorGuard = new PaginationCursorGuard();
    let runContext = (): { view: RankedCandidateView; entries: RetrievedCandidate[]; query: string } => ({
      view: { results: [], outOfRangeCount: 0 }, entries: [...candidates.values()], query: normalizedQuery,
    });

    this.publish({ query: normalizedQuery, phase: 'planning', round, statusText: '正在规划首轮检索词…' });
    try {
      const plan = await this.planner.planFirstRound(normalizedQuery, this.controller.signal);
      this.publish({
        plan,
        planningNotice: plan.usedOriginalQueryFallback ? '模型计划无效，已直接搜索原词。' : '',
      });
      searches = plan.searches;
      const startDate = plan.timeConstraint.startDate;

      const candidateView = () => rankAndFilterCandidates([...candidates.values()], plan, enforceTimeRange);
      runContext = () => ({ view: candidateView(), entries: [...candidates.values()], query: normalizedQuery });

      while (true) {
        if (this.requestedStop) return this.finish(this.requestedStop, runContext());
        if (this.snapshot.requestsMade >= maxRequests) return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
        const deduped = searches.filter((search, index, all) => {
          const key = folded(search.query);
          return key && !executed.has(key) && all.findIndex((item) => folded(item.query) === key) === index;
        });
        if (!deduped.length) return this.finish('no_new_searches', runContext());

        const before = candidateView().results.length;
        const roundHits = new Map(deduped.map((search) => [folded(search.query), 0]));
        const queue = deduped.map((search) => ({ search, cursor: undefined as string | undefined }));
        this.publish({
          phase: 'searching', round,
          activeSearches: deduped.map((search) => search.query),
          statusText: `正在执行第 ${round} 轮检索…`,
        });

        while (queue.length) {
          if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          if (this.snapshot.requestsMade >= maxRequests) return this.finish('request_limit', runContext(), `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`);
          const current = queue.shift()!;
          if (this.snapshot.requestsMade > 0) {
            await this.sleep(minRequestIntervalMs);
            if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          }
          this.publish({ requestsMade: this.snapshot.requestsMade + 1 });
          const page = await this.source.search(current.search.query, current.cursor, this.controller.signal);
          roundHits.set(folded(current.search.query), (roundHits.get(folded(current.search.query)) ?? 0) + page.hits.length);
          mergeHits(candidates, page.hits, current.search.query, round);
          this.publish(candidateView());
          // Per-search early stop: a fully-dated page already older than the
          // start date means later pages only get older on a time-desc source.
          const exhausted = timeOrderedSource && pagePredatesStart(page, startDate);
          if (!exhausted && cursorGuard.accepts(folded(current.search.query), current.cursor, page.nextCursor)) {
            queue.push({ search: current.search, cursor: page.nextCursor });
          }
        }

        for (const search of deduped) {
          const hitCount = roundHits.get(folded(search.query)) ?? 0;
          executed.set(folded(search.query), { query: search.query, hitCount });
          if (hitCount === 0) inactive.add(search.query);
        }
        const view = candidateView();
        const visibleIds = new Set(view.results.map((candidate) => candidate.id));
        const newCandidates = [...candidates.values()].filter(
          (candidate) => firstObservedRound(candidate) === round && visibleIds.has(candidate.candidate.id),
        );
        this.publish({
          ...view,
          activeSearches: [],
          executedSearches: [...executed.values()].map((search) => search.query),
          inactiveSearches: [...inactive],
          statusText: `第 ${round} 轮完成，新增 ${view.results.length - before} 个候选。`,
        });

        if (round === 1 && view.results.length === 0) {
          this.publish({ phase: 'feedback', statusText: '首轮没有候选，正在进行一次盲扩展…' });
          const blind = await this.planner.planBlindExpansion(normalizedQuery, this.controller.signal);
          searches = blind.searches;
          round += 1;
          continue;
        }
        if (view.results.length === 0) return this.finish('no_results', runContext());
        if (newCandidates.length === 0) return this.finish('no_new_candidates', runContext());

        this.publish({ phase: 'feedback', statusText: `正在根据第 ${round} 轮新增候选学习检索词…` });
        const feedback = await this.planner.planFeedback(createFeedbackInput({
          query: normalizedQuery,
          executedSearches: [...executed.values()],
          newCandidates: newCandidates.map((entry) => entry.candidate),
          round,
        }), this.controller.signal);
        feedback.learnedTerms.forEach((term) => learned.add(term));
        feedback.stopSuggestions.forEach((suggestion) => {
          const match = executed.get(folded(suggestion));
          if (match?.hitCount === 0) inactive.add(match.query);
        });
        this.publish({ learnedTerms: [...learned], inactiveSearches: [...inactive] });
        if (feedback.shouldStop) return this.finish('model_stop', runContext());
        searches = feedback.newSearches;
        round += 1;
      }
    } catch (error) {
      if (this.requestedStop) return this.finish(this.requestedStop, runContext());
      if (error instanceof SearchSessionError) return this.finish(error.reason, runContext(), error.message);
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
