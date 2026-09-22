import { FEEDBACK_METADATA_BYTE_LIMIT } from './feedback-payload';
import { describe, expect, it } from 'vitest';

import { buildFeedbackMessages, localRelativeTimeRange, normalizeModelPlan, PlannerClient, PlannerError } from './planner';
import { DEFAULT_SETTINGS, type SourceCapabilities, type FeedbackCandidate } from './types';

const capabilities: SourceCapabilities = { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' };

describe('PlannerClient', () => {
  it('规范化最终列表重排协议中的排序键和移除键', async () => {
    let wirePayload: Record<string, unknown> = {};
    const client = new PlannerClient({ chatCompletions: async (_settings, messages) => {
      wirePayload = JSON.parse(messages[1].content);
      return JSON.stringify({ ordered_keys: ['c1', 'unknown', 'c1'], remove_keys: ['c0', 'unknown', 'c0'] });
    } }, DEFAULT_SETTINGS, capabilities);

    await expect(client.rerankResults({
      query: '资料',
      candidates: [
        { key: 'c0', title: '高数资料', matchedQueries: [], independentQueryCount: 0, bestSourcePosition: null },
        { key: 'c1', title: '微积分资料', matchedQueries: [], independentQueryCount: 0, bestSourcePosition: null },
      ],
    })).resolves.toEqual({ orderedKeys: ['c1'], removeKeys: ['c0'] });
    expect(wirePayload).toEqual({
      query: '资料',
      candidates: [
        { key: 'c0', title: '高数资料', board: '', time: '', reply_count: 0,
          matched_queries: [], independent_query_count: 0, best_source_position: null },
        { key: 'c1', title: '微积分资料', board: '', time: '', reply_count: 0,
          matched_queries: [], independent_query_count: 0, best_source_position: null },
      ],
    });
  });

  it.each([
    {}, [], { reasoning: 'unknown' }, { ordered_keys: 'c0' }, { remove_keys: [1] },
  ])('拒绝无法识别的最终列表重排响应：%j', async (response) => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify(response) }, DEFAULT_SETTINGS, capabilities);
    await expect(client.rerankResults({ query: '资料', candidates: [{
      key: 'c0', title: '资料', matchedQueries: [], independentQueryCount: 0, bestSourcePosition: null,
    }] })).rejects.toThrow('最终列表重排');
  });

  it.each([
    ['title', 'plain-keyword'], ['fulltext', 'plain-keyword'], ['mixed', 'plain-keyword'], ['mixed', 'boolean'],
  ] as const)('uses %s / %s capabilities in every planning round', async (searchSurface, querySyntax) => {
    const prompts: string[] = [];
    const client = new PlannerClient({ chatCompletions: async (_settings, messages) => {
      prompts.push(messages[0].content);
      return JSON.stringify({ searches: ['高数'], judgments: [], new_searches: [], stop_suggestions: [], should_stop: true, reasoning: '' });
    } }, DEFAULT_SETTINGS, { searchSurface, querySyntax, resultOrdering: 'time-desc' });
    await client.planFirstRound('高数');
    await client.planFeedback({ query: '高数', executedSearches: [], candidates: [] });
    for (const prompt of prompts) {
      expect(prompt).toContain({ title: '仅匹配原生标题', fulltext: '匹配全文', mixed: '匹配标题和正文' }[searchSurface]);
      expect(prompt).toContain(querySyntax === 'plain-keyword' ? '普通关键词' : '支持布尔查询语法');
      expect(prompt).not.toContain('论坛');
    }
    expect(prompts[1]).toContain('标题为空');
    expect(prompts[1]).toContain('不得推测正文');
  });

  it('sends the current local date in first-round and feedback planning calls', async () => {
    const payloads: Record<string, unknown>[] = [];
    const responses = [
      JSON.stringify({
        summary: '近三年微积分资料', searches: [{ query: '微积分', purpose: '' }], required_concepts: [], excluded_terms: [],
        time_constraint: { expression: '近三年', start_date: '2023-09-15', end_date: '2026-09-15' },
      }),
      JSON.stringify({ judgments: [], new_searches: [], stop_suggestions: [], should_stop: true, reasoning: '足够' }),
    ];
    const client = new PlannerClient({
      chatCompletions: async (_settings, messages) => {
        payloads.push(JSON.parse(messages[1].content));
        return responses.shift()!;
      },
    }, DEFAULT_SETTINGS, capabilities, () => '2026-09-15');

    await client.planFirstRound('近三年的微积分资料');
    await client.planFeedback({ query: '近三年的微积分资料', executedSearches: [], candidates: [] });

    expect(payloads).toEqual([
      { query: '近三年的微积分资料', current_date: '2026-09-15' },
      expect.objectContaining({ query: '近三年的微积分资料', current_date: '2026-09-15' }),
    ]);
  });

  it('rejects a first-round response without usable searches', async () => {
    const client = new PlannerClient({ chatCompletions: async () => '{"summary":"空","searches":[]}' }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('高数资料')).rejects.toThrow(PlannerError);
  });

  it('normalizes recoverable omissions and shorthand searches before validation', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      searches: ['微积分', { query: '高数' }],
      required_concepts: [{ name: '课程', expressions: [] }],
    }) }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('微积分')).resolves.toEqual({
      summary: '微积分',
      searches: [{ query: '微积分', purpose: '', role: 'balanced' }, { query: '高数', purpose: '', role: 'balanced' }],
      requiredConcepts: [],
      excludedTerms: [],
      timeConstraint: { expression: '', startDate: null, endDate: null },
    });
  });

  it('reports the semantic error when no usable search remains', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '空计划', searches: ['', { query: '  ' }],
    }) }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('帮我找微积分')).rejects.toThrow('模型没有返回可用检索词');
  });

  it('falls back to a pure keyword when the returned plan cannot be recovered', async () => {
    const client = new PlannerClient({ chatCompletions: async () => '{"searches":[]}' }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('微积分')).resolves.toMatchObject({
      summary: '直接搜索原词：微积分',
      searches: [{ query: '微积分', purpose: '模型计划无效，直接使用用户原词', role: 'balanced' }],
      requiredConcepts: [],
      excludedTerms: [],
      timeConstraint: { expression: '', startDate: null, endDate: null },
      usedOriginalQueryFallback: true,
    });
  });

  it('does not use the keyword fallback for a natural-language phrase', async () => {
    const client = new PlannerClient({ chatCompletions: async () => '{"searches":[]}' }, DEFAULT_SETTINGS, capabilities);

    for (const query of ['帮我找 微积分资料', '哪个老师讲微积分']) {
      await expect(client.planFirstRound(query)).rejects.toThrow('模型没有返回可用检索词');
    }
  });

  it('reports malformed dates as a time-range error', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '高数', searches: [{ query: '高数', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '2025 年', start_date: 'not-a-date', end_date: null },
    }) }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('2025 年高数资料')).rejects.toThrow('模型返回的时间范围无效');
  });

  it('rejects missing, invalid, or reversed dates for an explicit time request', async () => {
    const response = (startDate: string | null, endDate: string | null) => JSON.stringify({
      summary: '上学期微积分资料', searches: [{ query: '微积分', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '上学期', start_date: startDate, end_date: endDate },
    });

    for (const [startDate, endDate] of [[null, null], ['2026-02-30', '2026-09-15'], ['2026-09-15', '2023-09-15']] as const) {
      const client = new PlannerClient({ chatCompletions: async () => response(startDate, endDate) }, DEFAULT_SETTINGS, capabilities);
      await expect(client.planFirstRound('上学期的微积分资料')).rejects.toThrow('模型返回的时间范围无效');
    }
  });

  it('does not consult model dates when the relative expression is resolved locally', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '近三年微积分资料', searches: [{ query: '微积分', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '近三年', start_date: 'invalid', end_date: null },
    }) }, DEFAULT_SETTINGS, capabilities, () => '2026-09-15');

    await expect(client.planFirstRound('近三年的微积分资料')).resolves.toMatchObject({
      timeConstraint: { startDate: '2023-09-15', endDate: '2026-09-15' },
    });
  });

  it('accepts a descriptive no-time expression when dates are empty for an untimed query', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '软件工程管理资料', searches: [{ query: '软件工程管理', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '无明确时间限制', start_date: null, end_date: null },
    }) }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('帮我查软件工程管理的资料和讨论')).resolves.toMatchObject({
      timeConstraint: { expression: '', startDate: null, endDate: null },
    });
  });

  it('rejects model-added dates when the query has no explicit time request', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '软件工程管理资料', searches: [{ query: '软件工程管理', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '近三年', start_date: '2023-09-16', end_date: '2026-09-16' },
    }) }, DEFAULT_SETTINGS, capabilities);

    await expect(client.planFirstRound('帮我查软件工程管理的资料和讨论')).rejects.toThrow('模型返回的时间范围无效');
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
      searches: [{ query: '高数', purpose: '', role: 'balanced' }],
      requiredConcepts: [{ name: '课程', expressions: ['高数', '高等数学'] }],
      excludedTerms: ['求助'],
      timeConstraint: { expression: '2025 年', startDate: '2025-01-01', endDate: '2025-12-31' },
    });
  });
});

