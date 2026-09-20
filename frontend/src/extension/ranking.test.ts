import { describe, expect, it } from 'vitest';

import { rankAndFilterCandidates, rankCandidates } from './ranking';
import type { ModelQueryPlan, RelevanceGrade, RetrievedCandidate } from './types';

const plan: ModelQueryPlan = {
  summary: '高数资料',
  searches: [{ query: '高数', purpose: '' }, { query: '微积分', purpose: '' }],
  requiredConcepts: [{ name: '课程', expressions: ['高数', '高等数学', '微积分'] }],
  excludedTerms: ['求助'],
  timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' },
};

function topic(id: string, patch: Partial<{
  title: string; time: string; plans: string[]; bestRank: number; firstRound: number; relevanceGrade: RelevanceGrade;
}> = {}): RetrievedCandidate {
  const fixture = { title: '高数资料', time: '2025-06-01', plans: ['高数'], bestRank: 10, firstRound: 1, ...patch };
  const candidate = { sourceId: 'example', id, titleOrigin: 'native' as const, title: fixture.title, section: '学习天地',
    publishedAt: fixture.time, author: 'alice', replyCount: 1, url: `https://example.test/${id}` };
  return {
    candidate,
    observations: fixture.plans.map((query) => ({ query, round: fixture.firstRound, position: fixture.bestRank })),
    documents: fixture.plans.map(() => ({ title: fixture.title, section: '学习天地', publishedAt: fixture.time })),
    relevanceGrade: patch.relevanceGrade,
  };
}

describe('rankCandidates', () => {
  it('lets higher relevance grades outrank every lexical and retrieval tie-break', () => {
    const ranked = rankCandidates([
      topic('grade-2-strong-lexical', { relevanceGrade: 2, plans: ['高数', '微积分'], bestRank: 1, firstRound: 1 }),
      topic('grade-3-weak-lexical', { relevanceGrade: 3, title: '大学资料求助', plans: ['高数'], bestRank: 50, firstRound: 3 }),
      topic('unjudged-strong-lexical', { plans: ['高数', '微积分'], bestRank: 1, firstRound: 1 }),
      topic('grade-2-weak-lexical', { relevanceGrade: 2, title: '大学资料求助', plans: ['高数'], bestRank: 50, firstRound: 3 }),
    ], plan);

    expect(ranked.map((item) => item.id)).toEqual([
      'grade-3-weak-lexical',
      'grade-2-strong-lexical',
      'grade-2-weak-lexical',
      'unjudged-strong-lexical',
    ]);
  });

  it('places grade 1 and unjudged candidates in the same semantic tier', () => {
    const ranked = rankCandidates([
      topic('grade-1-weak', { relevanceGrade: 1, title: '大学资料求助', bestRank: 50 }),
      topic('unjudged-strong', { plans: ['高数', '微积分'], bestRank: 1 }),
    ], plan);

    expect(ranked.map((item) => item.id)).toEqual(['unjudged-strong', 'grade-1-weak']);
  });

  it('applies an explicit time range as a hard filter before relevance ordering', () => {
    const view = rankAndFilterCandidates([
      topic('old-grade-3', { relevanceGrade: 3, time: '2024-06-01' }),
      topic('unknown-date', { relevanceGrade: 2, time: '' }),
      topic('current-unjudged'),
    ], plan, true);

    expect(view.results.map((item) => item.id)).toEqual(['unknown-date', 'current-unjudged']);
    expect(view.outOfRangeCount).toBe(1);
  });

  it('uses the candidate identity as the final deterministic tie-break', () => {
    const a = topic('a', { title: '完全相同的标题' });
    const b = topic('b', { title: '完全相同的标题' });

    expect(rankCandidates([b, a], plan).map((item) => item.id)).toEqual(['a', 'b']);
    expect(rankCandidates([a, b], plan).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('uses the specified lexicographic order and first-round tie-break', () => {
    const ranked = rankCandidates([
      topic('out', { time: '2024-06-01', plans: ['高数', '微积分'], bestRank: 1 }),
      topic('excluded', { title: '高数求助', bestRank: 1 }),
      topic('missing', { title: '大学资料', bestRank: 1 }),
      topic('single', { plans: ['高数'], bestRank: 1 }),
      topic('later', { plans: ['高数', '微积分'], bestRank: 2, firstRound: 2 }),
      topic('earlier', { plans: ['高数', '微积分'], bestRank: 2, firstRound: 1 }),
      topic('unknown', { time: '', plans: ['高数', '微积分'], bestRank: 1 }),
    ], plan);

    expect(ranked.map((item) => item.id)).toEqual([
      'unknown',
      'earlier',
      'later',
      'single',
      'missing',
      'excluded',
      'out',
    ]);
  });
});

describe('observation-derived ordering', () => {
  it('counts distinct folded queries rather than repeated hits and puts unknown positions last', () => {
    const repeated = topic('repeated');
    repeated.observations = [{ query: ' 高数 ', round: 3, position: 2 }, { query: '高数', round: 2, position: 2 }];
    const diverse = topic('diverse');
    diverse.observations = [{ query: '高数', round: 4 }, { query: '微积分', round: 4 }];
    const unknown = topic('unknown');
    unknown.observations = [{ query: '高数', round: 1 }];
    const invalid = topic('invalid');
    invalid.observations = [{ query: '高数', round: 5, position: 0 }];
    const results = rankCandidates([unknown, repeated, diverse, invalid], plan);
    expect(results.map((item) => item.id)).toEqual(['diverse', 'repeated', 'unknown', 'invalid']);
    expect(results.find((item) => item.id === 'repeated')?.firstRound).toBe(2);
    expect(Object.keys(results[0]).sort()).toEqual(['author', 'board', 'firstRound', 'id', 'replyCount', 'time', 'title', 'url']);
  });

  it('uses all documents for exclusions without fabricating phrases across snippets', () => {
    const partial = topic('partial');
    partial.documents = [{ title: '', snippet: '高等' }, { title: '', snippet: '数学' }];
    const complete = topic('complete');
    complete.documents = [{ title: '高等数学' }];
    const excluded = topic('excluded');
    excluded.documents = [{ title: '高等数学', snippet: '求助' }, { title: '高等数学' }];
    const noDates = { ...plan, timeConstraint: { expression: '', startDate: null, endDate: null } };
    expect(rankCandidates([partial, excluded, complete], noDates).map((item) => item.id)).toEqual(['complete', 'partial', 'excluded']);
  });
});
