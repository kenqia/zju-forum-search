import type { ExtensionSettings, FeedbackPlan, FeedbackRequestInput, ModelQueryPlan, PlannedSearch } from './types';

export interface PlannerTransport {
  chatCompletions(settings: ExtensionSettings, messages: { role: string; content: string }[], signal?: AbortSignal): Promise<string>;
}

export type PlannerErrorCode = 'planner_failed' | 'model_timeout' | 'model_cancelled';

export class PlannerError extends Error {
  constructor(message: string, readonly code: PlannerErrorCode = 'planner_failed') {
    super(message);
  }
}

const TITLE_LIMIT = 80;
const FEEDBACK_CANDIDATE_LIMIT = 160;
export const FEEDBACK_METADATA_TOKEN_LIMIT = 4000;

export function normalizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

export function folded(value: unknown): string {
  return normalizeText(value).toLocaleLowerCase('zh-CN');
}

export function hasExplicitTimeConstraint(query: string): boolean {
  const value = normalizeText(query);
  return /(?:19|20)\d{2}\s*年?|(?:近|最近|过去|前)\s*[零〇一二两三四五六七八九十百\d]+\s*(?:年|个月|月|周|天)|(?:今年|去年|前年|本年|上半年|下半年|这学期|本学期|上学期|去年同期)/u.test(value);
}

function currentLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function modelPlanFromContent(content: string, query: string): ModelQueryPlan {
  const plan = normalizeModelPlan(parseJson(content));
  if (!plan.summary) plan.summary = query;
  if (!plan.searches.length) throw new PlannerError('模型没有返回可用检索词');
  validateTimeRange(plan, query);
  return plan;
}

function isPureKeywordQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return normalized.length <= 40
    && !hasExplicitTimeConstraint(normalized)
    && /^[\p{L}\p{N}+#._-]+$/u.test(normalized)
    && !/^(?:帮我|请|查找|查询|搜索|找|想找|我要)/u.test(normalized)
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

export const FIRST_ROUND_SYSTEM_PROMPT = `你是校园论坛关键词检索规划器。根据用户的自然语言查询生成 JSON 查询计划。

论坛搜索接口按关键词匹配主题帖标题。检索词应覆盖高信号原词、稳定简称、同义表达和有价值的精确组合。不要机械拆分中文短语。不要假设你看过论坛内容。用户消息中的 current_date 是扩展所在设备的当前日期，所有相对时间约束都必须据此换算为明确日期。

返回以下 JSON 对象，不要返回额外字段或解释文字：
{
  "summary": "对检索目标的简短解释",
  "searches": [{"query": "发送给论坛的检索词", "purpose": "这次检索补足什么"}],
  "required_concepts": [{"name": "必须满足的概念", "expressions": ["标题中可能出现的表达"]}],
  "excluded_terms": ["命中后应降权的表达"],
  "time_constraint": {"expression": "用户原始时间约束", "start_date": "YYYY-MM-DD 或 null", "end_date": "YYYY-MM-DD 或 null"}
}`;

export const FEEDBACK_SYSTEM_PROMPT = `你是校园论坛迭代检索的反馈规划器。你会看到上一轮搜索新发现的主题帖元数据（仅标题、作者、时间、板块、回复数），以及已执行检索词及其命中情况。据此学习论坛真实用语，产出下一轮检索词。

规则：
- 只追加新检索词或建议停用已执行且零命中的词；不得修改首轮确定的必须概念、排除词、时间约束。
- 学习标题中反复出现而你没想到的词汇（简称、行话、专有名词），转化为可执行检索词。
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

export type FeedbackInput = FeedbackRequestInput;

export function buildFeedbackMessages(input: FeedbackInput, currentDate?: string): { role: string; content: string }[] {
  const encoder = new TextEncoder();
  const payload = {
    query: input.query.slice(0, 500),
    ...(currentDate ? { current_date: currentDate } : {}),
    round: input.round,
    executed_searches: [] as { query: string; hitCount: number }[],
    new_candidates: [] as { title: string; author: string; board: string; time: string; reply_count: number }[],
  };
  for (const search of input.executedSearches.slice(0, 30)) {
    payload.executed_searches.push({ query: search.query.slice(0, 120), hitCount: search.hitCount });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_TOKEN_LIMIT) {
      payload.executed_searches.pop();
      break;
    }
  }
  for (const candidate of input.newCandidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    const approved = {
      title: candidate.title.slice(0, TITLE_LIMIT),
      author: candidate.author.slice(0, 80),
      board: candidate.board.slice(0, 80),
      time: candidate.time.slice(0, 40),
      reply_count: candidate.replyCount,
    };
    payload.new_candidates.push(approved);
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_TOKEN_LIMIT) {
      payload.new_candidates.pop();
      break;
    }
  }
  return [
    { role: 'system', content: FEEDBACK_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify(payload),
    },
  ];
}

export class PlannerClient {
  constructor(
    private transport: PlannerTransport,
    private settings: ExtensionSettings,
    private readonly today: () => string = currentLocalDate,
  ) {}

  async planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const content = await this.transport.chatCompletions(this.settings, [
      { role: 'system', content: FIRST_ROUND_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ query: query.trim(), current_date: this.today() }) },
    ], signal);
    try {
      return modelPlanFromContent(content, query);
    } catch (error) {
      if (error instanceof PlannerError && isPureKeywordQuery(query)) return originalQueryFallback(query);
      throw error;
    }
  }

  async planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    const content = await this.transport.chatCompletions(this.settings, buildFeedbackMessages(input, this.today()), signal);
    const raw = parseJson(content);
    assertFeedbackShape(raw);
    return normalizeFeedbackPlan(raw);
  }

  async planBlindExpansion(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const content = await this.transport.chatCompletions(this.settings, [
      { role: 'system', content: FIRST_ROUND_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          query: query.trim(),
          current_date: this.today(),
          note: '第一轮检索词全部没有命中。请放宽约束，换用更宽的同义表达、上位词和常见说法重新生成检索词。',
        }),
      },
    ], signal);
    return modelPlanFromContent(content, query);
  }
}
