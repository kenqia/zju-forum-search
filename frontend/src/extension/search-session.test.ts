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
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
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
        planFeedback: vi.fn(),
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
        planFeedback: vi.fn(),
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
        planFeedback: vi.fn(),
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
        planFeedback: vi.fn(),
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
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
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
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '足够' }),
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
      planFeedback: vi.fn(),
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
      planFeedback: vi.fn(),
    };
    await new SearchSession({ source, planner, sleep: async () => undefined }).run('高数', 60);
    expect(cursors).toEqual([undefined, '']);
  });
});

describe('retrieved candidate documents', () => {
  it('keeps every hit document for local ranking without changing displayed metadata', async () => {
    const source = {
      sourceId: 'example',
      capabilities: { searchSurface: 'fulltext' as const, querySyntax: 'plain-keyword' as const },
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
        planFeedback: async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
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
    const planFeedback = vi.fn(async () => ({ newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' }));
    const session = new SearchSession({
      source: {
        sourceId: 'example', capabilities: { searchSurface: 'fulltext', querySyntax: 'plain-keyword' },
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
    expect(planFeedback).toHaveBeenCalledWith({ query: '测试', round: 1,
      executedSearches: [{ query: '测试', hitCount: 1 }],
      newCandidates: [{ title: '', author: '公开作者', publishedAt: '2026-09-17', section: '公开板块', replyCount: 2 }],
    }, expect.any(AbortSignal));
  });
});

describe('source policy and search budget', () => {
  it('enforces the source hard cap and applies the request interval between calls', async () => {
    const waits: number[] = [];
    const search = vi.fn(async () => ({ hits: [], nextCursor: 'next' }));
    const result = await new SearchSession({
      source: { sourceId: 'example', capabilities: { searchSurface: 'mixed', querySyntax: 'plain-keyword' },
        ratePolicy: { maxSearchCalls: 2, minRequestIntervalMs: 7 }, search },
      planner: { planFirstRound: async () => initialPlan,
        planFeedback: vi.fn(), planBlindExpansion: vi.fn() },
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
      source: { sourceId: 'example', capabilities: { searchSurface: 'mixed', querySyntax: 'plain-keyword' },
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 }, search },
      planner: { planFirstRound: async () => ({ ...initialPlan,
          searches: Array.from({ length: 5 }, (_, index) => ({ query: `检索词-${index}`, purpose: '' })) }),
        planFeedback: vi.fn(), planBlindExpansion: vi.fn() },
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
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword' },
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
          count = input.newCandidates.length;
          return { newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' };
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
