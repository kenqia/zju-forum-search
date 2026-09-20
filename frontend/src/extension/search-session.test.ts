import { describe, expect, it, vi } from 'vitest';

import { SearchSession, SearchSessionError, stopReasonText, type SearchStopReason } from './search-session';
import type { ModelQueryPlan } from './types';


function asPageSource(searchTopics: (query: string, from: number, size: number, signal?: AbortSignal) => Promise<unknown[]>) {
  return {
    sourceId: 'cc98' as const,
    ratePolicy: { maxSearchCalls: 100, minRequestIntervalMs: 2000 },
    capabilities: { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'time-desc' as const },
    async search(query: string, cursor: string | undefined, signal?: AbortSignal) {
      const from = cursor ? Number.parseInt(cursor, 10) : 0;
      const items = (await searchTopics(query, from, 20, signal)) as Record<string, unknown>[];
      const hits = items.map((raw, index) => {
        const id = String(raw.id ?? `hit-${from + index}`);
        const title = String(raw.title ?? `主题 ${id}`);
        const candidate = {
          sourceId: 'cc98', id, title, titleOrigin: 'native' as const,
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

const continueFeedback = () => ({
  judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '',
});

describe('SearchSession', () => {
  it('runs breadth-first pages, feeds back metadata, and keeps fixed constraints', async () => {
    let firstFeedbackInput: unknown;
    const planner = {
      planFirstRound: vi.fn(async () => initialPlan),
      planFeedback: vi.fn()
        .mockImplementationOnce(async (input) => {
          firstFeedbackInput = input;
          return {
            judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
            newSearches: [{ query: '工科数学分析', purpose: '标题学到的叫法' }],
            learnedTerms: ['工科数学分析'],
            stopSuggestions: ['微积分'],
            shouldStop: false,
            reasoning: '继续',
          };
        })
        .mockImplementationOnce(async (input) => ({
          judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
          newSearches: [{ query: '无人使用的扩展词', purpose: '验证枯竭' }],
          learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '再试一次',
        })),
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
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    const result = await session.run('找高数资料', 60);

    expect(calls.slice(0, 3)).toEqual([
      ['高数', 0, 20],
      ['微积分', 0, 20],
      ['工科数学分析', 0, 20],
    ]);
    expect(calls[3]).toEqual(['高数', 20, 20]);
    expect(planner.planFeedback).toHaveBeenCalled();
    expect(firstFeedbackInput).toMatchObject({ candidates: expect.any(Array) });
    expect((firstFeedbackInput as { candidates: unknown[] }).candidates[0]).not.toHaveProperty('body');
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
      planFeedback: vi.fn(async () => continueFeedback()),
      planBlindExpansion: vi.fn(async () => ({ ...initialPlan, searches: [{ query: '宽泛词', purpose: '' }] })),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async () => [])),
      sleep: async () => undefined,
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
      planFeedback: vi.fn(async () => continueFeedback()),
      planBlindExpansion: vi.fn(),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async (_query, from) => Array.from({ length: 20 }, (_, i) => ({ id: `${from}-${i}`, title: '高数' })))),
      sleep: async () => undefined,
    });

    const result = await session.run('高数', 30);

    expect(result.requestsMade).toBe(30);
    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('30 次');
  });

  it('waits two seconds between sequential requests and respects model stop', async () => {
    const sleeps: number[] = [];
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => initialPlan,
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async (query) => [{ id: query, title: query }])),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
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
        planFeedback: vi.fn(async () => continueFeedback()),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(searchTopics),
      sleep: async () => { session.stop(); },
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
        planFeedback: vi.fn(async () => continueFeedback()),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn()),
    });

    const running = session.run('高数', 60);
    session.stop();
    const result = await running;

    expect(planningSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe('user_stopped');
  });

  it('stops at the request limit before requesting another full page', async () => {
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] }),
        planFeedback: vi.fn(async () => continueFeedback()),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: '高数' })))),
      sleep: async () => undefined,
    });

    const result = await session.run('高数', 1);

    expect(result.requestsMade).toBe(1);
    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('1 次');
  });

  it('counts pagination requests toward the same run limit', async () => {
    const calls: Array<[string, number]> = [];
    const searchTopics = vi.fn(async (query: string, from: number) => {
      calls.push([query, from]);
      return Array.from({ length: 20 }, (_, index) => ({ id: `${query}-${from}-${index}`, title: '高数' }));
    });
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] }),
        planFeedback: vi.fn(async () => continueFeedback()),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(searchTopics),
      sleep: async () => undefined,
    });

    const result = await session.run('高数资料', 3);

    expect(result.stopReason).toBe('request_limit');
    expect(result.requestsMade).toBe(3);
    expect(calls).toEqual([['高数', 0], ['高数', 20], ['高数', 40]]);
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
          feedbackCandidates = input.candidates;
          return { judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' };
        },
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => [
        { id: 'recent', title: '微积分期末资料', time: '2025-01-01' },
        { id: 'old', title: '微积分期末资料', time: '2012-01-01' },
      ])),
      sleep: async () => undefined,
    });

    const result = await session.run('近三年的微积分期末资料', 60);

    expect(result.results.map((topic) => topic.id)).toEqual(['recent']);
    expect(result.outOfRangeCount).toBe(1);
    expect(feedbackCandidates).toMatchObject([{ title: '微积分期末资料', publishedAt: '2025-01-01' }]);
    expect(feedbackCandidates).toHaveLength(1);
    expect(feedbackCandidates[0]).not.toHaveProperty('id');
  });

  it('keeps topics from every year when the query has no explicit time request', async () => {
    const untimedPlan = { ...initialPlan, timeConstraint: { expression: '', startDate: null, endDate: null } };
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => untimedPlan,
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(vi.fn(async () => [
        { id: 'recent', title: '微积分资料', time: '2025-01-01' },
        { id: 'old', title: '微积分资料', time: '2012-01-01' },
      ])),
      sleep: async () => undefined,
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
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
        planBlindExpansion: vi.fn(),
      },
      source: asPageSource(searchTopics),
      sleep: async () => undefined,
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
      planFeedback: vi.fn(async () => continueFeedback()),
      planBlindExpansion: vi.fn(async () => ({ ...timedPlan, searches: [{ query: '微积分试卷', purpose: '' }] })),
    };
    const session = new SearchSession({
      planner,
      source: asPageSource(vi.fn(async () => [{ id: 'old', title: '微积分资料', time: '2012-01-01' }])),
      sleep: async () => undefined,
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
      'model_stop', 'no_new_candidates', 'no_new_searches', 'no_results',
      'request_limit', 'user_stopped', 'replaced', 'not_logged_in', 'rate_limited', 'model_timeout', 'failed',
    ];

    for (const reason of reasons) expect(stopReasonText(reason)).toMatch(/[\u3400-\u9fff]/u);
  });
});


