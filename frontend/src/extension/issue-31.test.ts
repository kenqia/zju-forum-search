import { describe, expect, it, vi } from 'vitest';

import { feedbackSystemPrompt } from './planner';
import { SearchSession, type SearchPlanner } from './search-session';
import type { FeedbackPlan, FeedbackRequestInput, ModelQueryPlan, SearchHit, SearchPage, SearchSourceSession } from './types';

const plan: ModelQueryPlan = {
  summary: '资料',
  searches: [{ query: '精确词', purpose: '', role: 'precise' }, { query: '宽锚点', purpose: '', role: 'anchor' }],
  requiredConcepts: [],
  excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string, title = id): SearchHit {
  return {
    candidate: { sourceId: 'cc98', id, title, titleOrigin: 'native', url: `https://example.test/${id}` },
    document: { title },
    position: 1,
  };
}

function feedback(overrides: Partial<FeedbackPlan> = {}): FeedbackPlan {
  return { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '', ...overrides };
}

function source(search: SearchSourceSession['search']): SearchSourceSession {
  return {
    sourceId: 'cc98',
    capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
    ratePolicy: { maxSearchCalls: 100, minRequestIntervalMs: 0 },
    search,
  };
}

function session(planner: SearchPlanner, search: SearchSourceSession['search']) {
  return new SearchSession({ planner, source: source(search), sleep: async () => undefined, finalRerankEnabled: false, modelSearchNarrowingEnabled: true });
}

describe('Issue #31 unified no-positive-signal rescue', () => {
  it('sends empty candidates through Feedback and executes one legal query rescue', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn(async (input: FeedbackRequestInput) => feedback({
      newSearches: input.candidates.length ? [] : [{ query: '救援词', purpose: '', basis: 'query', supportKeys: [] }],
      shouldStop: true,
    }));
    const result = await session({ planFirstRound: async () => plan, planFeedback }, async (query) => {
      searched.push(query);
      return { hits: query === '救援词' ? [hit('rescued')] : [] };
    }).run('找资料', 5);

    expect(planFeedback.mock.calls[0][0].candidates).toEqual([]);
    expect(searched).toEqual(['精确词', '宽锚点', '救援词']);
    expect(result.results.map((item) => item.id)).toEqual(['rescued']);
    expect(planFeedback.mock.calls.filter(([input]) => input.candidates.length === 0)).toHaveLength(1);
  });

  it('rescues weak candidates, consumes rescue only for a first-seen query, and never executes evidence expansion without support', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 1 as const })),
        newSearches: [
          { query: '精确词', purpose: '', basis: 'query', supportKeys: [] },
          { query: '弱信号救援', purpose: '', basis: 'query', supportKeys: [] },
          { query: '无支持证据词', purpose: '', basis: 'evidence', supportKeys: [] },
        ],
      }))
      .mockImplementation(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 1 as const })),
        newSearches: [{ query: '第二次救援', purpose: '', basis: 'query', supportKeys: [] }],
      }));
    await session({ planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }), planFeedback }, async (query) => {
      searched.push(query);
      return { hits: [hit(query)] };
    }).run('找资料', 4);

    expect(searched).toEqual(['精确词', '弱信号救援']);
    expect(searched).not.toContain('第二次救援');
    expect(searched).not.toContain('无支持证据词');
  });

  it('derives signal from all in-range candidates and can return from positive to weak after rejudgment', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: [{ key: input.candidates[0].key, grade: 2 }],
        newSearches: [{ query: '证据词', purpose: '', basis: 'evidence', supportKeys: [input.candidates[0].key] }],
      }))
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 0 as const })),
        newSearches: [{ query: '回退救援', purpose: '', basis: 'query', supportKeys: [] }],
      }))
      .mockResolvedValue(feedback());
    await session({ planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }), planFeedback }, async (query) => {
      searched.push(query);
      if (query === '精确词') return { hits: [hit('shared')] };
      if (query === '证据词') return { hits: [hit('shared', 'shared updated')] };
      return { hits: [] };
    }).run('找资料', 5);

    expect(searched).toContain('回退救援');
  });

  it('keeps an earlier positive candidate when the latest feedback batch is only weak', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: [{ key: input.candidates[0].key, grade: 2 }],
        newSearches: [{ query: '发现新候选', purpose: '', basis: 'evidence', supportKeys: [input.candidates[0].key] }],
      }))
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: [{ key: input.candidates[0].key, grade: 1 }],
        newSearches: [{ query: '不应执行救援', purpose: '', basis: 'query', supportKeys: [] }],
      }));
    await session({
      planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }),
      planFeedback,
    }, async (query) => {
      searched.push(query);
      return { hits: [hit(query === '精确词' ? 'earlier-positive' : 'latest-weak')] };
    }).run('找资料', 5);

    expect(planFeedback).toHaveBeenCalledTimes(2);
    const latestFeedbackInput = planFeedback.mock.calls[1][0] as FeedbackRequestInput;
    expect(latestFeedbackInput.candidates.map((candidate) => candidate.title)).toEqual(['latest-weak']);
    expect(searched).toEqual(['精确词', '发现新候选']);
  });

  it('does not repeat an identical failed rescue without new evidence', async () => {
    const planFeedback = vi.fn(async () => feedback({
      newSearches: [{ query: '精确词', purpose: '', basis: 'query', supportKeys: [] }],
      shouldStop: true,
    }));
    const search = vi.fn(async () => ({ hits: [] }));

    const result = await session({
      planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }),
      planFeedback,
    }, search).run('找资料', 5);

    expect(search).toHaveBeenCalledOnce();
    expect(planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('no_results');
  });

  it('documents empty-candidate rescue and local stop-gate semantics in the Feedback prompt', () => {
    const prompt = feedbackSystemPrompt({
      searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc',
    });
    expect(prompt).toContain('candidates 可以为空');
    expect(prompt).toContain('query 依据的救援检索词');
    expect(prompt).toContain('should_stop 只建议关闭后续扩展');
    expect(prompt).toContain('不会取消已入队首页或已知分页');
  });
});

