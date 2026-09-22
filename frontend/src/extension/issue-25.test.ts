import { describe, expect, it, vi } from 'vitest';

import { buildFeedbackPayload, createFeedbackInput } from './feedback-payload';
import { applyFeedbackJudgments, selectFeedbackEvidence } from './feedback-evidence';
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
      planFeedback: vi.fn(async (input: FeedbackRequestInput) => {
        feedbackCalls.push(input);
        if (feedbackCalls.length === 1) {
          expect(calls).toEqual(['首词:first', '次词:first']);
          return { judgments: [{ key: input.candidates![0].key, grade: 2 as const }], newSearches: [{ query: '新词', purpose: '', basis: 'evidence' as const, supportKeys: [input.candidates![0].key] }], stopSuggestions: [], shouldStop: false, reasoning: '' };
        }
        return { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '' };
      }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, finalRerankEnabled: false }).run('资料', 20, 30);

    expect(calls.slice(0, 5)).toEqual(['首词:first', '次词:first', '新词:first', '首词:page-2', '次词:page-2']);
    expect(feedbackCalls[0].searchLedger).toHaveLength(2);
    expect(feedbackCalls[0].candidates).toHaveLength(28);
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
      planFeedback: vi.fn(async (input: FeedbackRequestInput) => {
        inputs.push(input);
        const shared = sharedKey
          ? input.candidates!.find((candidate) => candidate.key === sharedKey)
          : input.candidates!.find((candidate) => candidate.title === '共同候选');
        if (shared && !sharedKey) sharedKey = shared.key;
        const positive = input.candidates!.find((candidate) => candidate.key !== shared?.key);
        if (inputs.length === 1) return {
          judgments: [...(shared ? [{ key: shared.key, grade: 0 as const }] : []), ...(positive ? [{ key: positive.key, grade: 2 as const }] : [])],
          newSearches: [{ query: '新词', purpose: '', basis: 'evidence' as const, supportKeys: [positive!.key] }], stopSuggestions: [], shouldStop: false, reasoning: '',
        };
        return {
          judgments: shared ? [{ key: shared.key, grade: 2 as const }] : [],
          newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '',
        };
      }),
    };

    const result = await new SearchSession({
      planner, source, sleep: async () => undefined, finalRerankEnabled: false,
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
      planFeedback: vi.fn(async () => ({ judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '' })),
    };
    const source = {
      sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (_query: string, cursor?: string) => cursor
        ? { hits: [hit('same', '相同候选', 21)] }
        : { hits: [hit('same', '相同候选', 1)], nextCursor: 'p2' }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, finalRerankEnabled: false }).run('资料', 10, 30);

    expect(planner.planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('no_new_candidates');
  });

  it('rejudges and restores the only candidate when later metadata changes after grade 0', async () => {
    const planner = {
      planFirstRound: async () => plan,
      planFeedback: vi.fn()
        .mockImplementationOnce(async (input: FeedbackRequestInput) => ({
          judgments: [{ key: input.candidates[0].key, grade: 0 as const }],
          newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '',
        }))
        .mockImplementationOnce(async (input: FeedbackRequestInput) => ({
          judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
          newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '',
        })),
    };
    const source = {
      sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
      capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
      search: vi.fn(async (_query: string, cursor?: string) => cursor
        ? { hits: [hit('only', '更新后的标题', 2)] }
        : { hits: [hit('only', '原始标题', 1)], nextCursor: 'p2' }),
    };

    const result = await new SearchSession({ planner, source, sleep: async () => undefined, finalRerankEnabled: false }).run('资料', 10, 30);

    expect(planner.planFeedback).toHaveBeenCalledTimes(2);
    expect(result.results.map((candidate) => candidate.id)).toEqual(['only']);
    expect(result.softIsolatedResults).toEqual([]);
  });

  it('completes feedback after a full wave even when that wave uses the last allowed request', async () => {
    const planFeedback = vi.fn(async (input: FeedbackRequestInput) => ({
      judgments: [{ key: input.candidates[0].key, grade: 2 as const }],
      newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '',
    }));
    const result = await new SearchSession({
      planner: { planFirstRound: async () => plan, planFeedback },
      source: {
        sourceId: 'cc98', ratePolicy: { maxSearchCalls: 10, minRequestIntervalMs: 0 },
        capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' } as const,
        search: async () => ({ hits: [hit('one')] }),
      },
      sleep: async () => undefined, finalRerankEnabled: false,
    }).run('资料', 1, 30);

    expect(planFeedback).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('no_new_candidates');
  });

  it('stops on feedback failure, keeps active results, and does not call the final model stage', async () => {
    const rerankResults = vi.fn(async () => ({ orderedKeys: [], removeKeys: [] }));
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => plan,
        planFeedback: async () => { throw new SearchSessionError('反馈模型调用超过 20 秒，已保留当前结果。', 'model_timeout'); },
        rerankResults,
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
    expect(rerankResults).not.toHaveBeenCalled();
  });
});