describe('opaque source pagination', () => {
  it('follows an empty-string cursor until the source returns undefined', async () => {
    const source = asPageSource(async () => []);
    const cursors: (string | undefined)[] = [];
    source.search = async (_query, cursor) => {
      cursors.push(cursor);
      return { hits: [], nextCursor: cursor === undefined ? '' : undefined };
    };
    const planner = {
      planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '高数', purpose: '' }] }),
      planBlindExpansion: async () => ({ ...initialPlan, searches: [] }),
      planFeedback: vi.fn(async () => continueFeedback()),
    };
    await new SearchSession({ source, planner, sleep: async () => undefined }).run('高数', 60);
    expect(cursors).toEqual([undefined, '']);
  });
});

describe('retrieved candidate documents', () => {
  it('keeps every hit document for local ranking without changing displayed metadata', async () => {
    const source = {
      sourceId: 'example',
      capabilities: { searchSurface: 'fulltext' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'other' as const },
      ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
      async search(query: string) {
        return { hits: ['complete', 'partial'].map((id) => ({
          candidate: { sourceId: 'example', id, title: '展示标题', titleOrigin: 'native' as const, url: `https://example.test/${id}` },
          document: { title: '排序证据', snippet: id === 'complete' && query === '第二词' ? 'beta' : 'alpha' },
          position: id === 'complete' ? 20 : 1,
        })) };
      },
    };
    const result = await new SearchSession({
      source,
      planner: {
        planFirstRound: async () => ({ ...initialPlan,
          searches: [{ query: '第一词', purpose: '' }, { query: '第二词', purpose: '' }],
          requiredConcepts: [{ name: 'A', expressions: ['alpha'] }, { name: 'B', expressions: ['beta'] }],
        }),
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: vi.fn(),
      },
      sleep: async () => undefined,
    }).run('测试', 60);
    expect(result.results.map((candidate) => candidate.id)).toEqual(['complete', 'partial']);
    expect(result.results[0]).toMatchObject({ title: '展示标题', firstRound: 1 });
    expect(result.results[0]).not.toHaveProperty('snippet');
    expect(result.results[0]).not.toHaveProperty('bestRank');
  });
});

