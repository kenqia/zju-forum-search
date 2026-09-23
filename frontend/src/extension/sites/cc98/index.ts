import {
  SourceError,
  type Candidate,
  type PageContext,
  type RatePolicy,
  type SearchHit,
  type SearchPage,
  type SearchSourceAdapter,
  type SearchSourceSession,
  type SourceCapabilities,
} from '../../types';
import { normalizeText } from '../../text';
import { webVpnFetch } from './webvpn-transport';

const PAGE_SIZE = 20;
const CC98_API_BASE = 'https://api.cc98.org';
export const CC98_WEBVPN_PAGE_BASE = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab';
const CC98_WEBVPN_API_BASE = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab';

export const CC98_RATE_POLICY: RatePolicy = {
  maxSearchCalls: 100,
  minRequestIntervalMs: 2000,
};

export const CC98_CAPABILITIES: SourceCapabilities = {
  searchSurface: 'title',
  querySyntax: 'plain-keyword',
  resultOrdering: 'time-desc',
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function readCc98AccessToken(storage: Pick<Storage, 'getItem'>): string | null {
  const expiration = storage.getItem('accessToken_expirationTime');
  if (expiration && Date.now() >= Number.parseInt(expiration, 10) * 1000) return null;
  const stored = storage.getItem('accessToken');
  if (!stored) return null;
  const token = stored.startsWith('str-') ? stored.slice(4) : stored;
  return /^Bearer\s+\S+$/iu.test(token) ? token : null;
}

function topicList(payload: unknown): unknown[] {
  const list = (value: unknown) => (Array.isArray(value) ? value : null);
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') throw new SourceError('CC98 返回了无法识别的搜索结果。', 'invalid_response');
  const source = payload as { data?: unknown; items?: unknown };
  const items = list(source.data) ?? list(source.items)
    ?? (source.data && typeof source.data === 'object' ? list((source.data as { items?: unknown }).items) : null)
    ?? null;
  if (!items) throw new SourceError('CC98 返回了无法识别的搜索结果。', 'invalid_response');
  return items;
}

function toSearchHit(value: unknown, position: number, webVpn: boolean): SearchHit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeText(raw.id ?? raw.topicId ?? raw.topic_id);
  if (!id) return null;
  const rawUrl = normalizeText(raw.url ?? raw.link);
  const url = webVpn ? `${CC98_WEBVPN_PAGE_BASE}/topic/${encodeURIComponent(id)}`
    : rawUrl.startsWith('https://www.cc98.org/') ? rawUrl : `https://www.cc98.org/topic/${encodeURIComponent(id)}`;
  const title = normalizeText(raw.title ?? raw.subject) || `主题 ${id}`;
  const section = normalizeText(raw.boardName ?? raw.board ?? raw.boardId);
  const publishedAt = normalizeText(raw.time ?? raw.postTime ?? raw.createTime);
  const author = normalizeText(raw.userName ?? raw.authorName ?? (raw.user as { name?: unknown } | undefined)?.name ?? raw.author);
  const replyCount = Number(raw.replyCount ?? raw.replies ?? 0) || 0;
  const candidate: Candidate = {
    sourceId: 'cc98', id, title, titleOrigin: 'native', url,
    ...(author && { author }),
    ...(publishedAt && { publishedAt }),
    ...(section && { section }),
    ...(replyCount && { replyCount }),
  };
  return {
    candidate,
    document: { title, ...(section && { section }), ...(author && { author }), ...(publishedAt && { publishedAt }), ...(replyCount && { replyCount }) },
    position,
  };
}

export class Cc98Client {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
    private readonly apiBase = CC98_API_BASE,
  ) {}

  async searchTopics(query: string, from: number, size: number, signal?: AbortSignal): Promise<unknown> {
    const parameters = new URLSearchParams({ keyword: query, from: String(from), size: String(size) });
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBase}/topic/search?${parameters}`, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal,
        headers: { ...(this.accessToken && { Authorization: this.accessToken }), Accept: 'application/json' },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
      throw new SourceError('无法连接 CC98，保留当前部分结果。', 'network');
    }
    if (response.status === 401) {
      throw new SourceError(this.apiBase === CC98_WEBVPN_API_BASE
        ? '扩展未能复用 WebVPN 页面中的 CC98 登录态。请使用校园网或 RVPN 直连。'
        : '请先登录 CC98，然后刷新页面再试。', 'not_logged_in');
    }
    if (response.status === 403 || response.status === 429) {
      throw new SourceError(`CC98 暂时限制了搜索请求（HTTP ${response.status}），保留当前部分结果。`, 'rate_limited');
    }
    if (!response.ok) throw new SourceError(`CC98 返回 HTTP ${response.status}，保留当前部分结果。`, 'network');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) throw new SourceError('CC98 返回内容不是 JSON，请刷新登录后重试。', 'not_logged_in');
    try {
      return await response.json();
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
      throw new SourceError('CC98 返回了无法解析的 JSON。', 'invalid_response');
    }
  }
}

export class Cc98SourceSession implements SearchSourceSession {
  readonly sourceId = 'cc98';
  readonly ratePolicy = CC98_RATE_POLICY;
  readonly capabilities = CC98_CAPABILITIES;
  private readonly client: Cc98Client;

  constructor(accessToken: string | null, fetchFn?: FetchLike, private readonly webVpn = false) {
    this.client = new Cc98Client(accessToken, fetchFn, webVpn ? CC98_WEBVPN_API_BASE : CC98_API_BASE);
  }

  async search(query: string, cursor: string | undefined, signal?: AbortSignal): Promise<SearchPage> {
    if (cursor !== undefined && !/^\d+$/u.test(cursor)) {
      throw new SourceError('CC98 分页游标无效。', 'invalid_response');
    }
    const from = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(from) || from < 0) throw new SourceError('CC98 分页游标无效。', 'invalid_response');
    const payload = await this.client.searchTopics(query, from, PAGE_SIZE, signal);
    const items = topicList(payload);
    const hits = items
      .map((raw, index) => toSearchHit(raw, from + index + 1, this.webVpn))
      .filter((hit): hit is SearchHit => hit !== null);
    // Every non-empty raw page may have another page. Advance by the raw response
    // length so malformed records cannot overlap or skip offsets.
    return {
      hits,
      nextCursor: items.length > 0 ? String(from + items.length) : undefined,
    };
  }
}

export const cc98Adapter: SearchSourceAdapter = {
  id: 'cc98',
  capabilities: CC98_CAPABILITIES,
  ratePolicy: CC98_RATE_POLICY,
  pageMatches: ['https://www.cc98.org/*', `${CC98_WEBVPN_PAGE_BASE}/*`],
  apiHosts: ['https://api.cc98.org/*', 'https://webvpn.zju.edu.cn/*'],
  createSession(pageContext: PageContext): SearchSourceSession {
    if (pageContext.url.startsWith(`${CC98_WEBVPN_PAGE_BASE}/`)) {
      return new Cc98SourceSession(null, webVpnFetch, true);
    }
    const token = readCc98AccessToken(localStorage);
    if (!token) throw new SourceError('请先登录 CC98，然后刷新页面再试。', 'not_logged_in');
    return new Cc98SourceSession(token);
  },
};