describe('issue #25 feedback protocol', () => {
  it('uses the configured capacity for one broad query beyond the old four-candidate cap', () => {
    const entries = Array.from({ length: 12 }, (_, index): RetrievedCandidate => ({
      candidate: hit(`broad-${index}`).candidate,
      observations: [{ query: '宽泛词', round: 1 }], documents: [{ title: `broad-${index}` }],
      temporaryKey: `k-${index}`, evidenceRevision: 1, judgedEvidenceRevision: 0,
      latestIndependentQuery: '宽泛词',
    }));

    const selected = selectFeedbackEvidence(entries, entries.map((entry) => entry.candidate.id), 9);

    expect(selected.entries.map((entry) => entry.candidate.id)).toEqual(entries.slice(0, 9).map((entry) => entry.candidate.id));
  });

  it('selects every higher-priority candidate first, then refills beyond the fairness target', () => {
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

    expect(selected.entries.filter((candidate) => candidate.relevanceGrade === undefined)).toHaveLength(5);
    expect(selected.entries.filter((candidate) => candidate.latestIndependentQuery === '宽泛词')).toHaveLength(6);
    expect(selected.entries.map((candidate) => candidate.relevanceGrade)).toEqual([
      undefined, undefined, undefined, undefined, undefined, 0, 2,
    ]);
  });

  it('round-robins two candidates per query before using local pre-rank refill', () => {
    const entry = (id: string, query: string): RetrievedCandidate => ({
      candidate: hit(id).candidate,
      observations: [{ query, round: 1 }], documents: [{ title: id }], temporaryKey: `k-${id}`,
      evidenceRevision: 1, judgedEvidenceRevision: 0, latestIndependentQuery: query,
    });
    const entries = [
      entry('q1-a', 'q1'), entry('q1-b', 'q1'), entry('q1-c', 'q1'),
      entry('q2-a', 'q2'), entry('q2-b', 'q2'), entry('q2-c', 'q2'),
    ];

    const selected = selectFeedbackEvidence(entries, entries.map((candidate) => candidate.candidate.id), 6);

    expect(selected.entries.map((candidate) => candidate.candidate.id)).toEqual([
      'q1-a', 'q2-a', 'q1-b', 'q2-b', 'q1-c', 'q2-c',
    ]);
  });

  it('reserves one slot for a grade 0 rescue candidate behind an unjudged backlog', () => {
    const entry = (id: string, query: string, patch: Partial<RetrievedCandidate> = {}): RetrievedCandidate => ({
      candidate: hit(id).candidate,
      observations: [{ query, round: 1 }], documents: [{ title: id }], temporaryKey: `k-${id}`,
      evidenceRevision: 1, judgedEvidenceRevision: 0, latestIndependentQuery: query,
      ...patch,
    });
    const entries = [
      ...Array.from({ length: 10 }, (_, index) => entry(`new-${index}`, '宽泛词')),
      entry('rescue', '精确词', { relevanceGrade: 0, evidenceRevision: 2, judgedEvidenceRevision: 1 }),
    ];

    const selected = selectFeedbackEvidence(entries, entries.map((candidate) => candidate.candidate.id), 5);

    expect(selected.entries).toHaveLength(5);
    expect(selected.entries.slice(0, 4).every((candidate) => candidate.relevanceGrade === undefined)).toBe(true);
    expect(selected.entries.at(-1)?.candidate.id).toBe('rescue');
  });

  it('releases the rescue reservation and keeps lower priorities behind unjudged candidates', () => {
    const entry = (id: string, relevanceGrade?: 0 | 1 | 2 | 3): RetrievedCandidate => ({
      candidate: hit(id).candidate,
      observations: [{ query: '检索词', round: 1 }], documents: [{ title: id }], temporaryKey: `k-${id}`,
      evidenceRevision: 2, judgedEvidenceRevision: relevanceGrade === undefined ? 0 : 1,
      latestIndependentQuery: '检索词', relevanceGrade,
    });
    const entries = [entry('new-a'), entry('new-b'), entry('judged', 2)];

    const selected = selectFeedbackEvidence(entries, entries.map((candidate) => candidate.candidate.id), 2);

    expect(selected.entries.map((candidate) => candidate.candidate.id)).toEqual(['new-a', 'new-b']);
  });

  it('assigns a multiply observed candidate only to its latest independent query group', () => {
    const entry = (id: string, latestIndependentQuery: string, observations: string[]): RetrievedCandidate => ({
      candidate: hit(id).candidate,
      observations: observations.map((query, index) => ({ query, round: index + 1 })),
      documents: [{ title: id }], temporaryKey: `k-${id}`,
      evidenceRevision: observations.length, judgedEvidenceRevision: 0, latestIndependentQuery,
    });
    const entries = [
      entry('shared', 'q2', ['q1', 'q2']),
      entry('q1-a', 'q1', ['q1']), entry('q1-b', 'q1', ['q1']),
      entry('q2-a', 'q2', ['q2']), entry('q2-b', 'q2', ['q2']),
    ];

    const selected = selectFeedbackEvidence(entries, entries.map((candidate) => candidate.candidate.id), 4);

    expect(selected.entries.map((candidate) => candidate.candidate.id)).toEqual([
      'shared', 'q1-a', 'q2-a', 'q1-b',
    ]);
    expect(selected.entries.filter((candidate) => candidate.candidate.id === 'shared')).toHaveLength(1);
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
    for (const forbidden of ['secret-source', 'secret-', 'https://secret.test', '作者', 'author', '片段', '正文', '回帖', 'authorization']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('skips an oversized candidate and continues packing later candidates', () => {
    const input: FeedbackRequestInput = {
      query: '资料',
      executedSearches: [],
      candidates: [
        ...Array.from({ length: 15 }, (_, index) => ({ key: `long-${index}`, title: `过长${index}`.repeat(20), matchedQueries: ['首词'] })),
        {
          key: 'overflow', title: '中间超限候选'.repeat(30), matchedQueries: ['首词'.repeat(40), '次词'.repeat(40), '第三词'.repeat(40)],
          publishedAt: '2026-09-20'.repeat(8), section: '学习天地'.repeat(30), replyCount: 42,
        },
        { key: 'grade0-rescue', title: '翻案候选', matchedQueries: ['精确词'] },
        { key: 'judged-new-evidence', title: '其他新证据', matchedQueries: ['次词'] },
      ],
    };
    const payload = buildFeedbackPayload(input, '2026-09-20');

    const packedKeys = payload.candidates.map((candidate) => candidate.key);
    expect(packedKeys).not.toContain('overflow');
    expect(packedKeys.slice(-2)).toEqual(['grade0-rescue', 'judged-new-evidence']);
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(4000);
  });

  it('applies skip-and-continue packing at the first whitelist boundary', () => {
    const input: FeedbackRequestInput = {
      query: '资料', executedSearches: [],
      candidates: [
        ...Array.from({ length: 15 }, (_, index) => ({ key: `long-${index}`, title: `过长${index}`.repeat(20), matchedQueries: ['首词'] })),
        { key: 'overflow', title: '中间超限候选'.repeat(30), matchedQueries: ['首词'.repeat(40), '次词'.repeat(40), '第三词'.repeat(40)], section: '学习天地'.repeat(30) },
        { key: 'short', title: '可用候选', matchedQueries: ['首词'] },
      ],
    };

    const core = createFeedbackInput(input);

    expect(core.candidates.map((candidate) => candidate.key)).toContain('short');
    expect(core.candidates.map((candidate) => candidate.key)).not.toContain('overflow');
    expect(new TextEncoder().encode(JSON.stringify(core)).byteLength).toBeLessThanOrEqual(4000);
  });

  it('does not mark candidates omitted by final serialization as judged', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      key: `c${index}`, title: `主题${index}`, matchedQueries: ['首词'],
    }));
    const core = createFeedbackInput({ query: '资料', executedSearches: [], candidates });
    expect(core.candidates.length).toBeLessThanOrEqual(100);
    const payload = buildFeedbackPayload(core, '2026-09-22');
    const payloadKeys = new Set(payload.candidates.map((candidate) => candidate.key));
    const omitted = core.candidates.find((candidate) => !payloadKeys.has(candidate.key));
    expect(omitted).toBeDefined();
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      judgments: core.candidates.map((candidate) => ({ key: candidate.key, grade: 0 })),
      new_searches: [], should_stop: true,
    }) }, DEFAULT_SETTINGS, { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' }, () => '2026-09-22');
    const entries = core.candidates.map((candidate): RetrievedCandidate => ({
      candidate: hit(candidate.key).candidate,
      observations: [{ query: '首词', round: 1 }], documents: [{ title: candidate.title }],
      temporaryKey: candidate.key, evidenceRevision: 1, judgedEvidenceRevision: 0,
      latestIndependentQuery: '首词',
    }));

    const feedback = await client.planFeedback(core);
    applyFeedbackJudgments(entries, feedback.judgments);

    expect(feedback.judgments.map((judgment) => judgment.key)).not.toContain(omitted!.key);
    expect(entries.find((entry) => entry.temporaryKey === omitted!.key)?.judgedEvidenceRevision).toBe(0);
    expect(entries.some((entry) => entry.judgedEvidenceRevision === 1)).toBe(true);
  });
});
