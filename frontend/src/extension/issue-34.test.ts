import { describe, expect, it, vi } from 'vitest';

import { buildFeedbackPayload, createFeedbackInput, FEEDBACK_METADATA_BYTE_LIMIT } from './feedback-payload';
import { buildFinalRerankPayload, createFinalRerankSelection } from './final-reranking';
import { PlannerClient, feedbackSystemPrompt } from './planner';
import { SearchSession } from './search-session';
import {
  DEFAULT_SETTINGS,
  type FeedbackPlan,
  type FeedbackRequestInput,
  type ModelQueryPlan,
  type RetrievedCandidate,
  type SearchHit,
  type SearchSourceSession,
  type TopicCandidate,
} from './types';

const capabilities = {
  searchSurface: 'title' as const,
  querySyntax: 'plain-keyword' as const,
  resultOrdering: 'time-desc' as const,
};

const plan: ModelQueryPlan = {
  summary: '资料',
  searches: [{ query: '原词', purpose: '', role: 'balanced' }],
  requiredConcepts: [],
  excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string, title = id, position = 1, titleOrigin: 'native' | 'body-derived' = 'native'): SearchHit {
  return {
    candidate: {
      sourceId: 'cc98', id, title, titleOrigin, url: `https://example.test/${id}`,
      author: `author-${id}`, publishedAt: '2026-09-22', section: '学习天地', replyCount: 3,
    },
    document: { title, publishedAt: '2026-09-22', snippet: '不得出域' },
    position,
  };
}

function source(search: SearchSourceSession['search']): SearchSourceSession {
  return {
    sourceId: 'cc98', capabilities,
    ratePolicy: { maxSearchCalls: 100, minRequestIntervalMs: 0 },
    search,
  };
}

function feedback(overrides: Partial<FeedbackPlan> = {}): FeedbackPlan {
  return { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '', ...overrides };
}

describe('Issue #34 Final Rerank retrieval facts', () => {
  it('uses all observations for independent count and best position while showing only five first-seen queries', () => {
    const entry: RetrievedCandidate = {
      candidate: hit('one', '资料一').candidate,
      documents: [hit('one', '资料一').document],
      observations: [
        { round: 1, query: ' 首词 ', position: 9 },
        { round: 1, query: '次词', position: 0 },
        { round: 2, query: '首词', position: 3 },
        { round: 2, query: '第三词', position: Number.NaN },
        { round: 3, query: '第四词' },
        { round: 4, query: '第五词', position: 7 },
        { round: 5, query: '第六词', position: 2 },
        { round: 6, query: '第七词', position: -1 },
      ],
      temporaryKey: 'c0', relevanceGrade: 1,
    };
    const second: RetrievedCandidate = {
      candidate: hit('two', '资料二').candidate,
      documents: [hit('two', '资料二').document],
      observations: [{ round: 1, query: '首词' }],
      temporaryKey: 'c1',
    };
    const topics: TopicCandidate[] = [entry, second].map(({ candidate }) => ({
      id: candidate.id, title: candidate.title, board: candidate.section ?? '', time: candidate.publishedAt ?? '',
      author: candidate.author ?? '', replyCount: candidate.replyCount ?? 0, url: candidate.url, firstRound: 1,
    }));

    const selection = createFinalRerankSelection('资料', topics, [entry, second], 2)!;
    expect(selection.input.candidates[0]).toMatchObject({
      key: 'c0',
      matchedQueries: ['首词', '次词', '第三词', '第四词', '第五词'],
      independentQueryCount: 7,
      bestSourcePosition: 2,
    });
    expect(selection.input.candidates[1]).toMatchObject({ bestSourcePosition: null });

    const payload = buildFinalRerankPayload(selection.input);
    expect(payload.candidates[0]).toMatchObject({
      matched_queries: ['首词', '次词', '第三词', '第四词', '第五词'],
      independent_query_count: 7,
      best_source_position: 2,
    });
    expect(payload.candidates[1].best_source_position).toBeNull();
    expect(JSON.stringify(payload)).not.toMatch(/relevance|grade|author|url|sourceId|snippet|round|authorization/u);
  });
});

