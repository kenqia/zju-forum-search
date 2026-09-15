import { describe, expect, it } from 'vitest';

import { rankCandidates } from './ranking';
import type { ModelQueryPlan, TopicCandidate } from './types';

const plan: ModelQueryPlan = {
  summary: '高数资料',
  searches: [{ query: '高数', purpose: '' }, { query: '微积分', purpose: '' }],
  requiredConcepts: [{ name: '课程', expressions: ['高数', '高等数学', '微积分'] }],
  excludedTerms: ['求助'],
  timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' },
};

function topic(id: string, patch: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    id,
    title: '高数资料',
    board: '学习天地',
    time: '2025-06-01',
    author: 'alice',
    replyCount: 1,
    url: `https://www.cc98.org/topic/${id}`,
    retrievalScore: 1,
    bestRank: 10,
    plans: ['高数'],
    firstRound: 1,
    ...patch,
  };
}

describe('rankCandidates', () => {
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
      'earlier',
      'later',
      'single',
      'missing',
      'excluded',
      'unknown',
      'out',
    ]);
  });
});
