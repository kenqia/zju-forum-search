import type { FeedbackInput } from './planner';
import { folded, normalizeText } from './planner';
import { rankCandidates } from './ranking';
import {
  MAX_CC98_REQUESTS,
  PAGE_SIZE,
  REQUEST_INTERVAL_MS,
  type FeedbackPlan,
  type ModelQueryPlan,
  type PlannedSearch,
  type TopicCandidate,
} from './types';

export type SearchStopReason =
  | 'model_stop'
  | 'no_new_candidates'
  | 'no_new_searches'
  | 'no_results'
  | 'budget_exhausted'
  | 'request_limit'
  | 'user_stopped'
  | 'replaced'
  | 'not_logged_in'
  | 'cc98_limited'
  | 'failed';

export interface SearchSnapshot {
  query: string;
  phase: 'planning' | 'searching' | 'feedback' | 'complete';
  round: number;
  requestsMade: number;
  plan: ModelQueryPlan | null;
  activeSearches: string[];
  inactiveSearches: string[];
  learnedTerms: string[];
  results: TopicCandidate[];
  stopReason: SearchStopReason | null;
  statusText: string;
}

export interface SearchPlanner {
  planFirstRound(query: string): Promise<ModelQueryPlan>;
  planFeedback(input: FeedbackInput): Promise<FeedbackPlan>;
  planBlindExpansion(query: string): Promise<ModelQueryPlan>;
}

export interface Cc98SearchClient {
  searchTopics(query: string, from: number, size: number, signal?: AbortSignal): Promise<unknown>;
}

export interface SearchSessionDependencies {
  planner: SearchPlanner;
  cc98: Cc98SearchClient;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onUpdate?: (snapshot: SearchSnapshot) => void;
}

export class SearchSessionError extends Error {
  constructor(message: string, readonly reason: SearchStopReason = 'failed') {
    super(message);
  }
}

function topicList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const source = payload as { data?: unknown; items?: unknown };
  if (Array.isArray(source.data)) return source.data;
  if (Array.isArray(source.items)) return source.items;
  if (source.data && typeof source.data === 'object' && Array.isArray((source.data as { items?: unknown }).items)) {
    return (source.data as { items: unknown[] }).items;
  }
  return [];
}

function topicShape(raw: unknown, query: string, rank: number, round: number): TopicCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = normalizeText(item.id ?? item.topicId ?? item.topic_id);
  if (!id) return null;
  const rawUrl = normalizeText(item.url ?? item.link);
  const url = rawUrl.startsWith('https://www.cc98.org/') ? rawUrl : `https://www.cc98.org/topic/${encodeURIComponent(id)}`;
  return {
    id,
    title: normalizeText(item.title ?? item.subject) || `主题 ${id}`,
    board: normalizeText(item.boardName ?? item.board ?? item.boardId),
    time: normalizeText(item.time ?? item.postTime ?? item.createTime),
    author: normalizeText(item.userName ?? item.authorName ?? (item.user as { name?: unknown } | undefined)?.name ?? item.author),
    replyCount: Number(item.replyCount ?? item.replies ?? 0) || 0,
    url,
    retrievalScore: 1 / Math.sqrt(rank),
    bestRank: rank,
    plans: [query],
    firstRound: round,
  };
}

export function stopReasonText(reason: SearchStopReason): string {
  const messages: Record<SearchStopReason, string> = {
    model_stop: '模型判断已有足够结果，搜索已停止。',
    no_new_candidates: '本轮没有新增候选，搜索已停止。',
    no_new_searches: '没有新的可执行检索词，搜索已停止。',
    no_results: '没有找到主题帖。',
    budget_exhausted: '已用完搜索时长，保留当前部分结果。',
    request_limit: '已达到 30 次 CC98 请求硬上限，保留当前部分结果。',
    user_stopped: '已由用户停止，保留当前部分结果。',
    replaced: '已发起新查询，旧搜索已终止。',
    not_logged_in: '请先登录 CC98，然后刷新页面再试。',
    cc98_limited: 'CC98 暂时限制了搜索请求，保留当前部分结果。',
    failed: '搜索失败，保留当前部分结果。',
  };
  return messages[reason];
}

export class SearchSession {
  private readonly planner: SearchPlanner;
  private readonly cc98: Cc98SearchClient;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onUpdate?: (snapshot: SearchSnapshot) => void;
  private controller = new AbortController();
  private requestedStop: SearchStopReason | null = null;
  private snapshot: SearchSnapshot = {
    query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
    activeSearches: [], inactiveSearches: [], learnedTerms: [], results: [],
    stopReason: null, statusText: '',
  };

  constructor(dependencies: SearchSessionDependencies) {
    this.planner = dependencies.planner;
    this.cc98 = dependencies.cc98;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = dependencies.now ?? (() => Date.now());
    this.onUpdate = dependencies.onUpdate;
  }

  stop(reason: 'user_stopped' | 'replaced' = 'user_stopped'): void {
    this.requestedStop = reason;
    this.controller.abort();
  }

  private publish(patch: Partial<SearchSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.({ ...this.snapshot, results: [...this.snapshot.results] });
  }

  private finish(reason: SearchStopReason, statusText = stopReasonText(reason)): SearchSnapshot {
    this.publish({ phase: 'complete', stopReason: reason, statusText });
    return this.snapshot;
  }