describe('Issue #34 Feedback search ledger', () => {
  it('reports multiple pages, raw hits, branch uniques, last-page global additions, current grades, continuation, and remaining requests', async () => {
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: [
          { key: input.candidates.find((candidate) => candidate.title === 'A')!.key, grade: 2 },
          { key: input.candidates.find((candidate) => candidate.title === 'B')!.key, grade: 0 },
        ],
      }))
      .mockResolvedValue(feedback({ shouldStop: true }));
    const search = vi.fn()
      .mockResolvedValueOnce({ hits: [hit('a', 'A', 1), hit('b', 'B', 2)], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ hits: [hit('a', 'A', 21), hit('c', 'C', 22)], nextCursor: undefined });

    await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: source(search), sleep: async () => undefined, finalRerankEnabled: false,
    }).run('资料', 10);

    expect(planFeedback).toHaveBeenCalledTimes(2);
    expect(planFeedback.mock.calls[0][0]).toMatchObject({
      remainingRequests: 9,
      searchLedger: [{
        query: '原词', pages: 1, hits: 2, uniqueCandidates: 2, newOnLastPage: 2,
        grade23: 0, grade0: 0, canContinue: true,
      }],
    });
    expect(planFeedback.mock.calls[1][0]).toMatchObject({
      remainingRequests: 8,
      searchLedger: [{
        query: '原词', pages: 2, hits: 4, uniqueCandidates: 3, newOnLastPage: 1,
        grade23: 1, grade0: 1, canContinue: false,
      }],
    });
  });

  it('packs query, date, request budget, ledger, and executed searches before candidate evidence under 4000 UTF-8 bytes', () => {
    const input = {
      query: '教材资料',
      remainingRequests: 17,
      executedSearches: [{ query: '原词', hitCount: 42 }],
      searchLedger: [{
        query: '原词', pages: 3, hits: 42, uniqueCandidates: 31, newOnLastPage: 2,
        grade23: 4, grade0: 19, canContinue: true,
      }],
      candidates: [
        ...Array.from({ length: 9 }, (_, index) => ({
          key: `long-${index}`, title: `长候选-${index}-${'中文'.repeat(80)}`, matchedQueries: ['原词'],
        })),
        { key: 'overflow', title: '中间超限候选'.repeat(40), matchedQueries: ['原词'.repeat(40), '次词'.repeat(40), '第三词'.repeat(40)] },
        { key: 'short', title: '后续短候选', matchedQueries: ['原词'] },
      ],
    } as FeedbackRequestInput;

    const core = createFeedbackInput(input);
    const payload = buildFeedbackPayload(core, '2026-09-22');
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

    expect(payload).toMatchObject({
      query: '教材资料', current_date: '2026-09-22', remaining_requests: 17,
      executed_searches: [{ query: '原词', hit_count: 42 }],
      search_ledger: [{
        query: '原词', pages: 3, hits: 42, unique_candidates: 31, new_on_last_page: 2,
        grade_2_3: 4, grade_0: 19, can_continue: true,
      }],
    });
    expect(payload.candidates.map((candidate) => candidate.key)).not.toContain('overflow');
    expect(payload.candidates.map((candidate) => candidate.key)).toContain('short');
    expect(bytes).toBeLessThanOrEqual(FEEDBACK_METADATA_BYTE_LIMIT);
  });
});

