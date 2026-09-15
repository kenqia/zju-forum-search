import { SearchSessionError } from './search-session';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function readCc98AccessToken(storage: Pick<Storage, 'getItem'>): string | null {
  const expiration = storage.getItem('accessToken_expirationTime');
  if (expiration && Date.now() >= Number.parseInt(expiration, 10) * 1000) return null;
  const stored = storage.getItem('accessToken');
  if (!stored) return null;
  const token = stored.startsWith('str-') ? stored.slice(4) : stored;
  return /^Bearer\s+\S+$/iu.test(token) ? token : null;
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
      throw new SearchSessionError('无法连接 CC98，保留当前部分结果。');
    }
    if (response.status === 401) {
      throw new SearchSessionError('请先登录 CC98，然后刷新页面再试。', 'not_logged_in');
    }
    if (response.status === 403 || response.status === 429) {
      throw new SearchSessionError(`CC98 暂时限制了搜索请求（HTTP ${response.status}），保留当前部分结果。`, 'cc98_limited');
    }
    if (!response.ok) throw new SearchSessionError(`CC98 返回 HTTP ${response.status}，保留当前部分结果。`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) throw new SearchSessionError('CC98 返回内容不是 JSON，请刷新登录后重试。', 'not_logged_in');
    return response.json();
  }
}
