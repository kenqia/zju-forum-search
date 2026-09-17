import { describe, expect, it, vi } from 'vitest';

import { SearchSession, SearchSessionError, stopReasonText, type SearchStopReason } from './search-session';
import type { ModelQueryPlan } from './types';


function asPageSource(searchTopics: (query: string, from: number, size: number, signal?: AbortSignal) => Promise<unknown[]>) {
  return {
    sourceId: 'cc98' as const,
    ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 2000 },
    capabilities: { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const },
    async search(query: string, cursor: string | undefined, signal?: AbortSignal) {
      const from = cursor ? Number.parseInt(cursor, 10) : 0;
      const items = (await searchTopics(query, from, 20, signal)) as Record<string, unknown>[];
      const hits = items.map((raw, index) => {
        const id = String(raw.id ?? `hit-${from + index}`);
        const title = String(raw.title ?? `主题 ${id}`);
        const candidate = {
          sourceId: 'cc98', id, title,
          url: String(raw.url ?? `https://www.cc98.org/topic/${id}`),
          ...(raw.userName ? { author: String(raw.userName) } : {}),
          ...(raw.time ? { publishedAt: String(raw.time) } : {}),
          ...(raw.boardName ? { section: String(raw.boardName) } : {}),
          ...(typeof raw.replyCount === 'number' ? { replyCount: raw.replyCount } : {}),
        };
        return { candidate, document: { ...candidate }, position: from + index + 1 };
      });
      return { hits, nextCursor: items.length === 20 ? String(from + 20) : undefined };
    },
  };
}

