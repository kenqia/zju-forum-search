import { describe, expect, it, vi } from 'vitest';

import { Cc98Client, readCc98AccessToken } from './cc98';

describe('CC98 browser adapter', () => {
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
