import { describe, expect, it, vi } from 'vitest';

import { buildFeedbackPayload, createFeedbackInput } from './feedback-payload';
import { selectFeedbackEvidence } from './feedback-evidence';
import { PlannerClient } from './planner';
import { mergeHits } from './retrieval';
import { SearchSession, SearchSessionError } from './search-session';
import { DEFAULT_SETTINGS, type Candidate, type FeedbackRequestInput, type ModelQueryPlan, type RetrievedCandidate, type SearchHit } from './types';

const plan: ModelQueryPlan = {
  summary: '资料',
  searches: [{ query: '首词', purpose: '' }],
  requiredConcepts: [],
  excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string, title = `主题 ${id}`, position = 1): SearchHit {
  const candidate: Candidate = {
    sourceId: 'cc98', id, title, titleOrigin: 'native', url: `https://www.cc98.org/topic/${id}`,
    author: 'alice', publishedAt: '2026-09-20', section: '学习天地', replyCount: 3,
  };
  return { candidate, document: { ...candidate, snippet: '不得进入模型' }, position };
}

describe('issue #25 retrieval waves', () => {
  it('feeds back after every initial query has one page, then prioritizes a new query without starving pagination', async () => {
    const calls: string[] = [];
    const feedbackCalls: FeedbackRequestInput[] = [];
    const source = {
      sourceId: 'cc98',
      ratePolicy: { maxSearchCalls: 20, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (query: string, cursor?: string) => {
        calls.push(`${query}:${cursor ?? 'first'}`);
        if (!cursor) return { hits: Array.from({ length: 20 }, (_, index) => hit(`${query}-${index}`, query, index + 1)), nextCursor: 'page-2' };
        return { hits: [hit(`${query}-tail`, `${query} 尾页`, 21)] };
      }),
    };
    const planner = {
      planFirstRound: async () => ({ ...plan, searches: [{ query: '首词', purpose: '' }, { query: '次词', purpose: '' }] }),
      planBlindExpansion: vi.fn(),
      planFeedback: vi.fn(async (input: FeedbackRequestInput) => {
        feedbackCalls.push(input);
        if (feedbackCalls.length === 1) {
          expect(calls).toEqual(['首词:first', '次词:first']);
          return { judgments: [{ key: input.candidates![0].key, grade: 2 as const }], newSearches: [{ query: '新词', purpose: '' }], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '' };
        }
        return { judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '' };
      }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, intentFilterEnabled: false }).run('资料', 20, 30);

    expect(calls.slice(0, 5)).toEqual(['首词:first', '次词:first', '新词:first', '首词:page-2', '次词:page-2']);
    expect(feedbackCalls[0].candidates).toHaveLength(8);
    expect(result.stopReason).toBe('model_stop');
  });

  it('soft-isolates grade 0, then rejudges and restores it after a different query supplies independent evidence', async () => {
    const snapshots: ReturnType<SearchSession['run']> extends Promise<infer Snapshot> ? Snapshot[] : never = [];
    const inputs: FeedbackRequestInput[] = [];
    let sharedKey = '';
    const source = {
      sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (query: string, cursor?: string) => {
        if (query === '首词' && !cursor) return { hits: Array.from({ length: 20 }, (_, index) => hit(index === 0 ? 'shared' : `a-${index}`, '共同候选', index + 1)), nextCursor: 'p2' };
        if (query === '新词') return { hits: [hit('shared', '共同候选', 1)] };
        return { hits: [] };
      }),
    };
    const planner = {
      planFirstRound: async () => plan,
      planBlindExpansion: vi.fn(),
      planFeedback: vi.fn(async (input: FeedbackRequestInput) => {
        inputs.push(input);
        const shared = sharedKey
          ? input.candidates!.find((candidate) => candidate.key === sharedKey)
          : input.candidates!.find((candidate) => candidate.title === '共同候选');
        if (shared && !sharedKey) sharedKey = shared.key;
        const positive = input.candidates!.find((candidate) => candidate.key !== shared?.key);
        if (inputs.length === 1) return {
          judgments: [...(shared ? [{ key: shared.key, grade: 0 as const }] : []), ...(positive ? [{ key: positive.key, grade: 2 as const }] : [])],
          newSearches: [{ query: '新词', purpose: '' }], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '',
        };
        return {
          judgments: shared ? [{ key: shared.key, grade: 2 as const }] : [],
          newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '',
        };
      }),
    };

    const result = await new SearchSession({
      planner, source, sleep: async () => undefined, intentFilterEnabled: false,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    }).run('资料', 10, 30);

    const firstShared = inputs[0].candidates!.find((candidate) => candidate.title === '共同候选')!;
    const secondShared = inputs[1].candidates!.find((candidate) => candidate.key === firstShared.key)!;
    expect(secondShared.key).toBe(firstShared.key);
    expect(secondShared.matchedQueries).toEqual(['首词', '新词']);
    expect(snapshots.some((snapshot) => snapshot.softIsolatedResults.some((candidate) => candidate.id === 'shared'))).toBe(true);
    expect(result.results.some((candidate) => candidate.id === 'shared')).toBe(true);
    expect(result.softIsolatedResults).toEqual([]);
  });

  it('does not call feedback again when only the position changes for the same query', async () => {
    const planner = {
      planFirstRound: async () => plan,
      planBlindExpansion: vi.fn(),
      planFeedback: vi.fn(async () => ({ judgments: [], newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '' })),
    };
    const source = {
      sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (_query: string, cursor?: string) => cursor
        ? { hits: [hit('same', '相同候选', 21)] }
        : { hits: [hit('same', '相同候选', 1)], nextCursor: 'p2' }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, intentFilterEnabled: false }).run('资料', 10, 30);

    expect(planner.planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('no_new_candidates');
  });

  it('rejudges and restores the only candidate when later metadata changes after grade 0', async () => {
    const planner = {
      planFirstRound: async () => plan,
      planBlindExpansion: vi.fn(),
      planFeedback: vi.fn()
        .mockImplementationOnce(async (input: FeedbackRequestInput) => ({
          judgments: [{ key: input.candidates[0].key, grade: 0 as const }],
          newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '',
        }))
        .mockImplementationOnce(async (input: FeedbackRequestInput) => ({
          judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
          newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: true, reasoning: '',
        })),
    };
    const source = {
      sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (_query: string, cursor?: string) => cursor
        ? { hits: [hit('only', '更新后的标题', 2)] }
        : { hits: [hit('only', '原始标题', 1)], nextCursor: 'p2' }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, intentFilterEnabled: false }).run('资料', 10, 30);

    expect(planner.planFeedback).toHaveBeenCalledTimes(2);
    expect(result.results.map((candidate) => candidate.id)).toEqual(['only']);
    expect(result.softIsolatedResults).toEqual([]);
  });

  it('completes feedback after a full wave even when that wave reaches the site request limit', async () => {
    const planFeedback = vi.fn(async (input: FeedbackRequestInput) => ({
      judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
      newSearches: [], learnedTerms: [], stopSuggestions: [], shouldStop: false, reasoning: '',
    }));
    const result = await new SearchSession({
      planner: { planFirstRound: async () => plan, planBlindExpansion: vi.fn(), planFeedback },
      source: {
        sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
        search: async () => ({ hits: [hit('one')] }),
      },
      sleep: async () => undefined, intentFilterEnabled: false,
    }).run('资料', 1, 30);

    expect(planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('request_limit');
  });

  it('stops on feedback failure, keeps active results, and does not call the final model stage', async () => {
    const screenResults = vi.fn(async () => ({ removeKeys: [] }));
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => plan,
        planBlindExpansion: vi.fn(),
        planFeedback: async () => { throw new SearchSessionError('反馈模型调用超过 20 秒，已保留当前结果。', 'model_timeout'); },
        screenResults,
      },
      source: {
        sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
        search: async () => ({ hits: [hit('kept')] }),
      },
      sleep: async () => undefined,
    });

    const result = await session.run('资料', 10, 30);

    expect(result.results.map((candidate) => candidate.id)).toEqual(['kept']);
    expect(result.stopReason).toBe('model_timeout');
    expect(screenResults).not.toHaveBeenCalled();
  });
});

