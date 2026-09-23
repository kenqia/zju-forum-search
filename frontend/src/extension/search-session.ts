import type { FeedbackInput } from './planner';
import { hasExplicitTimeConstraint } from './planner';
import { folded, normalizeText } from './text';
import { rankAndFilterCandidates, type RankedCandidateView } from './ranking';
import { mergeHits } from './retrieval';
import { createFeedbackInput, FEEDBACK_SEARCH_QUERY_LIMIT } from './feedback-payload';
import { applyFeedbackJudgments, selectFeedbackEvidence } from './feedback-evidence';
import { applyFinalRerankPlan, createFinalRerankSelection, type FinalRerankSelection } from './final-reranking';
import { PaginationCursorGuard, pagePredatesStart } from './pagination';
import {
  SourceError,
  DEFAULT_SETTINGS,
  type FeedbackPlan,
  type ModelQueryPlan,
  type PlannedSearch,
  type RetrievedCandidate,
  type SearchLedgerEntry,
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
  rerankResults?(input: import('./types').FinalRerankRequestInput, signal?: AbortSignal): Promise<import('./types').FinalRerankPlan>;
}

export interface SearchSessionDependencies {
  planner: SearchPlanner;
  source: SearchSourceSession;
  sleep?: (milliseconds: number) => Promise<void>;
  onUpdate?: (snapshot: SearchSnapshot) => void;
  finalRerankEnabled?: boolean;
  finalRerankTopM?: number;
  modelSearchNarrowingEnabled?: boolean;
}

export class SearchSessionError extends Error {
  constructor(message: string, readonly reason: SearchStopReason = 'failed') {
    super(message);
  }
}

