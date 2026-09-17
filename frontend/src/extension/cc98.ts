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
} from './types';
import { normalizeText } from './planner';

const PAGE_SIZE = 20;

export const CC98_RATE_POLICY: RatePolicy = {
  maxSearchCalls: 30,
  minRequestIntervalMs: 2000,
};

export const CC98_CAPABILITIES: SourceCapabilities = {
  searchSurface: 'title',
  querySyntax: 'plain-keyword',
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

function topicList(payload: unknown): Record<string, unknown>[] {
  const list = (value: unknown) => (Array.isArray(value) ? value : null);
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const source = payload as { data?: unknown; items?: unknown };
  const items = list(source.data) ?? list(source.items)
    ?? (source.data && typeof source.data === 'object' ? list((source.data as { items?: unknown }).items) : null)
    ?? [];
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

function hitShape(raw: Record<string, unknown>, position: number): SearchHit | null {
  const id = normalizeText(raw.id ?? raw.topicId ?? raw.topic_id);
  if (!id) return null;
  const rawUrl = normalizeText(raw.url ?? raw.link);
  const url = rawUrl.startsWith('https://www.cc98.org/') ? rawUrl : `https://www.cc98.org/topic/${encodeURIComponent(id)}`;
  const title = normalizeText(raw.title ?? raw.subject) || `主题 ${id}`;
  const section = normalizeText(raw.boardName ?? raw.board ?? raw.boardId);
  const publishedAt = normalizeText(raw.time ?? raw.postTime ?? raw.createTime);
  const author = normalizeText(raw.userName ?? raw.authorName ?? (raw.user as { name?: unknown } | undefined)?.name ?? raw.author);
  const replyCount = Number(raw.replyCount ?? raw.replies ?? 0) || 0;
  const candidate: Candidate = {
    sourceId: 'cc98', id, title, url,
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
    private readonly accessToken: string,
    private readonly fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async searchTopics(query: string, from: number, size: number, signal?: AbortSignal): Promise<unknown> {
    const parameters = new URLSearchParams({ keyword: query, from: String(from), size: String(size) });
    let response: Response;
    try {
      response = await this.fetch(`https://api.cc98.org/topic/search?${parameters}`, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal,
        headers: { Authorization: this.accessToken, Accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new SourceError('无法连接 CC98，保留当前部分结果。', 'network');
    }
    if (response.status === 401) {
      throw new SourceError('请先登录 CC98，然后刷新页面再试。', 'not_logged_in');
    }
    if (response.status === 403 || response.status === 429) {
      throw new SourceError(`CC98 暂时限制了搜索请求（HTTP ${response.status}），保留当前部分结果。`, 'rate_limited');
    }
    if (!response.ok) throw new SourceError(`CC98 返回 HTTP ${response.status}，保留当前部分结果。`, 'network');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) throw new SourceError('CC98 返回内容不是 JSON，请刷新登录后重试。', 'not_logged_in');
    return response.json();
  }
}

export class Cc98SourceSession implements SearchSourceSession {
  readonly sourceId = 'cc98';
  readonly ratePolicy = CC98_RATE_POLICY;
  readonly capabilities = CC98_CAPABILITIES;
  private readonly client: Cc98Client;

  constructor(accessToken: string, fetchFn?: FetchLike) {
    this.client = new Cc98Client(accessToken, fetchFn);
  }

  async search(query: string, cursor: string | undefined, signal?: AbortSignal): Promise<SearchPage> {
    const from = cursor ? Number.parseInt(cursor, 10) : 0;
    const payload = await this.client.searchTopics(query, from, PAGE_SIZE, signal);
    const items = topicList(payload);
    const hits = items
      .map((raw, index) => hitShape(raw, from + index + 1))
      .filter((hit): hit is SearchHit => hit !== null);
    return {
      hits,
      nextCursor: items.length === PAGE_SIZE ? String(from + PAGE_SIZE) : undefined,
    };
  }
}

export const cc98Adapter: SearchSourceAdapter = {
  id: 'cc98',
  capabilities: CC98_CAPABILITIES,
  ratePolicy: CC98_RATE_POLICY,
  pageMatches: ['*://www.cc98.org/*'],
  apiHosts: ['https://api.cc98.org/'],
  createSession(pageContext: PageContext): SearchSourceSession {
    void pageContext;
    const token = readCc98AccessToken(localStorage);
    if (!token) throw new SourceError('请先登录 CC98，然后刷新页面再试。', 'not_logged_in');
    return new Cc98SourceSession(token);
  },
};
