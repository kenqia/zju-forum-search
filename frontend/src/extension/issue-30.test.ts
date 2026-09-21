import { describe, expect, it, vi } from 'vitest';

import { buildFinalRerankPayload, createFinalRerankSelection } from './final-reranking';
import { buildFeedbackMessages, feedbackSystemPrompt, finalRerankSystemPrompt, firstRoundSystemPrompt, normalizeModelPlan, PlannerClient } from './planner';
import { rankAndFilterCandidates } from './ranking';
import { mergeHits } from './retrieval';
import { SearchSession } from './search-session';
import { DEFAULT_SETTINGS, type ModelQueryPlan, type SearchHit, type SourceCapabilities } from './types';

const titleCapabilities: SourceCapabilities = {
  searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc',
};

const basePlan: ModelQueryPlan = {
  summary: '资料',
  searches: [],
  requiredConcepts: [],
  excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null },
};

function hit(id: string, author = '本地作者'): SearchHit {
  return {
    candidate: {
      sourceId: 'cc98', id, title: `${id} 资料`, titleOrigin: 'native',
      url: `https://example.test/${id}`, author, section: '学习天地', replyCount: 2,
    },
    document: { title: `${id} 资料`, author, section: '学习天地', replyCount: 2 },
    position: 1,
  };
}

describe('Issue #30 查询组合', () => {
  it('把缺失或未知 role 规范化为 balanced，并在标题来源提示查询组合约束', () => {
    expect(normalizeModelPlan({
      searches: [
        { query: '精确组合', role: 'precise' },
        { query: '缺失角色' },
        { query: '未知角色', role: 'wide' },
        { query: '核心实体', role: 'anchor' },
      ],
    }).searches).toEqual([
      { query: '精确组合', purpose: '', role: 'precise' },
      { query: '缺失角色', purpose: '', role: 'balanced' },
      { query: '未知角色', purpose: '', role: 'balanced' },
      { query: '核心实体', purpose: '', role: 'anchor' },
    ]);

    const prompt = firstRoundSystemPrompt(titleCapabilities);
    expect(prompt).toMatch(/至少.*一个 anchor/u);
    expect(prompt).toMatch(/至少.*一个非 anchor/u);
    for (const generic of ['求助', '经验', '帖子', '有没有']) expect(prompt).toContain(generic);
  });

  it('预算只够两次首页时优先执行最靠前的 anchor 和非 anchor，并提示不完整组合', async () => {
    const searched: string[] = [];
    const snapshots: Array<{ planningNotice: string }> = [];
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({
          ...basePlan,
          searches: [
            { query: '第一个平衡词', purpose: '', role: 'balanced' },
            { query: '第二个平衡词', purpose: '', role: 'balanced' },
            { query: '宽锚点', purpose: '', role: 'anchor' },
          ],
        }),
        planFeedback: async () => ({ judgments: [], newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: async () => basePlan,
      },
      source: {
        sourceId: 'cc98', capabilities: titleCapabilities,
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        search: async (query) => {
          searched.push(query);
          return { hits: [hit(query)] };
        },
      },
      finalRerankEnabled: false,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });

    await session.run('找资料', 2);

    expect(searched).toEqual(['第一个平衡词', '宽锚点']);
    expect(snapshots.at(-1)?.planningNotice).toBe('');

    const incomplete = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...basePlan, searches: [{ query: '只有平衡词', purpose: '', role: 'balanced' }] }),
        planFeedback: async () => ({ judgments: [], newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '' }),
        planBlindExpansion: async () => basePlan,
      },
      source: {
        sourceId: 'cc98', capabilities: titleCapabilities,
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        search: async () => ({ hits: [hit('only')] }),
      },
      finalRerankEnabled: false,
    });
    const result = await incomplete.run('找资料', 1);
    expect(result.planningNotice).toContain('查询组合不完整');
  });

  it('查询角色不参与候选本地排序', () => {
    const entries = [
      { candidate: hit('a').candidate, documents: [hit('a').document], observations: [{ round: 1, query: '平衡词', position: 2 }] },
      { candidate: hit('b').candidate, documents: [hit('b').document], observations: [{ round: 1, query: '宽锚点', position: 1 }] },
    ];
    const balanced = { ...basePlan, searches: [{ query: '平衡词', purpose: '', role: 'balanced' as const }, { query: '宽锚点', purpose: '', role: 'anchor' as const }] };
    const swapped = { ...basePlan, searches: [{ query: '平衡词', purpose: '', role: 'anchor' as const }, { query: '宽锚点', purpose: '', role: 'balanced' as const }] };
    expect(rankAndFilterCandidates(entries, balanced, false).results.map((candidate) => candidate.id))
      .toEqual(rankAndFilterCandidates(entries, swapped, false).results.map((candidate) => candidate.id));
  });
});