describe('core feedback privacy', () => {
  it('keeps body-derived titles and snippets local while sending only approved metadata', async () => {
    const planFeedback = vi.fn(async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }));
    const session = new SearchSession({
      source: {
        sourceId: 'example', capabilities: { searchSurface: 'fulltext', querySyntax: 'plain-keyword', resultOrdering: 'other' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        search: async () => ({ hits: [{
          candidate: { sourceId: 'example', id: 'local-id', title: '正文派生的秘密标题', titleOrigin: 'body-derived' as const,
            url: 'https://example.test/private', author: '公开作者', publishedAt: '2026-09-17', section: '公开板块', replyCount: 2,
            body: '隐藏正文', credential: 'synthetic-secret',
          },
          document: { title: '另一段正文', snippet: '只能留在本地的片段' }, position: 1,
        }] }),
      },
      planner: { planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '测试', purpose: '' }] }),
        planFeedback, planBlindExpansion: vi.fn() },
    });
    const result = await session.run('测试', 60);
    expect(result.results[0].title).toBe('正文派生的秘密标题');
    expect(planFeedback).toHaveBeenCalledWith({ query: '测试',
      executedSearches: [{ query: '测试', hitCount: 1 }],
      candidates: [{ key: 'c0', matchedQueries: ['测试'], title: '', author: '公开作者', publishedAt: '2026-09-17', section: '公开板块', replyCount: 2 }],
    }, expect.any(AbortSignal));
  });
});

describe('source policy and search budget', () => {
  it('enforces the source hard cap and applies the request interval between calls', async () => {
    const waits: number[] = [];
    const search = vi.fn(async () => ({ hits: [], nextCursor: 'next' }));
    const result = await new SearchSession({
      source: { sourceId: 'example', capabilities: { searchSurface: 'mixed', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 2, minRequestIntervalMs: 7 }, search },
      planner: { planFirstRound: async () => initialPlan,
        planFeedback: vi.fn(async () => continueFeedback()), planBlindExpansion: vi.fn() },
      sleep: async (ms) => { waits.push(ms); },
    }).run('测试', 30);
    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('2 次');
    expect(search).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7]);
  });

  it('applies the user request limit below the source hard cap', async () => {
    const search = vi.fn(async () => ({ hits: [], nextCursor: 'next' }));
    const result = await new SearchSession({
      source: { sourceId: 'example', capabilities: { searchSurface: 'mixed', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      planner: { planFirstRound: async () => ({ ...initialPlan,
          searches: Array.from({ length: 5 }, (_, index) => ({ query: `检索词-${index}`, purpose: '' })) }),
        planFeedback: vi.fn(async () => continueFeedback()), planBlindExpansion: vi.fn() },
      sleep: async () => undefined,
    }).run('测试', 5);
    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('5 次');
    expect(search).toHaveBeenCalledTimes(5);
  });
});