describe('Issue #34 clue-only evidence expansion', () => {
  it('normalizes the grade matrix and accepts a non-substring grade-1 clue only with clue_only true', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      judgments: [
        { key: 'weak', grade: 1 }, { key: 'strong', grade: 2 }, { key: 'zero', grade: 0 }, { key: 'hidden-title', grade: 3 },
      ],
      new_searches: [
        { query: '强证据词', basis: 'evidence', support_keys: ['strong'] },
        { query: '混合证据词', basis: 'evidence', support_keys: ['weak', 'strong'] },
        { query: '教材更换', basis: 'evidence', support_keys: ['weak'], clue_only: true },
        { query: '弱证据未声明', basis: 'evidence', support_keys: ['weak'] },
        { query: '零分证据', basis: 'evidence', support_keys: ['zero'], clue_only: true },
        { query: '未知证据', basis: 'evidence', support_keys: ['unknown'], clue_only: true },
        { query: '不可见标题', basis: 'evidence', support_keys: ['hidden-title'] },
      ],
      should_stop: false,
    }) }, DEFAULT_SETTINGS, capabilities, () => '2026-09-22');

    const result = await client.planFeedback({
      query: '课程教材', remainingRequests: 8, executedSearches: [], searchLedger: [],
      candidates: [
        { key: 'weak', title: '老师突然说这学期换书了', matchedQueries: ['原词'] },
        { key: 'strong', title: '课程教材调整通知', matchedQueries: ['原词'] },
        { key: 'zero', title: '无关内容', matchedQueries: ['原词'] },
        { key: 'hidden-title', title: '', matchedQueries: ['原词'] },
      ],
    });

    expect(result.newSearches).toEqual([
      { query: '强证据词', purpose: '', basis: 'evidence', supportKeys: ['strong'], clueOnly: false },
      { query: '混合证据词', purpose: '', basis: 'evidence', supportKeys: ['weak', 'strong'], clueOnly: false },
      { query: '教材更换', purpose: '', basis: 'evidence', supportKeys: ['weak'], clueOnly: true },
    ]);
    const prompt = feedbackSystemPrompt(capabilities);
    expect(prompt).toContain('clue_only');
    expect(prompt).toContain('不做标题子串、词元重叠或语义相似度校验');
  });

  it('executes ordinary strong or mixed expansions and pure grade-1 clue-only expansions, but rejects invalid provenance', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => {
        const keyByTitle = new Map(input.candidates.map((candidate) => [candidate.title, candidate.key]));
        return feedback({
          judgments: [
            { key: keyByTitle.get('老师突然说这学期换书了')!, grade: 1 },
            { key: keyByTitle.get('课程教材调整通知')!, grade: 2 },
            { key: keyByTitle.get('无关内容')!, grade: 0 },
            { key: keyByTitle.get('')!, grade: 3 },
          ],
          newSearches: [
            { query: '强证据词', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('课程教材调整通知')!] },
            { query: '混合证据词', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('老师突然说这学期换书了')!, keyByTitle.get('课程教材调整通知')!] },
            { query: '教材更换', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('老师突然说这学期换书了')!], clueOnly: true },
            { query: '弱证据未声明', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('老师突然说这学期换书了')!] },
            { query: '零分证据', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('无关内容')!], clueOnly: true },
            { query: '未知证据', purpose: '', basis: 'evidence', supportKeys: ['unknown'], clueOnly: true },
            { query: '不可见标题', purpose: '', basis: 'evidence', supportKeys: [keyByTitle.get('')!] },
          ],
        });
      })
      .mockResolvedValue(feedback({ shouldStop: true }));

    await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: source(async (query) => {
        searched.push(query);
        if (query !== '原词') return { hits: [] };
        return { hits: [
          hit('weak', '老师突然说这学期换书了'),
          hit('strong', '课程教材调整通知'),
          hit('zero', '无关内容'),
          hit('hidden', '正文派生显示标题', 4, 'body-derived'),
        ] };
      }),
      sleep: async () => undefined, finalRerankEnabled: false,
    }).run('课程教材', 10);

    expect(searched).toEqual(['原词', '强证据词', '混合证据词', '教材更换']);
  });
});
