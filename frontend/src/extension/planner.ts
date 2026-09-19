import { buildFeedbackPayload } from './feedback-payload';
import { folded, normalizeText } from './text';
import type { ExtensionSettings, FeedbackPlan, FeedbackRequestInput, ModelQueryPlan, PlannedSearch, SourceCapabilities, TimeConstraint } from './types';

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
  if (/^\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (value === '半') return null;
  if (value === '十') return 10;
  const parts = value.split('十');
  if (parts.length === 2 && parts.every((part) => part === '' || CHINESE_DIGITS[part] !== undefined)) {
    const tens = parts[0] === '' ? 1 : CHINESE_DIGITS[parts[0]];
    const ones = parts[1] === '' ? 0 : CHINESE_DIGITS[parts[1]];
    return tens * 10 + ones;
  }
  if (value.length === 1 && CHINESE_DIGITS[value] !== undefined) return CHINESE_DIGITS[value];
  return null;
}

function isoOf(date: Date): string {
  const year = date.getFullYear();
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
        if (typeof item === 'string') return { query: normalizeText(item), purpose: '' };
        const source = item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {};
        return {
          query: normalizeText(source.query),
          purpose: normalizeText(source.purpose),
        };
      })
      .filter((item) => item.query),
    (item) => folded(item.query),
  );
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

export function normalizeFeedbackPlan(raw: unknown): FeedbackPlan {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const newSearches = searchList(source.new_searches);
  return {
    newSearches,
    learnedTerms: textList(source.learned_terms),
    stopSuggestions: textList(source.stop_suggestions),
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
    || !Array.isArray(value.new_searches)
    || !value.new_searches.every((item) => isRecord(item) && typeof item.query === 'string' && typeof item.purpose === 'string')
    || !Array.isArray(value.learned_terms)
    || !value.learned_terms.every((term) => typeof term === 'string')
    || !Array.isArray(value.stop_suggestions)
    || !value.stop_suggestions.every((term) => typeof term === 'string')
    || typeof value.should_stop !== 'boolean'
    || typeof value.reasoning !== 'string') {
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
    searches: [{ query: normalized, purpose: '模型计划无效，直接使用用户原词' }],
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
  return `${surface[capabilities.searchSurface]}\n${syntax[capabilities.querySyntax]}`;
}

export function firstRoundSystemPrompt(capabilities: SourceCapabilities): string {
  return `你是搜索查询规划器。根据用户的自然语言查询生成 JSON 查询计划。

${sourceInstructions(capabilities)}
检索词应覆盖高信号原词、稳定简称、同义表达和有价值的精确组合。不要机械拆分中文短语。不要假设你看过来源内容。用户消息中的 current_date 是扩展所在设备的当前日期，所有相对时间约束都必须据此换算为明确日期。

返回以下 JSON 对象，不要返回额外字段或解释文字：
{
  "summary": "对检索目标的简短解释",
  "searches": [{"query": "发送给搜索接口的检索词", "purpose": "这次检索补足什么"}],
  "required_concepts": [{"name": "必须满足的概念", "expressions": ["检索内容中可能出现的表达"]}],
  "excluded_terms": ["命中后应降权的表达"],
  "time_constraint": {"expression": "用户原始时间约束", "start_date": "YYYY-MM-DD 或 null", "end_date": "YYYY-MM-DD 或 null"}
}`;
}

export function feedbackSystemPrompt(capabilities: SourceCapabilities): string {
  return `你是迭代检索的反馈规划器。
${sourceInstructions(capabilities)}
你会看到上一轮搜索新发现的候选元数据（仅原生标题、作者、发布时间、板块、回复数），以及已执行检索词及其命中情况。据此产出下一轮检索词。
正文和命中片段不会提供给你。正文派生的显示标题也不会发送，反馈标题为空。没有原生标题时，只能依据查询、检索命中数和其他允许的元数据决定后续搜索；不得推测正文或声称从正文学习到了词汇。

规则：
- 只追加新检索词或建议停用已执行且零命中的词；不得修改首轮确定的必须概念、排除词、时间约束。
- 仅当提供非空原生标题时，学习其中反复出现而你没想到的词汇（简称、行话、专有名词），转化为可执行检索词。
- 若候选已饱和或继续搜索价值低，返回 should_stop: true。
- 不要重复已执行过的检索词。

返回 JSON：
{
  "new_searches": [{"query": "下一轮检索词", "purpose": "补足什么"}],
  "learned_terms": ["从标题学到的词汇"],
  "stop_suggestions": ["建议停用的已执行检索词"],
  "should_stop": false,
  "reasoning": "一句话说明判断"
}`;
}

export type FeedbackInput = FeedbackRequestInput;

export function buildFeedbackMessages(input: FeedbackInput, capabilities: SourceCapabilities, currentDate?: string): { role: string; content: string }[] {
  return [
    { role: 'system', content: feedbackSystemPrompt(capabilities) },
    { role: 'user', content: JSON.stringify(buildFeedbackPayload(input, currentDate)) },
  ];
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
    const content = await this.transport.chatCompletions(this.settings, buildFeedbackMessages(input, this.capabilities, this.today()), signal);
    const raw = parseJson(content);
    assertFeedbackShape(raw);
    return normalizeFeedbackPlan(raw);
  }

  async planBlindExpansion(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const content = await this.transport.chatCompletions(this.settings, [
      { role: 'system', content: firstRoundSystemPrompt(this.capabilities) },
      {
        role: 'user',
        content: JSON.stringify({
          query: query.trim(),
          current_date: this.today(),
          note: '第一轮检索词全部没有命中。请放宽约束，换用更宽的同义表达、上位词和常见说法重新生成检索词。',
        }),
      },
    ], signal);
    return modelPlanFromContent(content, query, this.today);
  }
}