describe('bounded feedback at the planner port', () => {
  it('limits UTF-8 metadata before it leaves core, not only before HTTP serialization', async () => {
    let received = '';
    let count = 0;
    const session = new SearchSession({
      source: {
        sourceId: 'example', ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        search: async () => ({ hits: Array.from({ length: 200 }, (_, index) => ({
          candidate: { sourceId: 'example', id: String(index), title: '中文'.repeat(100), titleOrigin: 'native' as const,
            author: '作者'.repeat(100), section: '板块'.repeat(100), url: 'https://example.test/' },
          document: { title: '中文' }, position: index + 1,
        })) }),
      },
      planner: {
        planFirstRound: async () => ({ ...initialPlan, searches: [{ query: '中文', purpose: '' }] }),
        planFeedback: async (input) => {
          received = JSON.stringify(input);
          count = input.candidates.length;
          return { judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' };
        },
        planBlindExpansion: vi.fn(),
      },
    });
    const result = await session.run('测试', 60);
    expect(result.results).toHaveLength(200);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(160);
    expect(new TextEncoder().encode(received).byteLength).toBeLessThanOrEqual(4000);
    expect(received).not.toContain('https://example.test/');
  });
});

describe('issue #22 pagination and early stop', () => {
  const timePlan: ModelQueryPlan = { ...initialPlan, searches: [{ query: '资料', purpose: '' }] };

  it('keeps tail results when a response returns more than 20 items', async () => {
    const search = vi.fn(async (_q: string, cursor: string | undefined) => {
      if (cursor !== undefined) return { hits: [] };
      const hits = Array.from({ length: 25 }, (_, index) => ({
        candidate: { sourceId: 'cc98', id: `t-${index}`, title: '资料', titleOrigin: 'native' as const, url: 'https://www.cc98.org/topic/1', publishedAt: '2026-01-01' },
        document: { title: '资料', publishedAt: '2026-01-01' }, position: index + 1,
      }));
      return { hits };
    });
    const session = new SearchSession({
      planner: { planFirstRound: async () => timePlan, planFeedback: vi.fn(async () => continueFeedback()), planBlindExpansion: vi.fn() },
      source: { sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      sleep: async () => undefined,
    });
    const result = await session.run('找资料', 30);
    expect(result.results).toHaveLength(25);
  });

  it('rejects a repeated cursor instead of looping forever', async () => {
    const search = vi.fn(async () => ({ hits: [{ candidate: { sourceId: 'cc98', id: 'a', title: 'x', titleOrigin: 'native' as const, url: 'u' }, document: { title: 'x' }, position: 1 }], nextCursor: 'same' }));
    const session = new SearchSession({
      planner: { planFirstRound: async () => timePlan, planFeedback: vi.fn(async () => continueFeedback()), planBlindExpansion: vi.fn() },
      source: { sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      sleep: async () => undefined,
    });
    const result = await session.run('找资料', 30);
    // 'same' repeats after the first page; without a guard it would page forever.
    expect(search.mock.calls.length).toBeLessThan(30);
    expect(result.stopReason).not.toBe('request_limit');
  });

  it('stops pagination early on a fully dated page already older than the start date', async () => {
    const search = vi.fn(async (_q: string, cursor: string | undefined) => ({
      hits: Array.from({ length: 20 }, (_, index) => ({
        candidate: { sourceId: 'cc98', id: `old-${cursor ?? '0'}-${index}`, title: '资料', titleOrigin: 'native' as const, url: 'u', publishedAt: '2020-01-01' },
        document: { title: '资料', publishedAt: '2020-01-01' }, position: index + 1,
      })),
      nextCursor: 'next',
    }));
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...timePlan, timeConstraint: { expression: '最近一个月', startDate: '2026-08-19', endDate: '2026-09-19' } }),
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: async () => ({ ...timePlan, searches: [{ query: '更宽检索词', purpose: '' }], timeConstraint: { expression: '最近一个月', startDate: '2026-08-19', endDate: '2026-09-19' } }),
      },
      source: { sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      sleep: async () => undefined,
    });
    const result = await session.run('最近一个月的资料', 30);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
    expect(result.stopReason).toBe('no_results');
  });

  it('uses a validated model start date for early stopping when local parsing does not apply', async () => {
    const search = vi.fn(async () => ({
      hits: [{
        candidate: { sourceId: 'cc98', id: 'old', title: '资料', titleOrigin: 'native' as const, url: 'u', publishedAt: '2024-12-31' },
        document: { title: '资料', publishedAt: '2024-12-31' }, position: 1,
      }],
      nextCursor: '20',
    }));
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...timePlan, timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' } }),
        planFeedback: vi.fn(async () => continueFeedback()), planBlindExpansion: vi.fn(),
      },
      source: { sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 100, minRequestIntervalMs: 0 }, search },
      sleep: async () => undefined,
    });

    await session.run('2025 年的资料', 100);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it('does not early-stop on mixed or unknown times, or on non-time-ordered sources', async () => {
    const page = (times: Array<string | undefined>) => ({
      hits: times.map((time, index) => ({
        candidate: { sourceId: 's', id: `m-${index}`, title: 'x', titleOrigin: 'native' as const, url: 'u', ...(time ? { publishedAt: time } : {}) },
        document: { title: 'x', ...(time ? { publishedAt: time } : {}) }, position: index + 1,
      })),
      nextCursor: 'next',
    });
    // Mixed: one hit lacks a date -> keep paging until request path ends naturally.
    const search = vi.fn()
      .mockResolvedValueOnce(page([...Array.from({ length: 19 }, () => '2020-01-01' as string | undefined), undefined]))
      .mockResolvedValue({ hits: [], nextCursor: undefined });
    const session = new SearchSession({
      planner: { planFirstRound: async () => timePlan, planFeedback: async () => continueFeedback(), planBlindExpansion: vi.fn() },
      source: { sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      sleep: async () => undefined,
    });
    await session.run('最近一个月的资料', 30);
    expect(search).toHaveBeenCalledTimes(2);

    // Duo-like source: same page data must not trigger the time shortcut.
    const duoSearch = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 20 }, () => '2020-01-01')))
      .mockResolvedValue({ hits: [], nextCursor: undefined });
    const duoSession = new SearchSession({
      planner: { planFirstRound: async () => timePlan, planFeedback: async () => continueFeedback(), planBlindExpansion: vi.fn() },
      source: { sourceId: 'duo', capabilities: { searchSurface: 'fulltext', querySyntax: 'plain-keyword', resultOrdering: 'other' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search: duoSearch },
      sleep: async () => undefined,
    });
    await duoSession.run('最近一个月的资料', 30);
    expect(duoSearch).toHaveBeenCalledTimes(2);
  });
});

