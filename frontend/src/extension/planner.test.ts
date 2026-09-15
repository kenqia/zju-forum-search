import { describe, expect, it } from 'vitest';

import { buildFeedbackMessages, FEEDBACK_METADATA_TOKEN_LIMIT, normalizeModelPlan, PlannerClient, PlannerError } from './planner';
import { DEFAULT_SETTINGS, type TopicCandidate } from './types';

describe('PlannerClient', () => {
  it('rejects a first-round response without usable searches', async () => {
    const client = new PlannerClient({ chatCompletions: async () => '{"summary":"空","searches":[]}' }, DEFAULT_SETTINGS);

    await expect(client.planFirstRound('高数资料')).rejects.toThrow(PlannerError);
  });

  it('rejects a first-round response with a partial schema', async () => {
    const client = new PlannerClient({ chatCompletions: async () => '{"searches":[{"query":"高数"}]}' }, DEFAULT_SETTINGS);

    await expect(client.planFirstRound('高数资料')).rejects.toThrow('模型返回的查询计划结构无效');
  });

  it('rejects malformed time constraint fields', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '高数', searches: [{ query: '高数', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '', start_date: null },
    }) }, DEFAULT_SETTINGS);

    await expect(client.planFirstRound('高数资料')).rejects.toThrow('模型返回的查询计划结构无效');
  });

  it('normalizes the fixed first-round constraints', () => {
    expect(normalizeModelPlan({
      summary: '  资料 ',
      searches: [{ query: ' 高数 ', purpose: '' }, { query: '高数', purpose: '重复' }],
      required_concepts: [{ name: '课程', expressions: ['高数', ' 高等数学 '] }],
      excluded_terms: ['求助'],
      time_constraint: { expression: '2025 年', start_date: '2025-01-01', end_date: '2025-12-31' },
    })).toEqual({
      summary: '资料',
      searches: [{ query: '高数', purpose: '' }],
      requiredConcepts: [{ name: '课程', expressions: ['高数', '高等数学'] }],
      excludedTerms: ['求助'],
      timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' },
    });
  });
});

describe('feedback privacy boundary', () => {
  it('serializes only approved topic metadata and truncates long titles', () => {
    const candidate = {
      id: 'secret-id',
      title: '题'.repeat(100),
      author: 'alice',
      board: '学习天地',
      time: '2026-09-15',
      replyCount: 8,
      url: 'https://www.cc98.org/topic/1',
      retrievalScore: 1,
      bestRank: 1,
      plans: ['高数'],
      firstRound: 1,
      body: '正文不得出域',
      replies: ['回帖不得出域'],
      authorization: 'Bearer secret',
    } as TopicCandidate & Record<string, unknown>;

    const messages = buildFeedbackMessages({
      query: '找高数资料',
      executedSearches: [{ query: '高数', hitCount: 1 }],
      newCandidates: [candidate],
      round: 1,
    });
    const payload = JSON.parse(messages[1].content);

    expect(payload.new_candidates).toEqual([{
      title: '题'.repeat(80),
      author: 'alice',
      board: '学习天地',
      time: '2026-09-15',
      reply_count: 8,
    }]);
    expect(messages[1].content).not.toContain('secret-id');
    expect(messages[1].content).not.toContain('正文不得出域');
    expect(messages[1].content).not.toContain('Bearer secret');
  });

  it('caps the complete feedback metadata payload conservatively by UTF-8 bytes', () => {
    const candidates = Array.from({ length: 200 }, (_, index) => ({
      id: String(index), title: `主题-${index}-${'中文'.repeat(80)}`, author: '作者', board: '学习天地',
      time: '2026-09-15', replyCount: index, url: '', retrievalScore: 1, bestRank: index + 1,
      plans: ['检索词'], firstRound: 1,
    }));

    const executedSearches = Array.from({ length: 30 }, (_, index) => ({ query: `检索词-${index}-${'中文'.repeat(100)}`, hitCount: index }));
    const content = buildFeedbackMessages({ query: '测试'.repeat(500), executedSearches, newCandidates: candidates, round: 1 })[1].content;

    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(FEEDBACK_METADATA_TOKEN_LIMIT);
    expect(JSON.parse(content).new_candidates.length).toBeLessThan(candidates.length);
  });
});
