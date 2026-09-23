// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

const apiUrl = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab/topic/search?keyword=test&from=0&size=20';

describe('CC98 WebVPN page bridge', () => {
  it('uses a page-observed authorization without putting it in DOM events', async () => {
    const previousFetch = window.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    Object.assign(window, { Headers, Request, fetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) });
    try {
      await import('./webvpn-bridge');
      const request = (id: string, url = apiUrl) => new Promise<string>((resolve) => {
        const onResponse = (event: Event) => {
          const detail = (event as CustomEvent<string>).detail;
          if (JSON.parse(detail).id !== id) return;
          document.removeEventListener('zju-forum-search:webvpn-response', onResponse);
          resolve(detail);
        };
        document.addEventListener('zju-forum-search:webvpn-response', onResponse);
        document.dispatchEvent(new CustomEvent('zju-forum-search:webvpn-request', {
          detail: JSON.stringify({ id, url }),
        }));
      });

      expect(JSON.parse(await request('missing'))).toMatchObject({ status: 401 });
      expect(calls).toHaveLength(0);

      await window.fetch('https://api.cc98.org/me', { headers: { Authorization: 'Bearer synthetic-only' } });
      for (const url of [apiUrl.replace('size=20', 'size=100'), apiUrl.replace('from=0', 'from=999999999999999999999')]) {
        document.dispatchEvent(new CustomEvent('zju-forum-search:webvpn-request', {
          detail: JSON.stringify({ id: 'invalid', url }),
        }));
      }
      expect(calls).toHaveLength(1);
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const response = await request('authorized');
      expect(JSON.parse(response)).toMatchObject({ status: 200, body: '[]' });
      expect(response).not.toContain('synthetic-only');
      expect(calls[1].url).toBe(apiUrl);
      expect(new Headers(calls[1].init?.headers).get('Authorization')).toBe('Bearer synthetic-only');
      expect(JSON.parse(await request('one-retry'))).toMatchObject({ status: 200 });
      expect(JSON.parse(await request('too-fast'))).toMatchObject({ status: 429 });
      expect(calls).toHaveLength(3);

      now.mockReturnValue(12_000);
      expect(JSON.parse(await request('next'))).toMatchObject({ status: 200 });
      expect(calls).toHaveLength(4);

      now.mockReturnValue(14_000);
      let releaseSlow!: (response: Response) => void;
      window.fetch = vi.fn(() => new Promise<Response>((resolve) => { releaseSlow = resolve; }));
      const slow = request('slow');
      expect(JSON.parse(await request('parallel'))).toMatchObject({ status: 429 });
      releaseSlow(new Response('[]', { headers: { 'content-type': 'application/json' } }));
      expect(JSON.parse(await slow)).toMatchObject({ status: 200 });
      expect(calls).toHaveLength(4);
    } finally {
      vi.restoreAllMocks();
      window.fetch = previousFetch;
    }
  });
});