describe('local relative time resolution', () => {
  it.each([
    ['最近的微积分资料', '2026-09-19', { startDate: '2026-08-21', endDate: '2026-09-19' }],
    ['近半个月的微积分资料', '2026-09-19', { startDate: '2026-09-05', endDate: '2026-09-19' }],
    ['近 3 天的讨论', '2026-09-19', { startDate: '2026-09-17', endDate: '2026-09-19' }],
    ['最近两周的帖子', '2026-09-19', { startDate: '2026-09-06', endDate: '2026-09-19' }],
    ['近两个月的资料', '2026-09-19', { startDate: '2026-07-19', endDate: '2026-09-19' }],
    ['近两年的操作系统资料', '2026-09-19', { startDate: '2024-09-19', endDate: '2026-09-19' }],
    ['近一百天的资料', '2026-09-19', { startDate: '2026-06-12', endDate: '2026-09-19' }],
    ['最近 1 个月', '2026-01-31', { startDate: '2025-12-31', endDate: '2026-01-31' }],
    ['近 1 年', '2025-03-01', { startDate: '2024-03-01', endDate: '2025-03-01' }],
    ['近 1 年', '2024-02-29', { startDate: '2023-02-28', endDate: '2024-02-29' }],
    ['近 3 个月', '2026-05-31', { startDate: '2026-02-28', endDate: '2026-05-31' }],
  ] as const)('resolves %s on %s', (query, today, expected) => {
    expect(localRelativeTimeRange(query, today)).toMatchObject(expected);
  });

  it('returns null for expressions that need the model', () => {
    expect(localRelativeTimeRange('2025 年的高数资料', '2026-09-19')).toBeNull();
    expect(localRelativeTimeRange('上学期的操作系统讨论', '2026-09-19')).toBeNull();
  });

  it('overrides the model time range for locally parsed queries', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '最近微积分资料', searches: [{ query: '微积分', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '最近', start_date: '2020-01-01', end_date: '2020-12-31' },
    }) }, DEFAULT_SETTINGS, capabilities, () => '2026-09-19');

    await expect(client.planFirstRound('最近的微积分资料')).resolves.toMatchObject({
      timeConstraint: { startDate: '2026-08-21', endDate: '2026-09-19' },
    });
  });

  it('keeps model dates for explicit expressions that are not locally parsed', async () => {
    const client = new PlannerClient({ chatCompletions: async () => JSON.stringify({
      summary: '2025 年资料', searches: [{ query: '微积分', purpose: '' }], required_concepts: [], excluded_terms: [],
      time_constraint: { expression: '2025 年', start_date: '2025-01-01', end_date: '2025-12-31' },
    }) }, DEFAULT_SETTINGS, capabilities, () => '2026-09-19');

    await expect(client.planFirstRound('2025 年的微积分资料')).resolves.toMatchObject({
      timeConstraint: { startDate: '2025-01-01', endDate: '2025-12-31' },
    });
  });
});