describe('final intent screening', () => {
  const screenPlan: ModelQueryPlan = { ...initialPlan, searches: [{ query: '资料', purpose: '' }] };
  const hits = (count: number) => Array.from({ length: count }, (_, index) => ({
    candidate: { sourceId: 'cc98', id: `c-${index}`, title: index === 0 ? '无关广告' : `资料 ${index}`, titleOrigin: 'native' as const, url: 'u', author: 'a', publishedAt: '2026-01-01', section: 's', replyCount: 1 },
    document: { title: '资料', publishedAt: '2026-01-01' }, position: index + 1,
  }));
  const makeSource = (count = 3) => ({
    sourceId: 'cc98' as const,
    capabilities: { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'time-desc' as const },
    ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
    search: vi.fn(async () => ({ hits: hits(count), nextCursor: undefined })),
  });
  const makePlanner = (screenResults?: (input: { candidates: { key: string }[] }) => Promise<{ removeKeys: string[] }>) => ({
    planFirstRound: async () => screenPlan,
    planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
    planBlindExpansion: vi.fn(),
    ...(screenResults ? { screenResults } : {}),
  });

  it('removes only model-named results and preserves ranking order', async () => {
    const session = new SearchSession({
      planner: makePlanner(async () => ({ removeKeys: ['r0', 'unknown-key'] })),
      source: makeSource(), sleep: async () => undefined,
    });
    const result = await session.run('资料', 30);
    expect(result.screening).toBe('done');
    expect(result.statusText).toContain('模型判断已有足够结果');
    expect(result.statusText).toContain('意图筛选完成，移除了 1 条结果');
    expect(result.results.map((r) => r.id)).toEqual(['c-1', 'c-2']);
  });

  it('splits into multiple batches and merges removal keys atomically', async () => {
    const seen: string[] = [];
    const statuses: string[] = [];
    const session = new SearchSession({
      planner: makePlanner(async (input) => {
        seen.push(...input.candidates.map((c) => c.key));
        return { removeKeys: input.candidates.length ? [input.candidates[0].key] : [] };
      }),
      source: makeSource(200), sleep: async () => undefined,
      onUpdate: (snapshot) => { if (snapshot.screening === 'running') statuses.push(snapshot.statusText); },
    });
    const result = await session.run('资料', 30);
    expect(result.results.length).toBeLessThan(200);
    expect(result.results.length).toBeGreaterThan(190);
    expect(new Set(seen).size).toBe(200);
    expect(statuses[0]).toMatch(/共 \d+ 批/u);
    expect(statuses.some((status) => /^已完成 1\/\d+ 批候选筛选/u.test(status))).toBe(true);
    const finalProgress = statuses.at(-1)?.match(/^已完成 (\d+)\/(\d+) 批候选筛选/u);
    expect(finalProgress?.[1]).toBe(finalProgress?.[2]);
  });

  it('keeps the full pre-screening list when any batch fails', async () => {
    let calls = 0;
    const session = new SearchSession({
      planner: makePlanner(async () => { calls += 1; if (calls === 2) throw new Error('bad'); return { removeKeys: ['r0'] }; }),
      source: makeSource(200), sleep: async () => undefined,
    });
    const result = await session.run('资料', 30);
    expect(result.screening).toBe('failed');
    expect(result.statusText).toContain('模型判断已有足够结果');
    expect(result.statusText).toContain('意图筛选未完成，已保留筛选前结果');
    expect(result.results).toHaveLength(200);
  });

  it('keeps the request-limit reason visible after successful screening', async () => {
    const session = new SearchSession({
      planner: makePlanner(async () => ({ removeKeys: [] })),
      source: {
        ...makeSource(1),
        search: vi.fn(async () => ({ hits: hits(1), nextCursor: '20' })),
      },
      sleep: async () => undefined,
    });

    const result = await session.run('资料', 1);

    expect(result.stopReason).toBe('request_limit');
    expect(result.statusText).toContain('1 次站点检索请求上限');
    expect(result.statusText).toContain('意图筛选完成');
  });

  it('screens every recalled candidate, including results hidden by local time filtering', async () => {
    const seen: string[] = [];
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...screenPlan, timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' } }),
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: vi.fn(),
        screenResults: async (input) => { seen.push(...input.candidates.map((candidate) => candidate.key)); return { removeKeys: [] }; },
      },
      source: {
        ...makeSource(),
        search: vi.fn(async () => ({ hits: [
          { candidate: { sourceId: 'cc98', id: 'in-range', title: '资料', titleOrigin: 'native' as const, url: 'u', publishedAt: '2025-06-01' }, document: { title: '资料', publishedAt: '2025-06-01' } },
          { candidate: { sourceId: 'cc98', id: 'out-of-range', title: '旧资料', titleOrigin: 'native' as const, url: 'u', publishedAt: '2024-06-01' }, document: { title: '旧资料', publishedAt: '2024-06-01' } },
        ] })),
      },
      sleep: async () => undefined,
    });

    const result = await session.run('2025 年的资料', 30);

    expect(seen).toEqual(['r0', 'r1']);
    expect(result.results.map((candidate) => candidate.id)).toEqual(['in-range']);
  });

  it('skips screening when disabled and on replaced runs', async () => {
    const screen = vi.fn(async () => ({ removeKeys: ['r0'] }));
    const disabled = new SearchSession({
      planner: makePlanner(screen), source: makeSource(), sleep: async () => undefined,
      intentFilterEnabled: false,
    });
    const result = await disabled.run('资料', 30);
    expect(screen).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(3);

    const enabled = new SearchSession({
      planner: makePlanner(screen), source: makeSource(), sleep: async () => undefined,
    });
    const run = enabled.run('资料', 30);
    enabled.stop('replaced');
    const replaced = await run;
    expect(replaced.stopReason).toBe('replaced');
  });

  it('sends only whitelisted metadata to the screening model', async () => {
    let payload: unknown;
    const session = new SearchSession({
      planner: {
        ...makePlanner(),
        screenResults: async (input) => { payload = input; return { removeKeys: [] }; },
      },
      source: {
        sourceId: 'duo' as const,
        capabilities: { searchSurface: 'fulltext' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'other' as const },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        search: async () => ({ hits: [{
          candidate: { sourceId: 'duo', id: 'secret-id', title: '正文派生标题', titleOrigin: 'body-derived' as const, url: 'https://duo/secret', author: '作者', publishedAt: '2026-01-01' },
          document: { title: '正文', snippet: '本地片段' }, position: 1,
        }] }),
      },
      sleep: async () => undefined,
    });
    await session.run('资料', 30);
    const text = JSON.stringify(payload);
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('正文派生标题');
    expect(text).not.toContain('https://duo/secret');
    expect(text).not.toContain('本地片段');
  });
});

