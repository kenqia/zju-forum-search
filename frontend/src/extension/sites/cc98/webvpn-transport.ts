const REQUEST_EVENT = 'zju-forum-search:webvpn-request';
const RESPONSE_EVENT = 'zju-forum-search:webvpn-response';
const CANCEL_EVENT = 'zju-forum-search:webvpn-cancel';
const RESPONSE_TIMEOUT_MS = 25_000;

export function webVpnFetch(input: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException('请求已取消', 'AbortError'));
      return;
    }

    const cleanup = () => {
      clearTimeout(timeout);
      document.removeEventListener(RESPONSE_EVENT, onResponse);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      document.dispatchEvent(new CustomEvent(CANCEL_EVENT, { detail: id }));
      cleanup();
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    const onResponse = (event: Event) => {
      let response: { id?: unknown; status?: unknown; contentType?: unknown; body?: unknown };
      try { response = JSON.parse((event as CustomEvent<string>).detail); } catch { return; }
      if (response.id !== id) return;
      cleanup();
      if (typeof response.status !== 'number' || typeof response.body !== 'string') {
        reject(new Error('WebVPN 搜索响应无效'));
        return;
      }
      resolve(new Response(response.body, {
        status: response.status,
        headers: { 'content-type': typeof response.contentType === 'string' ? response.contentType : '' },
      }));
    };
    const timeout = setTimeout(() => {
      document.dispatchEvent(new CustomEvent(CANCEL_EVENT, { detail: id }));
      cleanup();
      reject(new Error('WebVPN 搜索超时'));
    }, RESPONSE_TIMEOUT_MS);
    document.addEventListener(RESPONSE_EVENT, onResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: JSON.stringify({ id, url: input }) }));
  });
}
