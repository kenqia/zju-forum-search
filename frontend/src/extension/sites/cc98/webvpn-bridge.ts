import { CC98_WEBVPN_API_BASE, WEBVPN_CANCEL_EVENT, WEBVPN_REQUEST_EVENT, WEBVPN_RESPONSE_EVENT } from './webvpn-protocol';

const REFILL_INTERVAL_MS = 2000;
const BURST_CAPACITY = 2;

const pending = new Map<string, AbortController>();
let availableRequests = BURST_CAPACITY;
let lastRefillAt = Date.now();
let authorization: string | null = null;
const originalFetch = window.fetch;

window.fetch = function captureCc98Authorization(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address, location.href);
    if (url.origin === 'https://api.cc98.org' || url.href.startsWith(`${CC98_WEBVPN_API_BASE}/`)) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      const candidate = headers.get('Authorization');
      if (candidate && /^Bearer\s+\S+$/i.test(candidate)) authorization = candidate;
    }
  } catch { /* Leave the site's request untouched. */ }
  return originalFetch.call(window, input, init);
};

document.addEventListener(WEBVPN_REQUEST_EVENT, async (event) => {
  let request: { id?: unknown; url?: unknown };
  try { request = JSON.parse((event as CustomEvent<string>).detail); } catch { return; }
  if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 128 || typeof request.url !== 'string') return;
  let url: URL;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== 'https://webvpn.zju.edu.cn' || url.pathname !== new URL(`${CC98_WEBVPN_API_BASE}/topic/search`).pathname) return;
  const keyword = url.searchParams.get('keyword');
  const from = url.searchParams.get('from');
  if ([...url.searchParams.keys()].sort().join(',') !== 'from,keyword,size'
    || !keyword?.trim() || keyword.length > 512
    || !/^\d+$/.test(from ?? '') || !Number.isSafeInteger(Number(from)) || Number(from) > 5000
    || url.searchParams.get('size') !== '20') return;

  const reply = (data: { status: number; contentType: string; body: string }) => document.dispatchEvent(new CustomEvent(WEBVPN_RESPONSE_EVENT, {
    detail: JSON.stringify({ id: request.id, ...data }),
  }));
  if (!authorization) {
    reply({ status: 401, contentType: 'application/json', body: '' });
    return;
  }
  if (pending.has(request.id)) return;
  const now = Date.now();
  availableRequests = Math.min(BURST_CAPACITY, availableRequests + Math.max(0, now - lastRefillAt) / REFILL_INTERVAL_MS);
  lastRefillAt = now;
  if (pending.size > 0 || availableRequests < 1) {
    reply({ status: 429, contentType: 'application/json', body: '' });
    return;
  }
  availableRequests -= 1;

  const controller = new AbortController();
  pending.set(request.id, controller);
  try {
    const response = await window.fetch(url.toString(), {
      method: 'GET', credentials: 'include', signal: controller.signal,
      headers: { Authorization: authorization, Accept: 'application/json' },
    });
    const body = await response.text();
    reply({ status: response.status, contentType: response.headers.get('content-type') ?? '', body });
  } catch {
    reply({ status: 503, contentType: 'application/json', body: '' });
  } finally {
    pending.delete(request.id);
  }
});

document.addEventListener(WEBVPN_CANCEL_EVENT, (event) => {
  const id = (event as CustomEvent<unknown>).detail;
  if (typeof id === 'string') pending.get(id)?.abort();
});