const initialPlan: ModelQueryPlan = {
  summary: '寻找高数资料',
  searches: [
    { query: '高数', purpose: '简称' },
    { query: '微积分', purpose: '同义词' },
  ],
  requiredConcepts: [{ name: '课程', expressions: ['高数', '微积分'] }],
  excludedTerms: ['求助'],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

describe('SearchSession', () => {
  it('runs breadth-first pages, feeds back metadata, and keeps fixed constraints', async () => {
    let firstFeedbackInput: unknown;
    const planner = {
      planFirstRound: vi.fn(async () => initialPlan),
      planFeedback: vi.fn()
        .mockImplementationOnce(async (input) => {
          firstFeedbackInput = input;
          return {
            newSearches: [{ query: '工科数学分析', purpose: '标题学到的叫法' }],
            learnedTerms: ['工科数学分析'],
            stopSuggestions: ['微积分'],
            shouldStop: false,
            reasoning: '继续',
          };
        })
        .mockResolvedValueOnce({
          newSearches: [{ query: '无人使用的扩展词', purpose: '验证枯竭' }],
          learnedTerms: [],
          stopSuggestions: [],
          shouldStop: false,
          reasoning: '再试一次',
        }),
      planBlindExpansion: vi.fn(),
    };
    const calls: Array<[string, number, number]> = [];
    const fullPage = Array.from({ length: 20 }, (_, index) => ({
      id: `a-${index}`,
      title: index === 0 ? '工科数学分析资料' : `高数资料 ${index}`,
      boardName: '学习天地',
      time: '2025-09-01',
      userName: 'alice',
      replyCount: index,
    }));
    const cc98 = {
      searchTopics: vi.fn(async (query: string, from: number, size: number) => {
        calls.push([query, from, size]);
        if (query === '高数' && from === 0) return fullPage;
        if (query === '高数' && from === 20) return [{ id: 'tail', title: '高数尾页' }];
        if (query === '工科数学分析') return [{ id: 'learned', title: '工科数学分析历年卷' }];
        return [];
      }),
    };
    const updates: unknown[] = [];
    const session = new SearchSession({
      planner,
      source: asPageSource(cc98.searchTopics),
      sleep: async () => undefined,
      now: (() => { let value = 0; return () => value++; })(),
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    const result = await session.run('找高数资料', 60);

    expect(calls.slice(0, 3)).toEqual([
      ['高数', 0, 20],
      ['微积分', 0, 20],
      ['高数', 20, 20],
    ]);
    expect(calls[3]).toEqual(['工科数学分析', 0, 20]);
    expect(planner.planFeedback).toHaveBeenCalled();
    expect(firstFeedbackInput).toMatchObject({ newCandidates: expect.any(Array) });
    expect((firstFeedbackInput as { newCandidates: unknown[] }).newCandidates[0]).not.toHaveProperty('body');
    expect(result.plan?.requiredConcepts).toEqual(initialPlan.requiredConcepts);
    expect(result.learnedTerms).toContain('工科数学分析');
    expect(result.executedSearches).toEqual(expect.arrayContaining(['高数', '微积分', '工科数学分析', '无人使用的扩展词']));
    expect(result.inactiveSearches).toContain('微积分');
    expect(result.stopReason).toBe('no_new_candidates');
    expect(updates.length).toBeGreaterThan(2);
  });

  it('performs one blind expansion after an empty first round', async () => {
    const planner = {
      planFirstRound: vi.fn(async () => ({ ...initialPlan, searches: [{ query: '零命中', purpose: '' }] })),
      planFeedback: vi.fn(),
      planBlindExpansion: vi.fn(async () => ({ ...initialPlan, searches: [{ query: '宽泛词', purpose: '' }] })),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async () => [])),
      sleep: async () => undefined,
      now: (() => { let value = 0; return () => value++; })(),
    });

    const result = await session.run('一个找不到的主题', 60);

    expect(planner.planBlindExpansion).toHaveBeenCalledOnce();
    expect(planner.planFeedback).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('no_results');
    expect(result.statusText).toBe('没有找到主题帖。');
  });

  it('enforces the hard request cap', async () => {
    const planner = {
      planFirstRound: vi.fn(async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] })),
      planFeedback: vi.fn(),
      planBlindExpansion: vi.fn(),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async (_query, from) => Array.from({ length: 20 }, (_, i) => ({ id: `${from}-${i}`, title: '高数' })))),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('高数', 60);

    expect(result.requestsMade).toBe(30);
    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('30 次');
  });

  it('waits two seconds between sequential requests and respects model stop', async () => {
    const sleeps: number[] = [];
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => initialPlan,
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async (query) => [{ id: query, title: query }])),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      now: () => 0,
    });

    const result = await session.run('高数', 60);

    expect(sleeps).toEqual([2000]);
    expect(result.stopReason).toBe('model_stop');
    expect(result.statusText).toBe('模型判断已有足够结果，搜索已停止。');
  });

  it('does not issue another request when the user stops during the interval', async () => {
    const searchTopics = vi.fn(async (query) => [{ id: query, title: query }]);
    let session: SearchSession;
    session = new SearchSession({
      planner: {
        planFirstRound: async () => initialPlan,
        planFeedback: vi.fn(),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(searchTopics),
      sleep: async () => { session.stop(); },
      now: () => 0,
    });

    const result = await session.run('高数', 60);

    expect(searchTopics).toHaveBeenCalledOnce();
    expect(result.results).toHaveLength(1);
    expect(result.stopReason).toBe('user_stopped');
  });

  it('finishes promptly when stopped during model planning', async () => {
    let planningSignal: AbortSignal | undefined;
    const session = new SearchSession({
      planner: {
        planFirstRound: (_query, signal) => {
          planningSignal = signal;
          return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
        },
        planFeedback: vi.fn(),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn()),
      now: () => 0,
    });

    const running = session.run('高数', 60);
    session.stop();
    const result = await running;

    expect(planningSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe('user_stopped');
  });

  it('stops at the time budget before requesting another full page', async () => {
    let clockReads = 0;
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] }),
        planFeedback: vi.fn(),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: '高数' })))),
      sleep: async () => undefined,
      now: () => (++clockReads <= 3 ? 0 : 1000),
    });

    const result = await session.run('高数', 1);

    expect(result.requestsMade).toBe(1);
    expect(result.stopReason).toBe('budget_exhausted');
  });

  it('does not charge model planning time against the CC98 search budget', async () => {
    let clock = 0;
    const searchTopics = vi.fn(async () => []);
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => {
          clock += 60_000;
          return { ...initialPlan, searches: [{ query: '高数', purpose: '' }] };
        },
        planFeedback: vi.fn(),
        planBlindExpansion: vi.fn(async () => {
          clock += 60_000;
          return { ...initialPlan, searches: [{ query: '微积分', purpose: '' }] };
        }),
      },
      source: asPageSource(searchTopics),
      sleep: async () => undefined,
      now: () => clock,
    });

    await session.run('近三年的高数资料', 10);

    expect(searchTopics).toHaveBeenCalled();
  });

  it('keeps partial results and identifies a feedback model timeout', async () => {
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] }),
        planFeedback: async () => {
          throw new SearchSessionError('反馈模型调用超过 20 秒，已保留当前结果。', 'model_timeout');
        },
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => [{ id: 'kept', title: '高数资料' }])),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('高数资料', 60);

    expect(result.stopReason).toBe('model_timeout');
    expect(result.statusText).toBe('反馈模型调用超过 20 秒，已保留当前结果。');
    expect(result.results.map((topic) => topic.id)).toEqual(['kept']);
  });

  it('excludes out-of-range topics and feedback evidence for an explicit time request', async () => {
    let feedbackCandidates: unknown[] = [];
    const timedPlan: ModelQueryPlan = {
      ...initialPlan,
      searches: [{ query: '微积分', purpose: '' }],
      timeConstraint: { expression: '近三年', startDate: '2023-09-15', endDate: '2026-09-15' },
    };
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => timedPlan,
        planFeedback: async (input) => {
          feedbackCandidates = input.newCandidates;
          return { newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' };
        },
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => [
        { id: 'recent', title: '微积分期末资料', time: '2025-01-01' },
        { id: 'old', title: '微积分期末资料', time: '2012-01-01' },
      ])),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('近三年的微积分期末资料', 60);

    expect(result.results.map((topic) => topic.id)).toEqual(['recent']);
    expect(result.outOfRangeCount).toBe(1);
    expect(feedbackCandidates).toMatchObject([{ id: 'recent' }]);
  });

  it('keeps topics from every year when the query has no explicit time request', async () => {
    const untimedPlan = { ...initialPlan, timeConstraint: { expression: '', startDate: null, endDate: null } };
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => untimedPlan,
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => [
        { id: 'recent', title: '微积分资料', time: '2025-01-01' },
        { id: 'old', title: '微积分资料', time: '2012-01-01' },
      ])),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('微积分资料', 60);

    expect(result.results.map((topic) => topic.id)).toEqual(['recent', 'old']);
    expect(result.outOfRangeCount).toBe(0);
  });

  it('continues CC98 search and preserves the original-query fallback notice', async () => {
    const searchTopics = vi.fn(async () => [{ id: 'calculus', title: '微积分资料' }]);
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({
          ...initialPlan,
          summary: '直接搜索原词：微积分',
          searches: [{ query: '微积分', purpose: '模型计划无效，直接使用用户原词' }],
          usedOriginalQueryFallback: true,
        }),
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(searchTopics),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('微积分', 60);

    expect(searchTopics).toHaveBeenCalledWith('微积分', 0, 20, expect.any(AbortSignal));
    expect(result.planningNotice).toBe('模型计划无效，已直接搜索原词。');
    expect(result.results.map((topic) => topic.id)).toEqual(['calculus']);
  });

  it('treats an all-out-of-range first round as empty and performs one blind expansion', async () => {
    const timedPlan: ModelQueryPlan = {
      ...initialPlan,
      searches: [{ query: '微积分', purpose: '' }],
      timeConstraint: { expression: '近三年', startDate: '2023-09-15', endDate: '2026-09-15' },
    };
    const planner = {
      planFirstRound: vi.fn(async () => timedPlan),
      planFeedback: vi.fn(),
      planBlindExpansion: vi.fn(async () => ({ ...timedPlan, searches: [{ query: '微积分试卷', purpose: '' }] })),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async () => [{ id: 'old', title: '微积分资料', time: '2012-01-01' }])),
      sleep: async () => undefined,
      now: () => 0,
    });

    const result = await session.run('近三年的微积分期末资料', 60);

    expect(planner.planBlindExpansion).toHaveBeenCalledOnce();
    expect(planner.planFeedback).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('no_results');
    expect(result.results).toEqual([]);
    expect(result.outOfRangeCount).toBe(1);
  });

  it('exposes a Chinese status for every bounded stop condition', () => {
    const reasons: SearchStopReason[] = [
      'model_stop', 'no_new_candidates', 'no_new_searches', 'no_results', 'budget_exhausted',
      'request_limit', 'user_stopped', 'replaced', 'not_logged_in', 'rate_limited', 'model_timeout', 'failed',
    ];

    for (const reason of reasons) expect(stopReasonText(reason)).toMatch(/[\u3400-\u9fff]/u);
  });
});