  private merge(items: unknown[], query: string, offset: number, round: number, candidates: Map<string, TopicCandidate>): TopicCandidate[] {
    const added: TopicCandidate[] = [];
    items.forEach((raw, index) => {
      const shaped = topicShape(raw, query, offset + index + 1, round);
      if (!shaped) return;
      const existing = candidates.get(shaped.id);
      if (existing) {
        existing.retrievalScore += shaped.retrievalScore;
        existing.bestRank = Math.min(existing.bestRank, shaped.bestRank);
        if (!existing.plans.some((value) => folded(value) === folded(query))) existing.plans.push(query);
        return;
      }
      candidates.set(shaped.id, shaped);
      added.push(shaped);
    });
    return added;
  }

  async run(query: string, budgetSeconds: number): Promise<SearchSnapshot> {
    const normalizedQuery = normalizeText(query);
    const started = this.now();
    const deadline = started + Math.max(1, budgetSeconds) * 1000;
    const candidates = new Map<string, TopicCandidate>();
    const executed = new Map<string, { query: string; hitCount: number }>();
    const inactive = new Set<string>();
    const learned = new Set<string>();
    let round = 1;
    let searches: PlannedSearch[];

    this.publish({ query: normalizedQuery, phase: 'planning', round, statusText: '正在规划首轮检索词…' });
    try {
      const plan = await this.planner.planFirstRound(normalizedQuery);
      this.publish({ plan });
      searches = plan.searches;

      while (true) {
        if (this.requestedStop) return this.finish(this.requestedStop);
        if (this.now() >= deadline) return this.finish('budget_exhausted');
        const deduped = searches.filter((search, index, all) => {
          const key = folded(search.query);
          return key && !executed.has(key) && all.findIndex((item) => folded(item.query) === key) === index;
        });
        if (!deduped.length) return this.finish('no_new_searches');

        const before = candidates.size;
        const roundHits = new Map(deduped.map((search) => [folded(search.query), 0]));
        const queue = deduped.map((search) => ({ search, from: 0 }));
        this.publish({
          phase: 'searching', round,
          activeSearches: deduped.map((search) => search.query),
          statusText: `正在执行第 ${round} 轮检索…`,
        });

        while (queue.length) {
          if (this.requestedStop) return this.finish(this.requestedStop);
          if (this.snapshot.requestsMade >= MAX_CC98_REQUESTS) return this.finish('request_limit');
          if (this.now() >= deadline) return this.finish('budget_exhausted');
          const current = queue.shift()!;
          if (this.snapshot.requestsMade > 0) {
            await this.sleep(Math.min(REQUEST_INTERVAL_MS, Math.max(0, deadline - this.now())));
            if (this.requestedStop) return this.finish(this.requestedStop);
            if (this.now() >= deadline) return this.finish('budget_exhausted');
          }
          this.publish({ requestsMade: this.snapshot.requestsMade + 1 });
          const payload = await this.cc98.searchTopics(current.search.query, current.from, PAGE_SIZE, this.controller.signal);
          const items = topicList(payload);
          roundHits.set(folded(current.search.query), (roundHits.get(folded(current.search.query)) ?? 0) + items.length);
          this.merge(items, current.search.query, current.from, round, candidates);
          this.publish({ results: rankCandidates([...candidates.values()], this.snapshot.plan!) });
          if (items.length === PAGE_SIZE) queue.push({ search: current.search, from: current.from + PAGE_SIZE });
        }

        for (const search of deduped) {
          const hitCount = roundHits.get(folded(search.query)) ?? 0;
          executed.set(folded(search.query), { query: search.query, hitCount });
          if (hitCount === 0) inactive.add(search.query);
        }
        const ranked = rankCandidates([...candidates.values()], this.snapshot.plan!);
        const newCandidates = [...candidates.values()].filter((candidate) => candidate.firstRound === round);
        this.publish({
          results: ranked,
          activeSearches: [],
          inactiveSearches: [...inactive],
          statusText: `第 ${round} 轮完成，新增 ${candidates.size - before} 个候选。`,
        });

        if (round === 1 && candidates.size === 0) {
          this.publish({ phase: 'feedback', statusText: '首轮没有候选，正在进行一次盲扩展…' });
          const blind = await this.planner.planBlindExpansion(normalizedQuery);
          searches = blind.searches;
          round += 1;
          continue;
        }
        if (candidates.size === 0) return this.finish('no_results');
        if (newCandidates.length === 0) return this.finish('no_new_candidates');

        this.publish({ phase: 'feedback', statusText: `正在根据第 ${round} 轮新增候选学习检索词…` });
        const feedback = await this.planner.planFeedback({
          query: normalizedQuery,
          executedSearches: [...executed.values()],
          newCandidates,
          round,
        });
        feedback.learnedTerms.forEach((term) => learned.add(term));
        feedback.stopSuggestions.forEach((suggestion) => {
          const match = executed.get(folded(suggestion));
          if (match?.hitCount === 0) inactive.add(match.query);
        });
        this.publish({ learnedTerms: [...learned], inactiveSearches: [...inactive] });
        if (feedback.shouldStop) return this.finish('model_stop');
        searches = feedback.newSearches;
        round += 1;
      }
    } catch (error) {
      if (this.requestedStop) return this.finish(this.requestedStop);
      if (error instanceof SearchSessionError) return this.finish(error.reason, error.message);
      const message = error instanceof Error ? error.message : stopReasonText('failed');
      return this.finish('failed', message);
    }
  }
}
