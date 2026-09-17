import { normalizeText } from '../../text';
import { SourceError, type RatePolicy, type SearchHit, type SearchPage, type SearchSourceAdapter,
  type SearchSourceSession, type SourceCapabilities } from '../../types';
import { createDuoEnvelope } from './envelope';

const PAGE_SIZE = 20;
const SEARCH_API_ID = 'd15476adc9b4d5f46125c3d8c420c556';
const LOGIN_MESSAGE = '请先登录朵朵校友圈，然后刷新页面再试。';
const LIMIT_MESSAGE = '朵朵校友圈暂时限制了搜索请求，请在原站完成验证后再试，已有结果已保留。';

export const DUO_CAPABILITIES: SourceCapabilities = { searchSurface: 'fulltext', querySyntax: 'plain-keyword' };
// Initial policy from #18, not a measured server-side rate limit.
export const DUO_RATE_POLICY: RatePolicy = { maxSearchCalls: 30, minRequestIntervalMs: 500 };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface DuoOptions {
  fetch?: FetchLike;
  publicKey?: string;
  groupId?: number;
}
interface Cursor { page: number; timestamp?: string | number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value));
}

function isAbort(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
}

export function readDuoToken(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const stored: unknown = JSON.parse(storage.getItem('auth-store') ?? 'null');
    return record(stored) && typeof stored.token === 'string' && stored.token.trim() ? stored.token : null;
  } catch {
    return null;
  }
}

function parseCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined) return { page: 1 };
  try {
    const value: unknown = JSON.parse(cursor);
    if (record(value) && Number.isSafeInteger(value.page) && Number(value.page) >= 2 && scalar(value.timestamp)) {
      return { page: Number(value.page), timestamp: value.timestamp };
    }
  } catch { /* Report malformed cursors without including their contents. */ }
  throw new SourceError('朵朵分页游标无效，请重新搜索。', 'invalid_response');
}

function publishedAt(value: unknown): string | undefined {
  if (!scalar(value)) return undefined;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return typeof value === 'string' ? text : undefined;
  const numeric = Number(text);
  const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function toHit(raw: unknown, position: number): SearchHit | null {
  if (!record(raw) || !scalar(raw.sns_id) || typeof raw.content !== 'string') return null;
  const id = String(raw.sns_id).trim();
  const content = normalizeText(raw.content);
  const title = content.slice(0, 120) || `帖子 ${id}`;
  const author = typeof raw.nickname === 'string' ? normalizeText(raw.nickname) : undefined;
  const section = typeof raw.topicName === 'string' ? normalizeText(raw.topicName) : undefined;
  const time = publishedAt(raw.create_time);
  const count = scalar(raw.comment_count) ? Number(raw.comment_count) : NaN;
  const metadata = {
    ...(author && { author }), ...(section && { section }), ...(time && { publishedAt: time }),
    ...(Number.isSafeInteger(count) && count >= 0 && { replyCount: count }),
  };
  return {
    candidate: { sourceId: 'duo', id, title, titleOrigin: 'body-derived',
      url: `https://www.duoduo.link/a/${encodeURIComponent(id)}`, ...metadata },
    document: { title, ...metadata, snippet: content },
    position,
  };
}

export class DuoSourceSession implements SearchSourceSession {
  readonly sourceId = 'duo';
  readonly capabilities = DUO_CAPABILITIES;
  readonly ratePolicy = DUO_RATE_POLICY;
  private readonly fetch: FetchLike;

  constructor(private readonly token: string, private readonly options: DuoOptions = {}) {
    if (!token.trim()) throw new SourceError(LOGIN_MESSAGE, 'not_logged_in');
    if (options.groupId !== undefined && (!Number.isSafeInteger(options.groupId) || options.groupId < 0)) {
      throw new SourceError('朵朵圈层参数无效。', 'invalid_response');
    }
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async search(query: string, cursor: string | undefined, signal?: AbortSignal): Promise<SearchPage> {
    signal?.throwIfAborted();
    const { page, timestamp } = parseCursor(cursor);
    let envelope: Awaited<ReturnType<typeof createDuoEnvelope>>;
    try {
      envelope = await createDuoEnvelope({ api: SEARCH_API_ID, data: {
        keyword: query, page, limit: PAGE_SIZE, timestamp,
        // The public search client also omits group_id when group filtering is off.
        ...(this.options.groupId !== undefined && { group_id: this.options.groupId }),
        sort: 'hot_value', scene: 'searchResult',
      } }, this.options.publicKey);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new SourceError('无法创建朵朵搜索加密请求。', 'invalid_response');
    }
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetch('https://api.duoduo.link/api', {
        method: 'POST', credentials: 'omit', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ddtk: this.token },
        body: JSON.stringify(envelope.body),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      signal?.throwIfAborted();
      throw new SourceError('无法连接朵朵校友圈，已有结果已保留。', 'network');
    }
    if (response.status === 401) throw new SourceError(LOGIN_MESSAGE, 'not_logged_in');
    if (response.status === 429) throw new SourceError(LIMIT_MESSAGE, 'rate_limited');
    if (response.status === 403) throw new SourceError('没有权限访问朵朵搜索，请在原站确认访问权限。', 'permission_denied');
    if (!response.ok) throw new SourceError(`朵朵返回 HTTP ${response.status}，已有结果已保留。`, 'network');
    let payload: unknown;
    try {
      payload = await envelope.decrypt(await response.text());
    } catch (error) {
      if (isAbort(error)) throw error;
      signal?.throwIfAborted();
      throw new SourceError('朵朵返回了无法解密或解析的搜索结果。', 'invalid_response');
    }
    signal?.throwIfAborted();
    if (!record(payload)) throw new SourceError('朵朵搜索响应格式无效。', 'invalid_response');
    if (payload.status === 10000) throw new SourceError(LOGIN_MESSAGE, 'not_logged_in');
    if (payload.needCode === true || (record(payload.result) && payload.result.needCode === true)) {
      throw new SourceError(LIMIT_MESSAGE, 'rate_limited');
    }
    if (payload.status !== 0 || !record(payload.result) || !Array.isArray(payload.result.entry)) {
      throw new SourceError('朵朵搜索响应格式无效。', 'invalid_response');
    }
    const result = payload.result;
    const entries = result.entry as unknown[];
    const snapshot = timestamp ?? result.timestamp;
    const hasNext = entries.length >= PAGE_SIZE;
    if (hasNext && !scalar(snapshot)) throw new SourceError('朵朵搜索结果缺少分页快照。', 'invalid_response');
    return {
      hits: entries.map((entry, index) => toHit(entry, (page - 1) * PAGE_SIZE + index + 1))
        .filter((hit): hit is SearchHit => hit !== null),
      nextCursor: hasNext ? JSON.stringify({ page: page + 1, timestamp: snapshot }) : undefined,
    };
  }
}

export const duoAdapter: SearchSourceAdapter = {
  id: 'duo', capabilities: DUO_CAPABILITIES, ratePolicy: DUO_RATE_POLICY,
  pageMatches: ['https://www.duoduo.link/*'], apiHosts: ['https://api.duoduo.link/*'],
  createSession() {
    let token: string | null;
    try { token = readDuoToken(localStorage); } catch { token = null; }
    if (!token) throw new SourceError(LOGIN_MESSAGE, 'not_logged_in');
    return new DuoSourceSession(token);
  },
};
