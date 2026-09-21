import { describe, expect, it, vi } from 'vitest';

import { CC98_RATE_POLICY, Cc98Client, Cc98SourceSession, readCc98AccessToken } from './index';

describe('CC98 browser adapter', () => {
  it('allows the full user-configurable request range', () => {
    expect(CC98_RATE_POLICY.maxSearchCalls).toBe(100);
  });

  it('reads the current short-lived token without changing it', () => {
    const storage = {
      getItem: (key: string) => ({
        accessToken: 'str-Bearer fake-cc98-token',
        accessToken_expirationTime: String(Math.floor(Date.now() / 1000) + 60),
      })[key as 'accessToken' | 'accessToken_expirationTime'] ?? null,
    } as Storage;

    expect(readCc98AccessToken(storage)).toBe('Bearer fake-cc98-token');
  });

  it('uses the measured keyword/from/size API contract', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new Cc98Client('Bearer fake-cc98-token', fetch);

    await client.searchTopics('高数 资料', 20, 20);

    expect(fetch.mock.calls[0][0]).toBe('https://api.cc98.org/topic/search?keyword=%E9%AB%98%E6%95%B0+%E8%B5%84%E6%96%99&from=20&size=20');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: 'include',
      headers: { Authorization: 'Bearer fake-cc98-token', Accept: 'application/json' },
    });
  });

  it('turns expired login into the required Chinese stop reason', async () => {
    const client = new Cc98Client('Bearer fake-cc98-token', async () => new Response('{}', { status: 401 }));

    await expect(client.searchTopics('高数', 0, 20)).rejects.toMatchObject({
      code: 'not_logged_in',
      message: '请先登录 CC98，然后刷新页面再试。',
    });
  });
});


describe('CC98 source session contract', () => {
  it('preserves raw page positions and pagination when a page includes malformed entries', async () => {
    const items = Array.from({ length: 20 }, (_, index) => index === 0 ? null : { id: index, title: `主题 ${index}` });
    for (const payload of [items, { data: items }, { items }, { data: { items } }]) {
      const session = new Cc98SourceSession('Bearer synthetic', async () => new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      }));
      const page = await session.search('测试', undefined);
      expect(page.hits).toHaveLength(19);
      expect(page.hits[0]).toMatchObject({ candidate: { id: '1' }, position: 2 });
      expect(page.nextCursor).toBe('20');
      expect((await session.search('测试', page.nextCursor)).hits[0].position).toBe(22);
    }
  });

  it('advances offsets by the complete response length and rejects invalid offsets', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ id: index, title: `主题 ${index}` }));
    const session = new Cc98SourceSession('Bearer synthetic', async () => new Response(JSON.stringify(items), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(session.search('测试', undefined)).resolves.toMatchObject({ hits: { length: 25 }, nextCursor: '25' });
    await expect(session.search('测试', 'not-an-offset')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('continues every non-empty raw page, including a short page, and stops on an empty page', async () => {
    const payloads = [[{ id: 'first' }], []];
    const fetch = vi.fn(async (_input: string) => new Response(JSON.stringify(payloads.shift()), {
      headers: { 'content-type': 'application/json' },
    }));
    const session = new Cc98SourceSession('Bearer synthetic', fetch);

    const first = await session.search('测试', undefined);
    const second = await session.search('测试', first.nextCursor);

    expect(first.nextCursor).toBe('1');
    expect(second.nextCursor).toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cc98.org/topic/search?keyword=%E6%B5%8B%E8%AF%95&from=0&size=20',
      'https://api.cc98.org/topic/search?keyword=%E6%B5%8B%E8%AF%95&from=1&size=20',
    ]);
  });
});


describe('CC98 response errors', () => {
  it.each(['{', '{}', 'null'])('reports invalid JSON or envelopes as invalid_response: %s', async (body) => {
    const session = new Cc98SourceSession('Bearer synthetic', async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(session.search('测试', undefined)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('preserves cancellation raised while reading the response body', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    const response = new Response('[]', { headers: { 'content-type': 'application/json' } });
    response.json = async () => { throw abort; };
    const session = new Cc98SourceSession('Bearer synthetic', async () => response);
    await expect(session.search('测试', undefined)).rejects.toBe(abort);
  });
});


describe('CC98 transport failures', () => {
  it.each([[401, 'not_logged_in'], [403, 'rate_limited'], [429, 'rate_limited'], [500, 'network']] as const)(
    'maps HTTP %s to %s', async (status, code) => {
      const session = new Cc98SourceSession('Bearer synthetic', async () => new Response('{}', { status }));
      await expect(session.search('测试', undefined)).rejects.toMatchObject({ code });
    },
  );
  it('preserves AbortError identity from fetch even when it is not a DOMException', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const session = new Cc98SourceSession('Bearer synthetic', async () => { throw abort; });
    await expect(session.search('测试', undefined)).rejects.toBe(abort);
  });
  it('rejects expired or missing login material', () => {
    expect(readCc98AccessToken({ getItem: () => null })).toBeNull();
    expect(readCc98AccessToken({ getItem: (key) => key === 'accessToken_expirationTime' ? '1' : 'str-Bearer synthetic' })).toBeNull();
  });
});
