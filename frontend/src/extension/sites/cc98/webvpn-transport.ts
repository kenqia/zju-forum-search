import { WEBVPN_CANCEL_EVENT, WEBVPN_REQUEST_EVENT, WEBVPN_RESPONSE_EVENT } from './webvpn-protocol';

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
      document.removeEventListener(WEBVPN_RESPONSE_EVENT, onResponse);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      document.dispatchEvent(new CustomEvent(WEBVPN_CANCEL_EVENT, { detail: id }));
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
      document.dispatchEvent(new CustomEvent(WEBVPN_CANCEL_EVENT, { detail: id }));
      cleanup();
      reject(new Error('WebVPN 搜索超时'));
    }, RESPONSE_TIMEOUT_MS);
    document.addEventListener(WEBVPN_RESPONSE_EVENT, onResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
    document.dispatchEvent(new CustomEvent(WEBVPN_REQUEST_EVENT, { detail: JSON.stringify({ id, url: input }) }));
  });
}