describe('issue #25 feedback protocol', () => {
  it('selects every higher-priority candidate first and caps each evidence query at four', () => {
    const entry = (id: string, query: string, patch: Partial<RetrievedCandidate> = {}): RetrievedCandidate => ({
      candidate: hit(id).candidate,
      observations: [{ query, round: 1 }], documents: [{ title: id }], temporaryKey: `k-${id}`,
      evidenceRevision: 2, judgedEvidenceRevision: 1, latestIndependentQuery: query,
      ...patch,
    });
    const entries = [
      entry('judged-a', '宽泛词', { relevanceGrade: 2 }),
      entry('zero-a', '宽泛词', { relevanceGrade: 0 }),
      entry('new-a', '宽泛词', { relevanceGrade: undefined, judgedEvidenceRevision: 0 }),
      entry('new-b', '精确词', { relevanceGrade: undefined, judgedEvidenceRevision: 0 }),
      entry('new-c', '宽泛词', { relevanceGrade: undefined, judgedEvidenceRevision: 0 }),
      entry('new-d', '宽泛词', { relevanceGrade: undefined, judgedEvidenceRevision: 0 }),
      entry('new-e', '宽泛词', { relevanceGrade: undefined, judgedEvidenceRevision: 0 }),
    ];

    const selected = selectFeedbackEvidence(entries, entries.map((candidate) => candidate.candidate.id), 10);

    expect(selected.entries.slice(0, 5).every((candidate) => candidate.relevanceGrade === undefined)).toBe(true);
    expect(selected.entries.filter((candidate) => candidate.latestIndependentQuery === '宽泛词')).toHaveLength(4);
    expect(selected.entries.map((candidate) => candidate.candidate.id)).not.toContain('judged-a');
  });

  it('treats visible metadata changes, but not same-query position changes, as independent evidence', () => {
    const candidates = new Map<string, RetrievedCandidate>();
    let sequence = 0;
    mergeHits(candidates, [hit('same', '原始标题', 1)], '检索词', 1, () => `c${sequence++}`);
    const first = candidates.get('same')!;
    expect(first.evidenceRevision).toBe(1);

    mergeHits(candidates, [hit('same', '原始标题', 20)], '检索词', 2, () => `c${sequence++}`);
    expect(first.evidenceRevision).toBe(1);

    mergeHits(candidates, [hit('same', '更新标题', 21)], '检索词', 3, () => `c${sequence++}`);
    expect(first.evidenceRevision).toBe(2);
    expect(first.temporaryKey).toBe('c0');
  });

  it('normalizes judgments conservatively and keeps the last legal duplicate', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      judgments: [
        { key: 'c0', grade: 0 }, { key: 'unknown', grade: 3 }, { key: 'c0', grade: 9 }, { key: 'c0', grade: 2 }, { key: 'c1', grade: '3' },
      ],
      new_searches: [], should_stop: true,
    }) }, DEFAULT_SETTINGS, { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' });

    await expect(client.planFeedback({
      query: '资料', executedSearches: [],
      candidates: [{ key: 'c0', title: '候选', matchedQueries: ['首词'] }],
    })).resolves.toMatchObject({ judgments: [{ key: 'c0', grade: 2 }], shouldStop: true });
  });

  it('enforces both privacy whitelists and the complete 4000-byte limit', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      key: `c${index}`, title: `主题${'很长'.repeat(80)}`, matchedQueries: ['首词', '次词', '第三词', '第四词'],
      author: '作者', publishedAt: '2026-09-20', section: '学习天地', replyCount: index,
      sourceId: 'secret-source', id: `secret-${index}`, url: 'https://secret.test', position: 1, round: 1,
      snippet: '片段', body: '正文', replies: ['回帖'], authorization: 'secret',
    }));
    const core = createFeedbackInput({ query: '资料', executedSearches: [{ query: '首词', hitCount: 100 }], candidates } as never);
    const payload = buildFeedbackPayload(core, '2026-09-20');
    const json = JSON.stringify(payload);

    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(4000);
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty('round');
    expect(payload.candidates[0].matched_queries).toEqual(['次词', '第三词', '第四词']);
    for (const forbidden of ['secret-source', 'secret-', 'https://secret.test', '片段', '正文', '回帖', 'authorization']) {
      expect(json).not.toContain(forbidden);
    }
  });
});
