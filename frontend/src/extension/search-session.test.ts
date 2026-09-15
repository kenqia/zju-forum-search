import { describe, expect, it, vi } from 'vitest';

import { SearchSession, stopReasonText, type SearchStopReason } from './search-session';
import type { ModelQueryPlan } from './types';

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
      cc98,
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
      cc98: { searchTopics: vi.fn(async () => []) },
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
      cc98: { searchTopics: vi.fn(async (_query, from) => Array.from({ length: 20 }, (_, i) => ({ id: `${from}-${i}`, title: '高数' }))) },
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
      cc98: { searchTopics: vi.fn(async (query) => [{ id: query, title: query }]) },
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
      cc98: { searchTopics },
      sleep: async () => { session.stop(); },
      now: () => 0,
    });

    const result = await session.run('高数', 60);

    expect(searchTopics).toHaveBeenCalledOnce();
    expect(result.results).toHaveLength(1);
    expect(result.stopReason).toBe('user_stopped');
  });

  it('exposes a Chinese status for every bounded stop condition', () => {
    const reasons: SearchStopReason[] = [
      'model_stop', 'no_new_candidates', 'no_new_searches', 'no_results', 'budget_exhausted',
      'request_limit', 'user_stopped', 'replaced', 'not_logged_in', 'cc98_limited', 'failed',
    ];

    for (const reason of reasons) expect(stopReasonText(reason)).toMatch(/[\u3400-\u9fff]/u);
  });
});
