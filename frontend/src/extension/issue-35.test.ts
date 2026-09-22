import { describe, expect, it, vi } from 'vitest';

import { normalizeFeedbackPlan, PlannerClient, feedbackSystemPrompt } from './planner';
import { SearchSession } from './search-session';
import type { FeedbackPlan, FeedbackRequestInput, ModelQueryPlan, SearchHit, SearchSourceSession } from './types';

const capabilities = { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'time-desc' as const };
const plan: ModelQueryPlan = {
  summary: '资料',
  searches: [
    { query: '高命中词', purpose: '', role: 'balanced' },
    { query: '其他分支', purpose: '', role: 'balanced' },
  ],
  requiredConcepts: [], excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string): SearchHit {
  return {
    candidate: { sourceId: 'cc98', id, title: id, titleOrigin: 'native', url: `https://example.test/${id}` },
    document: { title: id }, position: 1,
  };
}

function source(search: SearchSourceSession['search']): SearchSourceSession {
  return { sourceId: 'cc98', capabilities, ratePolicy: { maxSearchCalls: 20, minRequestIntervalMs: 0 }, search };
}

function feedback(overrides: Partial<FeedbackPlan> = {}): FeedbackPlan {
  return { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '', ...overrides };
}

describe('Issue #35 stop_queries continuation protocol', () => {
  it('normalizes new stop_queries per item and keeps legacy strings readable', () => {
    expect(normalizeFeedbackPlan({
      judgments: [], new_searches: [], should_stop: false,
      stop_queries: [
        { query: '  高命中词 ', reason: '  价值低 '.repeat(100) },
        { query: '超'.repeat(121), reason: 'query 超限' },
        { query: ' ', reason: '空 query' },
        { query: '高命中词', reason: '重复' },
        '不是新对象协议',
        42,
      ],
      stop_suggestions: ['旧分支', ' ', '旧分支'],
    })).toMatchObject({
      stopQueries: [
        { query: '高命中词', reason: expect.stringMatching(/^价值低/u) },
        { query: '旧分支', reason: '' },
      ],
      stopSuggestions: ['旧分支'],
    });
    const normalized = normalizeFeedbackPlan({
      judgments: [], new_searches: [], should_stop: false,
      stop_queries: [{ query: 'a', reason: '诊断'.repeat(100) }],
    }).stopQueries!;
    expect(normalized[0].reason.length).toBe(160);
    expect(normalizeFeedbackPlan({
      judgments: [], new_searches: [], should_stop: false,
      stop_queries: [{ query: 'a', reason: 'x' }, { query: 1 }, { query: 'missing reason' }],
    }).stopQueries)
      .toEqual([{ query: 'a', reason: 'x' }]);
  });

  it('stops only a matching live continuation while another branch keeps paging', async () => {
    const calls: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        stopQueries: [
          { query: ' 高命中词 ', reason: '低边际收益' },
          { query: '未执行词', reason: '无效' },
          { query: '已经耗尽', reason: '无效' },
          { query: '', reason: '无效' },
        ],
      }))
      .mockResolvedValue(feedback({ shouldStop: true }));
    const search = vi.fn(async (query: string, cursor?: string) => {
      calls.push(`${query}:${cursor ?? 'first'}`);
      if (cursor) return { hits: [hit(`${query}-page-2`)] };
      return { hits: [hit(`${query}-page-1`)], nextCursor: query === '高命中词' ? 'a-next' : 'b-next' };
    });

    const result = await new SearchSession({
      planner: { planFirstRound: async () => ({
        ...plan,
        searches: [...plan.searches, { query: '已经耗尽', purpose: '', role: 'balanced' }],
      }), planFeedback },
      source: source(search), sleep: async () => undefined, finalRerankEnabled: false,
    }).run('资料', 10);

    expect(calls).toEqual([
      '高命中词:first', '其他分支:first', '已经耗尽:first',
      '其他分支:b-next',
    ]);
    expect(result.requestsMade).toBe(4);
    expect(result.stopReason).toBe('model_stop');
    expect(result.inactiveSearches).toEqual([]);
  });

  it('does not let a query stop change expansion, request limits, or queued first pages', async () => {
    const calls: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        newSearches: [{ query: '新检索词', purpose: '', basis: 'evidence', supportKeys: input.candidates.slice(0, 1).map((candidate) => candidate.key) }],
        stopQueries: [{ query: '高命中词', reason: '只停分页' }],
        shouldStop: true,
      }))
      .mockResolvedValue(feedback({ shouldStop: true }));
    const search = vi.fn(async (query: string, cursor?: string) => {
      calls.push(`${query}:${cursor ?? 'first'}`);
      return { hits: [hit(`${query}-${cursor ?? 'first'}`)], ...(cursor ? {} : { nextCursor: 'next' }) };
    });

    await new SearchSession({
      planner: { planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }), planFeedback },
      source: source(search), sleep: async () => undefined, finalRerankEnabled: false,
    }).run('资料', 2);

    expect(calls).toEqual(['高命中词:first', '新检索词:first']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps user cancellation authoritative after applying a query stop', async () => {
    const calls: string[] = [];
    let sleeps = 0;
    const planFeedback = vi.fn(async (input: FeedbackRequestInput) => feedback({
      judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
      stopQueries: [{ query: '高命中词', reason: '停止这一分支' }],
    }));
    let session!: SearchSession;
    session = new SearchSession({
      planner: {
        planFirstRound: async () => plan,
        planFeedback,
      },
      source: source(async (query, cursor) => {
        calls.push(`${query}:${cursor ?? 'first'}`);
        return { hits: [hit(`${query}-${cursor ?? 'first'}`)], nextCursor: 'next' };
      }),
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) session.stop();
      },
      finalRerankEnabled: false,
    });

    const result = await session.run('资料', 10);

    expect(planFeedback).toHaveBeenCalledOnce();
    expect(calls).toEqual(['高命中词:first', '其他分支:first']);
    expect(result.stopReason).toBe('user_stopped');
  });

  it('matches the query projection shown in the ledger and ignores ambiguous long prefixes', async () => {
    const prefix = '长'.repeat(120);
    const calls: string[] = [];
    const planFeedback = vi.fn(async (input: FeedbackRequestInput) => feedback({
      judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
      stopQueries: [{ query: prefix, reason: '停止唯一匹配' }],
      shouldStop: true,
    }));
    await new SearchSession({
      planner: { planFirstRound: async () => ({
        ...plan, searches: [{ query: `${prefix}甲`, purpose: '' }, { query: `${prefix}乙`, purpose: '' }],
      }), planFeedback },
      source: source(async (query, cursor) => {
        calls.push(`${query.slice(-1)}:${cursor ?? 'first'}`);
        return { hits: [hit(`${query.slice(-1)}-${cursor ?? 'first'}`)], ...(cursor ? {} : { nextCursor: 'next' }) };
      }),
      sleep: async () => undefined, finalRerankEnabled: false,
    }).run('资料', 4);

    expect(calls).toEqual(['甲:first', '乙:first', '甲:next', '乙:next']);
  });

  it('documents that stop_queries is branch control and reason is diagnostic only', () => {
    const prompt = feedbackSystemPrompt(capabilities);
    expect(prompt).toContain('stop_queries');
    expect(prompt).toContain('不是用户维护的停用词表');
    expect(prompt).toContain('reason 只用于本地诊断');
  });
});
