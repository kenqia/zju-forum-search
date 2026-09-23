import { buildFeedbackPayload, FEEDBACK_SEARCH_QUERY_LIMIT } from './feedback-payload';
import { buildFinalRerankPayload, normalizeFinalRerankPlan } from './final-reranking';
import { folded, normalizeText } from './text';
import type { ExtensionSettings, FeedbackPlan, FeedbackRequestInput, FeedbackSearch, FinalRerankPlan, FinalRerankRequestInput, ModelQueryPlan, PlannedSearch, QueryRole, SourceCapabilities, StopQuerySuggestion, TimeConstraint } from './types';

export interface PlannerTransport {
  chatCompletions(settings: ExtensionSettings, messages: { role: string; content: string }[], signal?: AbortSignal): Promise<string>;
}

export type PlannerErrorCode = 'planner_failed' | 'model_timeout' | 'model_cancelled';

export class PlannerError extends Error {
  constructor(message: string, readonly code: PlannerErrorCode = 'planner_failed') {
    super(message);
  }
}

export function hasExplicitTimeConstraint(query: string): boolean {
  const value = normalizeText(query);
  return /(?:19|20)\d{2}\s*年?|最近|近\s*半\s*个?月|(?:近|过去|前)\s*[零〇一二两三四五六七八九十百\d]+\s*(?:年|个?月|周|天|日)|(?:今年|去年|前年|本年|上半年|下半年|这学期|本学期|上学期|去年同期)/u.test(value);
}

function currentLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseLocalCount(text: string): number | null {
  const value = normalizeText(text);
  if (!value) return null;
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (value === '半') return null;
  if (![...value].every((character) => CHINESE_DIGITS[character] !== undefined || character === '十' || character === '百')) return null;
  if (!/[十百]/u.test(value)) {
    const parsed = Number([...value].map((character) => CHINESE_DIGITS[character]).join(''));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  let total = 0;
  let pending: number | null = null;
  let previousUnit = Infinity;
  for (const character of value) {
    if (CHINESE_DIGITS[character] !== undefined) {
      pending = CHINESE_DIGITS[character];
      continue;
    }
    const unit = character === '百' ? 100 : 10;
    if (unit >= previousUnit) return null;
    total += (pending ?? 1) * unit;
    pending = null;
    previousUnit = unit;
  }
  return total + (pending ?? 0);
}

function isoOf(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local relative-time ranges resolved on the device calendar; overrides model dates. */
export function localRelativeTimeRange(query: string, today: string = currentLocalDate()): TimeConstraint | null {
  const text = normalizeText(query);
  const [year, month, day] = today.split('-').map(Number);
  if (!year || !month || !day) return null;
  const end = new Date(year, month - 1, day);
  const range = (start: Date, expression: string): TimeConstraint => ({
    expression, startDate: isoOf(start), endDate: isoOf(end),
  });
  const daysAgo = (count: number) => new Date(year, month - 1, day - (count - 1));
  /** Month/year offsets clamp to the last day of the target month (月末/闰年). */
  const monthsAgo = (count: number) => {
    const target = new Date(year, month - 1 - count, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(day, lastDay));
  };

  const numbered = /(?<prefix>最近|近|过去)\s*(?<count>[零〇一二两三四五六七八九十百]+|\d+|半)\s*(?:个)?\s*(?<unit>天|日|周|月|年)/u.exec(text);
  if (numbered) {
    const { count: countText, unit } = numbered.groups as { prefix: string; count: string; unit: string };
    if (countText === '半' && unit === '月') return range(daysAgo(15), numbered[0]);
    const count = parseLocalCount(countText);
    if (!count || count < 1) return null;
    if (unit === '天' || unit === '日') return range(daysAgo(count), numbered[0]);
    if (unit === '周') return range(daysAgo(count * 7), numbered[0]);
    if (unit === '月') return range(monthsAgo(count), numbered[0]);
    return range(monthsAgo(count * 12), numbered[0]);
  }
  if (/最近/u.test(text)) return range(daysAgo(30), '最近');
  return null;
}

function validIsoDate(value: string | null): boolean {
  if (value === null) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function validateTimeRange(plan: ModelQueryPlan, query: string): void {
  const { expression, startDate, endDate } = plan.timeConstraint;
  const explicit = hasExplicitTimeConstraint(query);
  if (!validIsoDate(startDate)
    || !validIsoDate(endDate)
    || (startDate !== null && endDate !== null && startDate > endDate)
    || (!explicit && (startDate !== null || endDate !== null))
    || (explicit && startDate === null && endDate === null)) {
    throw new PlannerError('模型返回的时间范围无效');
  }
  if (!explicit && expression) plan.timeConstraint.expression = '';
}

function uniqueBy<T>(values: T[], keyOf: (v: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = keyOf(v);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function textList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return uniqueBy(values.map(normalizeText).filter(Boolean), folded);
}

function searchList(values: unknown): PlannedSearch[] {
  return uniqueBy(
    (Array.isArray(values) ? values : [])
      .map((item) => {
        if (typeof item === 'string') return { query: normalizeText(item), purpose: '', role: 'balanced' as const };
        const source = item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {};
        return {
          query: normalizeText(source.query),
          purpose: normalizeText(source.purpose),
          role: (source.role === 'precise' || source.role === 'balanced' || source.role === 'anchor'
            ? source.role
            : 'balanced') as QueryRole,
        };
      })
      .filter((item) => item.query),
    (item) => folded(item.query),
  );
}

function feedbackSearchList(
  values: unknown, judgments: Map<string, 0 | 1 | 2 | 3>, evidenceKeys: Set<string>,
): FeedbackSearch[] {
  const searches: FeedbackSearch[] = [];
  for (const item of Array.isArray(values) ? values : []) {
    if (!isRecord(item)) continue;
    const query = normalizeText(item.query);
    const purpose = normalizeText(item.purpose);
    const basis = item.basis;
    if (!query || (basis !== 'query' && basis !== 'evidence')) continue;
    const supportKeys = uniqueBy(
      (Array.isArray(item.support_keys) ? item.support_keys : [])
        .filter((key): key is string => typeof key === 'string')
        .map(normalizeText)
        .filter(Boolean),
      (key) => key,
    );
    if (basis === 'query') {
      if (!supportKeys.length) searches.push({ query, purpose, basis, supportKeys });
      continue;
    }
    if (supportKeys.length < 1 || supportKeys.length > 3
      || supportKeys.some((key) => !evidenceKeys.has(key) || !judgments.has(key))) continue;
    const grades = supportKeys.map((key) => judgments.get(key)!);
    if (grades.some((grade) => grade === 0)) continue;
    const hasStrongSupport = grades.some((grade) => grade === 2 || grade === 3);
    const clueOnly = !hasStrongSupport && item.clue_only === true;
    if (!hasStrongSupport && !clueOnly) continue;
    searches.push({ query, purpose, basis, supportKeys, clueOnly });
  }
  return uniqueBy(searches, (search) => folded(search.query));
}

const STOP_REASON_LIMIT = 160;

function stopQueryList(values: unknown, allowLegacyStrings = false): StopQuerySuggestion[] {
  const suggestions: StopQuerySuggestion[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(values) ? values : []) {
    const source = allowLegacyStrings && typeof item === 'string'
      ? { query: item, reason: '' }
      : isRecord(item) && typeof item.query === 'string' && typeof item.reason === 'string'
        ? item : null;
    if (!source) continue;
    const query = normalizeText(source.query);
    if (query.length > FEEDBACK_SEARCH_QUERY_LIMIT) continue;
    const reason = normalizeText(source.reason).slice(0, STOP_REASON_LIMIT);
    const key = folded(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ query, reason });
  }
  return suggestions;
}

export function normalizeModelPlan(raw: unknown): ModelQueryPlan {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const searches = searchList(source.searches);
  const requiredConcepts = uniqueBy(
    (Array.isArray(source.required_concepts) ? source.required_concepts : [])
      .map((item) => ({
        name: normalizeText((item as Record<string, unknown>)?.name),
        expressions: textList((item as Record<string, unknown>)?.expressions),
      }))
      .filter((item) => item.name && item.expressions.length),
    (item) => folded(item.name),
  );
  const rawTime = source.time_constraint && typeof source.time_constraint === 'object'
    ? (source.time_constraint as Record<string, unknown>)
    : {};
  return {
    summary: normalizeText(source.summary),
    searches,
    requiredConcepts,
    excludedTerms: textList(source.excluded_terms),
    timeConstraint: {
      expression: normalizeText(rawTime.expression),
      startDate: normalizeText(rawTime.start_date) || null,
      endDate: normalizeText(rawTime.end_date) || null,
    },
  };
}

export function normalizeFeedbackPlan(raw: unknown, validKeys?: Set<string>, evidenceKeys: Set<string> = validKeys ?? new Set()): FeedbackPlan {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const judgments = new Map<string, 0 | 1 | 2 | 3>();
  if (Array.isArray(source.judgments)) {
    for (const item of source.judgments) {
      if (!isRecord(item)) continue;
      const key = normalizeText(item.key);
      if (key && (!validKeys || validKeys.has(key))
        && (item.grade === 0 || item.grade === 1 || item.grade === 2 || item.grade === 3)) judgments.set(key, item.grade);
    }
  }
  const legacyStopQueries = stopQueryList(source.stop_suggestions, true);
  return {
    judgments: [...judgments].map(([key, grade]) => ({ key, grade })),
    newSearches: feedbackSearchList(source.new_searches, judgments, evidenceKeys),
    stopQueries: [...stopQueryList(source.stop_queries), ...legacyStopQueries]
      .filter((suggestion, index, all) => all.findIndex((item) => folded(item.query) === folded(suggestion.query)) === index),
    stopSuggestions: legacyStopQueries.map(({ query }) => query),
    shouldStop: source.should_stop === true,
    reasoning: normalizeText(source.reasoning),
  };
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new PlannerError('模型没有返回有效 JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertFeedbackShape(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)
    || !Array.isArray(value.judgments)
    || !Array.isArray(value.new_searches)
    || (value.stop_suggestions !== undefined && !Array.isArray(value.stop_suggestions))
    || (value.stop_queries !== undefined && !Array.isArray(value.stop_queries))
    || typeof value.should_stop !== 'boolean'
    || (value.reasoning !== undefined && typeof value.reasoning !== 'string')) {
    throw new PlannerError('模型返回的反馈计划结构无效');
  }
}

function modelPlanFromContent(content: string, query: string, today?: () => string): ModelQueryPlan {
  const plan = normalizeModelPlan(parseJson(content));
  if (!plan.summary) plan.summary = query;
  if (!plan.searches.length) throw new PlannerError('模型没有返回可用检索词');
  const local = localRelativeTimeRange(query, today?.());
  if (local) plan.timeConstraint = local;
  validateTimeRange(plan, query);
  return plan;
}

function isPureKeywordQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return normalized.length <= 40
    && !hasExplicitTimeConstraint(normalized)
    && /^[\p{L}\p{N}+#._-]+$/u.test(normalized)
    && !/^(?:帮我|请|查找|查询|搜索|找|想找|我要)/u.test(normalized)
    && !/(?:有没有|哪里|哪个|什么|怎么|如何|是否|能否|关于|有关|推荐|求助|谁|为何|为什么)/u.test(normalized)
    && !/(?:的|资料|讨论|帖子|相关|内容|信息)$/u.test(normalized);
}

function originalQueryFallback(query: string): ModelQueryPlan {
  const normalized = normalizeText(query);
  return {
    summary: `直接搜索原词：${normalized}`,
    searches: [{ query: normalized, purpose: '模型计划无效，直接使用用户原词', role: 'balanced' }],
    requiredConcepts: [],
    excludedTerms: [],
    timeConstraint: { expression: '', startDate: null, endDate: null },
    usedOriginalQueryFallback: true,
  };
}

function sourceInstructions(capabilities: SourceCapabilities): string {
  const surface = {
    title: '搜索接口仅匹配原生标题。检索词应贴近标题中的表达。',
    fulltext: '搜索接口匹配全文。检索词可以是正文中出现的表达，不要求出现在标题中。',
    mixed: '搜索接口匹配标题和正文。检索词应兼顾两者的表达。',
  } satisfies Record<SourceCapabilities['searchSurface'], string>;
  const syntax = {
    'plain-keyword': '只生成可直接提交的普通关键词，不使用布尔运算符或假设接口支持高级查询语法。',
    boolean: '接口支持布尔查询语法；仅在需要表达检索逻辑时使用布尔运算符，不假设支持其他高级语法。',
  } satisfies Record<SourceCapabilities['querySyntax'], string>;
  const titleKeywordSpacing = capabilities.searchSurface === 'title' && capabilities.querySyntax === 'plain-keyword'
    ? '\n组合检索词优先用空格分隔独立概念，例如“微积分 历年 试卷”，不要连写成“微积分历年试卷”。保留“微积分”“期末考试”“回忆卷”等完整词，不要逐字拆开；单个核心词无需空格。query 中的空格会原样提交给搜索接口，不只是界面排版。'
    : '';
  return `${surface[capabilities.searchSurface]}\n${syntax[capabilities.querySyntax]}${titleKeywordSpacing}`;
}

export function firstRoundSystemPrompt(capabilities: SourceCapabilities): string {
  return `你是搜索查询规划器。根据用户的自然语言查询生成 JSON 查询计划。

${sourceInstructions(capabilities)}
检索词应覆盖高信号原词、稳定简称、同义表达和有价值的精确组合。每个检索词都标记 role：precise 组合多个意图约束，balanced 保留部分约束，anchor 只保留稳定的核心实体或概念。不要机械拆分中文短语。不要假设你看过来源内容。用户消息中的 current_date 是扩展所在设备的当前日期，所有相对时间约束都必须据此换算为明确日期。
${capabilities.searchSurface === 'title' ? '标题来源的查询组合必须至少包含一个 anchor 和至少一个非 anchor。"求助"、"经验"、"帖子"、"有没有"等通用宽词不能作为 anchor。' : ''}

返回以下 JSON 对象，不要返回额外字段或解释文字：
{
  "summary": "对检索目标的简短解释",
  "searches": [{"query": "发送给搜索接口的检索词", "purpose": "这次检索补足什么", "role": "precise | balanced | anchor"}],
  "required_concepts": [{"name": "必须满足的概念", "expressions": ["检索内容中可能出现的表达"]}],
  "excluded_terms": ["命中后应降权的表达"],
  "time_constraint": {"expression": "用户原始时间约束", "start_date": "YYYY-MM-DD 或 null", "end_date": "YYYY-MM-DD 或 null"}
}`;
}

export function feedbackSystemPrompt(capabilities: SourceCapabilities, modelSearchNarrowingEnabled = true): string {
  const narrowingInstructions = modelSearchNarrowingEnabled
    ? '- should_stop 只建议关闭后续扩展，不会取消已入队首页或已知分页。若候选已饱和或不必再产生扩展词，返回 should_stop: true。'
    : '- 本次运行关闭了模型自动收窄：必须返回 should_stop: false 和 stop_queries: []。继续提出有价值的新检索词，但不要因为这条规则而在没有可执行任务时强行调用模型。';
  return `你是迭代检索的语义反馈规划器。
${sourceInstructions(capabilities)}
你会看到本检索波次选出的候选临时键、最多三个不同检索支持，以及白名单元数据（仅原生标题、发布时间、板块、回复数）。一次完成相关性判断、下一轮检索词和停止判断。
正文和命中片段不会提供给你。正文派生的显示标题也不会发送，反馈标题为空。没有原生标题时，只能依据查询、检索命中数和其他允许的元数据决定后续搜索；不得推测正文或声称从正文学习到了词汇。

规则：
- 给每个能判断的候选返回 0、1、2 或 3：3 明确高度相关，2 大概率相关，1 信息不足、部分相关或不确定，0 明确无关。拿不准时用 1。
- candidates 可以为空。没有候选或当前没有 grade 2/3 时，可以仅根据原始查询提出 query 依据的救援检索词，用同义语、上位词、缩短表达或概念拆分放宽召回。
- 只追加新检索词，或建议停止仍有 continuation 的已执行检索词；不得修改首轮确定的必须概念、排除词、时间约束。stop_queries 不是用户维护的停用词表，只控制本次运行的一个检索分支。
- 每条新检索词必须声明 basis。query 表示只根据原始查询放宽表达，support_keys 必须为空。evidence 表示从本轮候选的原生标题学习，必须提供 1 至 3 个去重 support_keys。支持集合只含 grade 1 时必须声明 clue_only: true；支持集合中有 grade 2/3 时按普通 evidence 扩展处理，即使同时包含 grade 1。grade 0 不能提供支持。
- evidence 检索词只能从支持候选的原生标题学习。板块可以帮助判断相关性，但不能作为新检索词的词汇来源。回复数不能单独提高 grade，也不能作为新检索词的词汇来源。
- clue_only 只声明 grade 1 候选提供下一跳线索。本地只核对支持关系、当前 grade 和原生标题可见性，不做标题子串、词元重叠或语义相似度校验。
- stop_queries 逐条填写 query 和简短 reason。只能建议已执行、当前仍有 continuation 的检索词；未执行、已耗尽、空白或重复检索词不要填写。reason 只用于本地诊断，不参与执行判断，也不会进入结果卡片。
${narrowingInstructions}
- 不要重复已执行过的检索词。

返回 JSON：
{
  "judgments": [{"key": "候选临时键", "grade": 0}],
  "new_searches": [{"query": "下一轮检索词", "purpose": "补足什么", "basis": "query | evidence", "support_keys": ["证据候选临时键"], "clue_only": false}],
  "stop_queries": [{"query": "已执行且仍有 continuation 的检索词", "reason": "停止原因"}],
  "should_stop": false,
  "reasoning": "一句话说明判断"
}`;
}

export function finalRerankSystemPrompt(): string {
  return `你是搜索结果的最终列表重排器。输入是用户的原始查询和一个小规模候选列表，其中只有运行内临时键、白名单元数据（原生标题、发布时间、板块、回复数）和检索事实（最多五个首见命中检索词、完整独立检索词数量、最佳来源位次）。
按查询意图返回候选的相对顺序，并只建议移除明确无关的候选。板块可以帮助判断查询意图。回复数只能在其他相关性信号接近时作为弱破同分信号，不能单独提高相关性。正文、回帖、命中片段、相关性等级、平台 ID、URL 和轮次都不会提供；正文派生标题为空时只能依据其他元数据和检索事实判断，不得推测正文。拿不准时保留。不要改写临时键。

返回 JSON：
{ "ordered_keys": ["按相关性排列的候选临时键"], "remove_keys": ["明确建议移除的候选临时键"] }`;
}

export type FeedbackInput = FeedbackRequestInput;

function feedbackMessagesForPayload(
  payload: ReturnType<typeof buildFeedbackPayload>, capabilities: SourceCapabilities, modelSearchNarrowingEnabled = true,
): { role: string; content: string }[] {
  return [
    { role: 'system', content: feedbackSystemPrompt(capabilities, modelSearchNarrowingEnabled) },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

export function buildFeedbackMessages(input: FeedbackInput, capabilities: SourceCapabilities, currentDate?: string, modelSearchNarrowingEnabled = true): { role: string; content: string }[] {
  return feedbackMessagesForPayload(buildFeedbackPayload(input, currentDate), capabilities, modelSearchNarrowingEnabled);
}

export class PlannerClient {
  constructor(
    private transport: PlannerTransport,
    private settings: ExtensionSettings,
    private readonly capabilities: SourceCapabilities,
    private readonly today: () => string = currentLocalDate,
  ) {}

  async planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const content = await this.transport.chatCompletions(this.settings, [
      { role: 'system', content: firstRoundSystemPrompt(this.capabilities) },
      { role: 'user', content: JSON.stringify({ query: query.trim(), current_date: this.today() }) },
    ], signal);
    try {
      return modelPlanFromContent(content, query, this.today);
    } catch (error) {
      if (error instanceof PlannerError && isPureKeywordQuery(query)) return originalQueryFallback(query);
      throw error;
    }
  }

  async planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    const payload = buildFeedbackPayload(input, this.today());
    const content = await this.transport.chatCompletions(this.settings, feedbackMessagesForPayload(payload, this.capabilities, this.settings.modelSearchNarrowingEnabled), signal);
    const raw = parseJson(content);
    assertFeedbackShape(raw);
    return normalizeFeedbackPlan(
      raw,
      new Set(payload.candidates.map((candidate) => candidate.key)),
      new Set(payload.candidates.filter((candidate) => candidate.title.trim()).map((candidate) => candidate.key)),
    );
  }

  async rerankResults(input: FinalRerankRequestInput, signal?: AbortSignal): Promise<FinalRerankPlan> {
    const content = await this.transport.chatCompletions(this.settings, [
      { role: 'system', content: finalRerankSystemPrompt() },
      { role: 'user', content: JSON.stringify(buildFinalRerankPayload(input)) },
    ], signal);
    const raw = parseJson(content);
    return normalizeFinalRerankPlan(raw, new Set(input.candidates.map((candidate) => candidate.key)));
  }
}