export function stopReasonText(reason: SearchStopReason): string {
  const messages: Record<SearchStopReason, string> = {
    model_stop: '模型已关闭后续扩展，并已完成已知分页。',
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
  private readonly modelSearchNarrowingEnabled: boolean;
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
    this.modelSearchNarrowingEnabled = dependencies.modelSearchNarrowingEnabled ?? DEFAULT_SETTINGS.modelSearchNarrowingEnabled;
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
    const executed = new Map<string, {
      query: string; hitCount: number; pages: number; candidateIds: Set<string>; newOnLastPage: number;
    }>();
    const inactive = new Set<string>();
    let round = 1;
    let temporaryKeySequence = 0;
    let rescueUsed = false;
    let expansionClosed = false;
    let failedRescueSignature: string | null = null;
    let reservationActive = false;
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
      const enqueueFirstPages = (searches: PlannedSearch[], prioritize = false): number => {
        const accepted: PlannedSearch[] = [];
        for (const search of searches) {
          const key = folded(search.query);
          if (!key || knownSearches.has(key)) continue;
          knownSearches.add(key);
          accepted.push(search);
        }
        pendingFirstPages = prioritize ? [...accepted, ...pendingFirstPages] : [...pendingFirstPages, ...accepted];
        return accepted.length;
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
      reservationActive = this.source.capabilities.searchSurface === 'title'
        && maxRequests >= 3
        && prioritizedSearches.length >= maxRequests
        && prioritizedSearches.some((search) => search.role === 'anchor')
        && prioritizedSearches.some((search) => search.role !== 'anchor');
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
      const feedbackSignal = (view: ReturnType<typeof candidateView>): 'none' | 'weak' | 'positive' => {
        const inRangeIds = new Set(view.rankedIds);
        const inRange = [...candidates.values()].filter((entry) => inRangeIds.has(entry.candidate.id));
        if (!inRange.length) return 'none';
        return inRange.some((entry) => entry.relevanceGrade === 2 || entry.relevanceGrade === 3) ? 'positive' : 'weak';
      };
      const rescueSignature = (view: ReturnType<typeof candidateView>): string => {
        const inRangeIds = new Set(view.rankedIds);
        return [...candidates.values()]
          .filter((entry) => inRangeIds.has(entry.candidate.id))
          .map((entry) => `${entry.temporaryKey}:${entry.evidenceRevision ?? 0}:${entry.relevanceGrade ?? 'u'}`)
          .sort()
          .join('|') || 'none';
      };
      const requestLimitStatus = () => `已达到 ${maxRequests} 次站点检索请求上限，保留当前部分结果。`;
      const searchLedger = (): SearchLedgerEntry[] => [...executed].map(([key, branch]) => {
        const branchCandidates = [...branch.candidateIds]
          .map((id) => candidates.get(id))
          .filter((entry): entry is RetrievedCandidate => Boolean(entry));
        return {
          query: branch.query,
          pages: branch.pages,
          hits: branch.hitCount,
          uniqueCandidates: branch.candidateIds.size,
          newOnLastPage: branch.newOnLastPage,
          grade23: branchCandidates.filter((entry) => entry.relevanceGrade === 2 || entry.relevanceGrade === 3).length,
          grade0: branchCandidates.filter((entry) => entry.relevanceGrade === 0).length,
          canContinue: continuations.has(key),
        };
      });

      while (true) {
        if (this.requestedStop) return this.finish(this.requestedStop, runContext());
        const waveFirstPages = pendingFirstPages;
        pendingFirstPages = [];
        const waveKeys = new Set(waveFirstPages.map((search) => folded(search.query)));
        const queue: Array<{ search: PlannedSearch; cursor?: string }> = waveFirstPages.map((search) => ({ search }));
        for (const [key, continuation] of continuations) {
          if (!waveKeys.has(key)) queue.push(continuation);
        }
        if (!queue.length) {
          if (expansionClosed) return this.finish('model_stop', runContext());
          const finalView = candidateView();
          return this.finish(feedbackSignal(finalView) === 'none' ? 'no_results' : 'no_new_candidates', runContext());
        }
        if (this.snapshot.requestsMade >= maxRequests) return this.finish('request_limit', runContext(), requestLimitStatus());

        const beforeEvidence = new Map([...candidates].map(([id, entry]) => [id, entry.evidenceRevision ?? 0]));
        this.publish({
          phase: 'searching', round,
          activeSearches: queue.map(({ search }) => search.query),
          statusText: `正在执行第 ${round} 个检索波次…`,
        });

        while (queue.length) {
          if (this.requestedStop) return this.finish(this.requestedStop, runContext());
          const schedulingLimit = reservationActive ? maxRequests - 1 : maxRequests;
          if (this.snapshot.requestsMade >= schedulingLimit) {
            if (!reservationActive) return this.finish('request_limit', runContext(), requestLimitStatus());
            pendingFirstPages = [
              ...queue.filter((item) => item.cursor === undefined).map((item) => item.search),
              ...pendingFirstPages,
            ];
            break;
          }
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
          const pageCandidateIds = new Set(page.hits.map((hit) => hit.candidate.id.trim()).filter(Boolean));
          const branchCandidateIds = previous?.candidateIds ?? new Set<string>();
          pageCandidateIds.forEach((id) => branchCandidateIds.add(id));
          const globallyNewIds = [...pageCandidateIds].filter((id) => !candidates.has(id));
          executed.set(searchKey, {
            query: current.search.query,
            hitCount: (previous?.hitCount ?? 0) + page.hits.length,
            pages: (previous?.pages ?? 0) + 1,
            candidateIds: branchCandidateIds,
            newOnLastPage: globallyNewIds.length,
          });
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

        const evidenceChanged = [...candidates.values()].some((entry) => (entry.evidenceRevision ?? 0) > (beforeEvidence.get(entry.candidate.id) ?? 0));
        const selected = evidenceChanged
          ? selectFeedbackEvidence([...candidates.values()], view.rankedIds, maxEvidence)
          : { entries: [], candidates: [] };
        const signalBeforeFeedback = feedbackSignal(view);
        const signatureBeforeFeedback = rescueSignature(view);
        const rescueCanBeAttempted = !expansionClosed && !rescueUsed && signalBeforeFeedback !== 'positive'
          && signatureBeforeFeedback !== failedRescueSignature;
        if (!selected.candidates.length && !rescueCanBeAttempted) {
          if (reservationActive) reservationActive = false;
          round += 1;
          continue;
        }

        this.publish({
          phase: 'feedback',
          statusText: selected.candidates.length
            ? `正在判断第 ${round} 个检索波次的候选证据…`
            : '当前没有正信号，正在请求一次查询救援…',
        });
        const feedbackInput = createFeedbackInput({
          query: normalizedQuery,
          remainingRequests: Math.max(0, maxRequests - this.snapshot.requestsMade),
          executedSearches: [...executed.values()].map(({ query: executedQuery, hitCount }) => ({ query: executedQuery, hitCount })),
          searchLedger: searchLedger(),
          candidates: selected.candidates,
        });
        const feedback = await waitForAbortable(
          this.planner.planFeedback(feedbackInput, this.controller.signal),
          this.controller.signal,
          '反馈调用已终止',
        );
        if (this.requestedStop) return this.finish(this.requestedStop, runContext());
        applyFeedbackJudgments(selected.entries, feedback.judgments);
        if (this.modelSearchNarrowingEnabled) {
          const stopQueries = feedback.stopQueries
            ?? feedback.stopSuggestions.map((query) => ({ query, reason: '' }));
          for (const suggestion of stopQueries) {
            const stopKey = folded(normalizeText(suggestion.query).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT));
            if (!stopKey) continue;
            const matches = [...continuations].filter(([key, continuation]) => executed.has(key)
              && folded(normalizeText(continuation.search.query).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT)) === stopKey);
            if (matches.length !== 1) continue;
            // A query stop only removes this branch's next page. It does not
            // cancel queued first pages, consume requests, or close expansion.
            continuations.delete(matches[0][0]);
          }
        }
        const judgedView = candidateView();
        this.publish({
          results: judgedView.results,
          softIsolatedResults: judgedView.softIsolatedResults,
          outOfRangeCount: judgedView.outOfRangeCount,
          inactiveSearches: [...inactive],
        });
        const signalAfterFeedback = feedbackSignal(judgedView);
        const signatureAfterFeedback = rescueSignature(judgedView);
        const judgmentByKey = new Map(feedback.judgments.map((judgment) => [judgment.key, judgment.grade]));
        const feedbackCandidateKeys = new Set(feedbackInput.candidates.map((candidate) => candidate.key));
        const nativeTitleKeys = new Set(selected.entries
          .filter((entry) => feedbackCandidateKeys.has(entry.temporaryKey!)
            && entry.candidate.titleOrigin === 'native' && entry.candidate.title.trim())
          .map((entry) => entry.temporaryKey));
        let justEnqueued = 0;
        if (!expansionClosed) {
          const evidenceSearches = feedback.newSearches.filter((search) => {
            const supportKeys = [...new Set(search.supportKeys ?? [])];
            if (search.basis !== 'evidence' || supportKeys.length < 1 || supportKeys.length > 3
              || supportKeys.some((key) => !nativeTitleKeys.has(key) || !judgmentByKey.has(key))) return false;
            const grades = supportKeys.map((key) => judgmentByKey.get(key)!);
            if (grades.some((grade) => grade === 0)) return false;
            return grades.some((grade) => grade === 2 || grade === 3) || search.clueOnly === true;
          });
          justEnqueued += enqueueFirstPages(evidenceSearches, true);
          const mayRescue = !rescueUsed && signalAfterFeedback !== 'positive';
          if (mayRescue) {
            const rescueSearches = feedback.newSearches.filter((search) => search.basis === 'query'
              && (search.supportKeys?.length ?? 0) === 0);
            const acceptedRescues = enqueueFirstPages(rescueSearches, true);
            justEnqueued += acceptedRescues;
            if (acceptedRescues > 0) rescueUsed = true;
            else failedRescueSignature = signatureAfterFeedback;
          }
        }
        if (signalAfterFeedback === 'positive' || rescueUsed || failedRescueSignature === signatureAfterFeedback || expansionClosed) {
          reservationActive = false;
        }
        const rescueStillEligible = !expansionClosed && !rescueUsed && signalAfterFeedback !== 'positive';
        if (this.modelSearchNarrowingEnabled && feedback.shouldStop
          && !rescueStillEligible && !pendingFirstPages.length && justEnqueued === 0) {
          expansionClosed = true;
          reservationActive = false;
        }
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