describe('Issue #31 request reservation and stop gate', () => {
  it('reserves one of three requests after one anchor and one non-anchor, then spends it on rescue', async () => {
    const searched: string[] = [];
    const initial = { ...plan, searches: [...plan.searches, { query: '第三个首轮词', purpose: '', role: 'balanced' as const }] };
    const planFeedback = vi.fn(async (_input: FeedbackRequestInput) => feedback({
      newSearches: [{ query: '保留额度救援', purpose: '', basis: 'query', supportKeys: [] }],
      shouldStop: true,
    }));
    const result = await session({ planFirstRound: async () => initial, planFeedback }, async (query) => {
      searched.push(query);
      return { hits: [] };
    }).run('找资料', 3);

    expect(searched).toEqual(['精确词', '宽锚点', '保留额度救援']);
    expect(result.requestsMade).toBe(3);
  });

  it('releases the reservation on positive signal and preserves strict limits of one and two', async () => {
    const run = async (limit: number) => {
      const searched: string[] = [];
      const initial = { ...plan, searches: [...plan.searches, { query: '第三个首轮词', purpose: '', role: 'balanced' as const }] };
      const planFeedback = vi.fn(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
      }));
      const result = await session({ planFirstRound: async () => initial, planFeedback }, async (query) => {
        searched.push(query);
        return { hits: [hit(query)] };
      }).run('找资料', limit);
      return { searched, result };
    };

    expect((await run(3)).searched).toEqual(['精确词', '宽锚点', '第三个首轮词']);
    expect((await run(1)).result.requestsMade).toBe(1);
    expect((await run(2)).result.requestsMade).toBe(2);
  });

  it('queues legal searches before the stop gate and permanently closes only future expansion', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        newSearches: [{ query: '已入队首页', purpose: '', basis: 'evidence', supportKeys: [input.candidates[0].key] }],
        shouldStop: true,
      }))
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        shouldStop: true,
      }))
      .mockImplementation(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        newSearches: [{ query: '关闭后扩展', purpose: '', basis: 'evidence', supportKeys: [input.candidates[0].key] }],
        shouldStop: false,
      }));
    const result = await session({ planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }), planFeedback }, async (query, cursor) => {
      searched.push(`${query}:${cursor ?? 'first'}`);
      if (query === '精确词' && !cursor) return { hits: [hit('seed')], nextCursor: 'next' };
      if (query === '精确词' && cursor === 'next') return { hits: [hit('page-2')], nextCursor: 'last' };
      if (query === '精确词') return { hits: [hit('page-3')] };
      return { hits: [hit('queued')] };
    }).run('找资料', 10);

    expect(searched).toEqual(['精确词:first', '已入队首页:first', '精确词:next', '精确词:last']);
    expect(planFeedback).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe('model_stop');
    expect(result.statusText).toContain('已完成已知分页');
    expect(searched).not.toContain('关闭后扩展:first');
  });

  it('reports request limit, not model stop, when a known continuation remains', async () => {
    const result = await session({
      planFirstRound: async () => ({ ...plan, searches: [plan.searches[0]] }),
      planFeedback: async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        shouldStop: true,
      }),
    }, async (_query, cursor): Promise<SearchPage> => ({ hits: [hit(cursor ?? 'first')], nextCursor: cursor ? 'third' : 'second' }))
      .run('找资料', 2);

    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('部分结果');
  });
});
