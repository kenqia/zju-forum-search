import { describe, expect, it, vi } from 'vitest';

import { feedbackSystemPrompt, PlannerClient } from './planner';
import { createBackgroundPlanner } from './content';
import { SearchSession } from './search-session';
import { DEFAULT_SETTINGS, type FeedbackPlan, type FeedbackRequestInput, type ModelQueryPlan, type SearchHit, type SearchSourceSession } from './types';

const capabilities = { searchSurface: 'title' as const, querySyntax: 'plain-keyword' as const, resultOrdering: 'other' as const };
const plan: ModelQueryPlan = {
  summary: '资料', searches: [{ query: '原词', purpose: '', role: 'balanced' }],
  requiredConcepts: [], excludedTerms: [], timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string): SearchHit {
  return { candidate: { sourceId: 'test', id, title: id, titleOrigin: 'native', url: `https://example.test/${id}` }, document: { title: id } };
}

function source(search: SearchSourceSession['search']): SearchSourceSession {
  return { sourceId: 'test', capabilities, ratePolicy: { maxSearchCalls: 20, minRequestIntervalMs: 0 }, search };
}

function feedback(overrides: Partial<FeedbackPlan> = {}): FeedbackPlan {
  return { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '', ...overrides };
}

describe('Issue #36 model search narrowing setting', () => {
  it('keeps the existing stop behavior enabled by default', async () => {
    const calls: string[] = [];
    const planFeedback = vi.fn().mockResolvedValue(feedback({
      judgments: [{ key: 'c0', grade: 2 }],
      stopQueries: [{ query: '原词', reason: '低收益' }],
      shouldStop: true,
    }));
    const result = await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: source(async (query) => { calls.push(query); return { hits: [hit('c0')], nextCursor: 'next' }; }),
      sleep: async () => undefined,
      finalRerankEnabled: false,
    }).run('资料', 10);

    expect(calls).toEqual(['原词']);
    expect(result.stopReason).toBe('model_stop');
  });

  it('ignores both stop signals while preserving valid expansion and pagination', async () => {
    const calls: string[] = [];
    const planFeedback = vi.fn()
      .mockImplementationOnce(async (input: FeedbackRequestInput) => feedback({
        judgments: input.candidates.map((candidate) => ({ key: candidate.key, grade: 2 as const })),
        newSearches: [{ query: '扩展词', purpose: '', basis: 'evidence', supportKeys: input.candidates.slice(0, 1).map((candidate) => candidate.key) }],
        stopQueries: [{ query: '原词', reason: '应被忽略' }],
        shouldStop: true,
      }))
      .mockResolvedValue(feedback({ shouldStop: true, stopQueries: [{ query: '扩展词', reason: '应被忽略' }] }));
    const result = await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: source(async (query, cursor) => {
        calls.push(`${query}:${cursor ?? 'first'}`);
        return cursor ? { hits: [hit(`${query}-page-2`)] } : { hits: [hit(`${query}-page-1`)], nextCursor: 'next' };
      }),
      sleep: async () => undefined,
      finalRerankEnabled: false,
      modelSearchNarrowingEnabled: false,
    }).run('资料', 10);

    expect(calls).toEqual(['原词:first', '扩展词:first', '原词:next', '扩展词:next']);
    expect(planFeedback).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe('no_new_candidates');
  });

  it('keeps request limits and user cancellation authoritative when disabled', async () => {
    let page = 0;
    const search = vi.fn(async () => ({ hits: [hit(`c${page}`)], nextCursor: `next-${page++}` }));
    const limited = await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback: async () => feedback({ shouldStop: true }) },
      source: source(search), sleep: async () => undefined, finalRerankEnabled: false, modelSearchNarrowingEnabled: false,
    }).run('资料', 2);
    expect(limited.stopReason).toBe('request_limit');
    expect(search).toHaveBeenCalledTimes(2);

    let session!: SearchSession;
    session = new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback: async () => { session.stop(); return feedback({ shouldStop: true }); } },
      source: source(async () => ({ hits: [hit('c0')], nextCursor: 'next' })), sleep: async () => undefined,
      finalRerankEnabled: false, modelSearchNarrowingEnabled: false,
    });
    await expect(session.run('资料', 10)).resolves.toMatchObject({ stopReason: 'user_stopped' });
  });

  it('does not force another feedback call after all tasks are exhausted', async () => {
    const planFeedback = vi.fn(async () => feedback({ shouldStop: true }));
    const result = await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: source(async () => ({ hits: [hit('only')] })),
      sleep: async () => undefined,
      finalRerankEnabled: false,
      modelSearchNarrowingEnabled: false,
    }).run('资料', 10);

    expect(planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('no_new_candidates');
  });

  it('uses the run snapshot for feedback prompt and scheduler behavior', () => {
    expect(feedbackSystemPrompt(capabilities, false)).toContain('should_stop: false');
    expect(feedbackSystemPrompt(capabilities, false)).toContain('stop_queries: []');
    const client = new PlannerClient({ chatCompletions: async (_settings, messages) => {
      expect(messages[0].content).toContain('should_stop: false');
      return JSON.stringify({ judgments: [], new_searches: [], stop_queries: [], should_stop: false, reasoning: '' });
    } }, { ...DEFAULT_SETTINGS, modelSearchNarrowingEnabled: false }, capabilities);
    return expect(client.planFeedback({ query: '资料', executedSearches: [], candidates: [] })).resolves.toBeTruthy();
  });

  it('sends a fixed narrowing snapshot through the background planner', async () => {
    const requests: unknown[] = [];
    const planner = createBackgroundPlanner({
      send: async (request) => {
        requests.push(request);
        return { ok: true, feedback: feedback() } as never;
      },
    }, capabilities, false);
    await planner.planFeedback({ query: '资料', executedSearches: [], candidates: [] });
    expect(requests[0]).toMatchObject({ modelSearchNarrowingEnabled: false });
  });
});