describe('screening cancellation boundaries', () => {
  const plan: ModelQueryPlan = { ...initialPlan, searches: [{ query: '资料', purpose: '' }] };
  const oneHit = [{
    candidate: { sourceId: 'cc98', id: 'c-0', title: '资料', titleOrigin: 'native' as const, url: 'u', publishedAt: '2026-01-01' },
    document: { title: '资料', publishedAt: '2026-01-01' }, position: 1,
  }];
  const source = {
    sourceId: 'cc98' as const,
    capabilities: { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'time-desc' as const },
    ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
    search: vi.fn(async () => ({ hits: oneHit, nextCursor: undefined })),
  };

  it('still screens candidates after the user stops the search', async () => {
    // user_stopped aborts the search controller; screening must use its own
    // signal so existing candidates still get screened.
    const screenResults = vi.fn(async () => ({ removeKeys: ['r0'] }));
    let session!: SearchSession;
    session = new SearchSession({
      planner: {
        planFirstRound: async () => plan,
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '' }),
        planBlindExpansion: vi.fn(),
        screenResults,
      },
      source: {
        ...source,
        search: vi.fn(async () => {
          // Stop inside the first page: the hit still merges, then the run
          // unwinds into finish('user_stopped') with one candidate present.
          session.stop('user_stopped');
          return { hits: oneHit, nextCursor: undefined };
        }),
      },
      sleep: async () => undefined,
    });
    const result = await session.run('资料', 30);
    expect(result.stopReason).toBe('user_stopped');
    expect(screenResults).toHaveBeenCalled();
    expect(result.screening).toBe('done');
    expect(result.results).toHaveLength(0);
  });

  it('cancels an in-flight screen when a new query replaces the run', async () => {
    let screenSignal: AbortSignal | undefined;
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => plan,
        planFeedback: async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: vi.fn(),
        screenResults: (_input: unknown, signal?: AbortSignal) => {
          screenSignal = signal;
          return new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')), { once: true }));
        },
      },
      source, sleep: async () => undefined,
    });
    const run = session.run('资料', 30);
    // Wait until screening starts, then replace.
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.stop('replaced');
    const result = await run;
    expect(result.stopReason).toBe('replaced');
    expect(screenSignal?.aborted).toBe(true);
  });
});