describe('Issue #30 可验证扩展', () => {
  it('逐条保留 query 依据和同响应 grade 2/3 支持的 evidence 依据', async () => {
    const client = new PlannerClient({
      chatCompletions: async () => JSON.stringify({
        judgments: [{ key: 'c0', grade: 2 }, { key: 'c1', grade: 1 }, { key: 'c2', grade: 3 }],
        new_searches: [
          { query: '查询放宽', basis: 'query', support_keys: [], purpose: null },
          { query: '标题术语', basis: 'evidence', support_keys: ['c0', 'c0'], purpose: '原生标题' },
          { query: '弱证据', basis: 'evidence', support_keys: ['c1'], purpose: '' },
          { query: '未知证据', basis: 'evidence', support_keys: ['historical'], purpose: '' },
          { query: '混合语义', basis: 'query', support_keys: ['c0'], purpose: '' },
          { query: '过多支持', basis: 'evidence', support_keys: ['c0', 'c1', 'c2', 'c3'], purpose: '' },
          { query: '非法依据', basis: 'guess', support_keys: [], purpose: '' },
          { query: '正文派生标题', basis: 'evidence', support_keys: ['c2'], purpose: '' },
          42,
        ],
        stop_suggestions: [], should_stop: false, reasoning: '',
      }),
    }, DEFAULT_SETTINGS, titleCapabilities);

    await expect(client.planFeedback({
      query: '找资料', executedSearches: [],
      candidates: [
        { key: 'c0', title: '标题术语资料', matchedQueries: ['原词'] },
        { key: 'c1', title: '不确定资料', matchedQueries: ['原词'] },
        { key: 'c2', title: '', matchedQueries: ['原词'] },
      ],
    })).resolves.toMatchObject({
      judgments: [{ key: 'c0', grade: 2 }, { key: 'c1', grade: 1 }, { key: 'c2', grade: 3 }],
      newSearches: [
        { query: '查询放宽', purpose: '', basis: 'query', supportKeys: [] },
        { query: '标题术语', purpose: '原生标题', basis: 'evidence', supportKeys: ['c0'] },
      ],
    });

    const feedbackPrompt = feedbackSystemPrompt(titleCapabilities);
    expect(feedbackPrompt).toContain('板块可以帮助判断相关性');
    expect(feedbackPrompt).toContain('回复数不能单独提高 grade');
    expect(finalRerankSystemPrompt()).toContain('弱破同分信号');
  });

  it('搜索运行只执行带对应支持键的 evidence 扩展，不用一个正信号放行整批词', async () => {
    const searched: string[] = [];
    const planFeedback = vi.fn()
      .mockResolvedValueOnce({
        judgments: [{ key: 'c0', grade: 3 }],
        newSearches: [
          { query: '有支持的新词', purpose: '', basis: 'evidence', supportKeys: ['c0'] },
          { query: '无支持的新词', purpose: '', basis: 'evidence', supportKeys: [] },
          { query: '未来救援词', purpose: '', basis: 'query', supportKeys: [] },
        ],
        stopSuggestions: [], shouldStop: false, reasoning: '',
      })
      .mockResolvedValue({ judgments: [], newSearches: [], stopSuggestions: [], shouldStop: true, reasoning: '' });
    const session = new SearchSession({
      planner: {
        planFirstRound: async () => ({ ...basePlan, searches: [{ query: '原词', purpose: '', role: 'balanced' }] }),
        planFeedback,
        planBlindExpansion: async () => basePlan,
      },
      source: {
        sourceId: 'cc98', capabilities: titleCapabilities,
        ratePolicy: { maxSearchCalls: 30, minRequestIntervalMs: 0 },
        search: async (query) => {
          searched.push(query);
          return { hits: [hit(query === '原词' ? 'seed' : 'expanded')] };
        },
      },
      finalRerankEnabled: false,
    });

    await session.run('找资料', 4);
    expect(searched).toContain('有支持的新词');
    expect(searched).not.toContain('无支持的新词');
    expect(searched).not.toContain('未来救援词');
  });
});

describe('Issue #30 模型元数据边界', () => {
  it('反馈和最终重排 wire payload 都不包含作者，但本地候选仍保留作者', () => {
    const feedback = buildFeedbackMessages({
      query: '资料', executedSearches: [],
      candidates: [{ key: 'c0', title: '资料', author: '不应出域的作者', matchedQueries: ['资料'] } as never],
    }, titleCapabilities)[1].content;
    expect(feedback).not.toContain('author');
    expect(feedback).not.toContain('不应出域的作者');

    const entry = {
      candidate: hit('local').candidate,
      observations: [{ round: 1, query: '资料', position: 1 }],
      documents: [hit('local').document], temporaryKey: 'c0', evidenceRevision: 1,
    };
    const localResult = {
      id: 'local', title: 'local 资料', board: '学习天地', time: '', author: '本地作者',
      replyCount: 2, url: 'https://example.test/local', firstRound: 1,
    };
    const selection = createFinalRerankSelection('资料', [localResult, { ...localResult, id: 'second' }], [
      entry,
      { ...entry, candidate: hit('second').candidate, temporaryKey: 'c1' },
    ], 2)!;
    expect(selection.input.candidates[0]).not.toHaveProperty('author');
    expect(JSON.stringify(buildFinalRerankPayload(selection.input))).not.toContain('author');
    expect(localResult.author).toBe('本地作者');
  });

  it('只有作者变化时更新本地显示值，不增加模型可见证据版本', () => {
    const candidates = new Map();
    mergeHits(candidates, [hit('same', '作者甲')], '资料', 1);
    mergeHits(candidates, [hit('same', '作者乙')], '资料', 2);

    expect(candidates.get('same').candidate.author).toBe('作者乙');
    expect(candidates.get('same').evidenceRevision).toBe(1);
  });
});