describe('feedback privacy boundary', () => {
  it('serializes only approved topic metadata and truncates long titles', () => {
    const candidate = {
      id: 'secret-id',
      title: '题'.repeat(100),
      author: 'alice',
      section: '学习天地',
      publishedAt: '2026-09-15',
      replyCount: 8,
      url: 'https://www.cc98.org/topic/1',
      retrievalScore: 1,
      bestRank: 1,
      plans: ['高数'],
      firstRound: 1,
      body: '正文不得出域',
      replies: ['回帖不得出域'],
      authorization: 'Bearer secret',
      key: 'c0', matchedQueries: ['高数'],
    } as FeedbackCandidate & Record<string, unknown>;

    const messages = buildFeedbackMessages({
      query: '找高数资料',
      executedSearches: [{ query: '高数', hitCount: 1 }],
      candidates: [candidate],
    }, capabilities);
    const payload = JSON.parse(messages[1].content);

    expect(payload.candidates).toEqual([{
      key: 'c0', matched_queries: ['高数'],
      title: '题'.repeat(80),
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
      key: `c${index}`, matchedQueries: ['检索词'], title: `主题-${index}-${'中文'.repeat(80)}`, author: '作者', section: '学习天地',
      publishedAt: '2026-09-15', replyCount: index, url: '', retrievalScore: 1, bestRank: index + 1,
      plans: ['检索词'], firstRound: 1,
    }));

    const executedSearches = Array.from({ length: 30 }, (_, index) => ({ query: `检索词-${index}-${'中文'.repeat(100)}`, hitCount: index }));
    const content = buildFeedbackMessages({ query: '测试'.repeat(500), executedSearches, candidates }, capabilities, '2026-09-17')[1].content;

    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(FEEDBACK_METADATA_BYTE_LIMIT);
    expect(JSON.parse(content).candidates.length).toBeLessThan(candidates.length);
  });
});
