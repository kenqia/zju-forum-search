import { afterEach, describe, expect, it, vi } from 'vitest';
import { DUO_RATE_POLICY, duoAdapter, readDuoToken, DuoSourceSession } from './index';
import { receiveEnvelope, testPublicKey } from './test-server';
import { createFeedbackInput } from '../../feedback-payload';
import { modelMetadata } from '../../model-metadata';

afterEach(() => vi.unstubAllGlobals());

describe('Duo login boundary', () => {
  it('allows the full user-configurable request range', () => {
    expect(DUO_RATE_POLICY.maxSearchCalls).toBe(100);
  });

  it.each([null, '{', 'null', '[]', '{}', '{"token":42}', '{"token":"  "}'])('rejects missing or malformed auth-store: %s', (stored) => {
    vi.stubGlobal('localStorage', { getItem: () => stored });
    expect(() => duoAdapter.createSession({ url: 'https://www.duoduo.link/' })).toThrow(expect.objectContaining({ code: 'not_logged_in' }));
  });

  it('reads only the token field without mutating storage', () => {
    const getItem = vi.fn(() => '{"token":"synthetic-ddtk","ignored":"unused"}');
    expect(readDuoToken({ getItem })).toBe('synthetic-ddtk');
    expect(getItem).toHaveBeenCalledExactlyOnceWith('auth-store');
  });

  it('reports blocked storage as a login error without exposing its contents', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('synthetic-private-message'); } });
    expect(() => duoAdapter.createSession({ url: 'https://www.duoduo.link/' })).toThrow(expect.objectContaining({ code: 'not_logged_in' }));
  });
});


function server(responses: unknown[]) {
  const requests: { api: string; data: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const receiver = receiveEnvelope(String(init?.body));
    requests.push(receiver.payload);
    return new Response(receiver.respond(responses.shift()));
  });
  return { requests, fetch, session: new DuoSourceSession('synthetic-ddtk', { fetch, publicKey: testPublicKey }) };
}
const entry = { sns_id: 'post/1', content: '仅供本地的正文'.repeat(30), nickname: '合成作者',
  create_time: '2026-09-18 12:00:00', topicName: '合成板块', comment_count: 3 };
const success = (entries: unknown[], timestamp: unknown = 123) => ({ status: 0, result: { entry: entries, timestamp, needCode: false } });

describe('Duo source session', () => {
  it('sends an encrypted search with ddtk and maps only approved candidate fields', async () => {
    const { session, fetch, requests } = server([success([entry])]);
    const controller = new AbortController();
    const page = await session.search('合成关键词', undefined, controller.signal);
    expect(fetch.mock.calls[0][0]).toBe('https://api.duoduo.link/api');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error',
      signal: controller.signal, headers: { 'Content-Type': 'application/json', ddtk: 'synthetic-ddtk' } });
    expect(requests).toEqual([{ api: 'd15476adc9b4d5f46125c3d8c420c556',
      data: { keyword: '合成关键词', page: 1, limit: 20, sort: 'hot_value', scene: 'searchResult' } }]);
    expect(String(fetch.mock.calls[0][1]?.body)).not.toContain('合成关键词');
    expect(page).toEqual({ nextCursor: undefined, hits: [{
      candidate: { sourceId: 'duo', id: 'post/1', url: 'https://www.duoduo.link/a/post%2F1',
        title: entry.content.slice(0, 120), titleOrigin: 'body-derived', author: '合成作者',
        publishedAt: '2026-09-18 12:00:00', section: '合成板块', replyCount: 3 },
      document: { title: entry.content.slice(0, 120), snippet: entry.content, author: '合成作者',
        publishedAt: '2026-09-18 12:00:00', section: '合成板块', replyCount: 3 }, position: 1,
    }] });
    const feedback = createFeedbackInput({
      query: '测试', executedSearches: [],
      candidates: page.hits.map((hit, index) => ({ key: `c${index}`, matchedQueries: ['测试'], ...modelMetadata(hit.candidate) })),
    });
    expect(feedback.candidates).toEqual([{ key: 'c0', matchedQueries: ['测试'], title: '', publishedAt: '2026-09-18 12:00:00', section: '合成板块', replyCount: 3 }]);
    expect(JSON.stringify(feedback)).not.toContain('仅供本地的正文');
  });

  it('preserves the first snapshot and raw positions across full pages with bad entries', async () => {
    const full = Array.from({ length: 20 }, (_, i) => i === 0 ? null : { ...entry, sns_id: i });
    const { session, requests } = server([success(full, 123), success(full, 999), success([entry], 888)]);
    const first = await session.search('测试', undefined);
    expect(first.hits).toHaveLength(19);
    expect(first.hits[0].position).toBe(2);
    expect(JSON.parse(first.nextCursor!)).toEqual({ page: 2, timestamp: 123 });
    const second = await session.search('测试', first.nextCursor);
    expect(second.hits[0].position).toBe(22);
    expect(JSON.parse(second.nextCursor!)).toEqual({ page: 3, timestamp: 123 });
    const third = await session.search('测试', second.nextCursor);
    expect(third.hits[0].position).toBe(41);
    expect(third.nextCursor).toBeUndefined();
    expect(requests.map((request) => request.data.timestamp)).toEqual([undefined, 123, 123]);
    expect(requests.map((request) => request.data.page)).toEqual([1, 2, 3]);
  });

  it('passes an explicitly supplied group without hardcoding a school', async () => {
    const { fetch, requests } = server([success([])]);
    await new DuoSourceSession('synthetic', { fetch, publicKey: testPublicKey, groupId: 7 }).search('测试', undefined);
    expect(requests[0].data.group_id).toBe(7);
  });

  it('normalizes numeric timestamps for local time filtering', async () => {
    const { session } = server([success([{ ...entry, create_time: 0 }, { ...entry, create_time: '1000000000000' }])]);
    const page = await session.search('测试', undefined);
    expect(page.hits.map((hit) => hit.candidate.publishedAt)).toEqual(['1970-01-01T00:00:00.000Z', '2001-09-09T01:46:40.000Z']);
  });

  it.each([
    [{ status: 10000, msg: 'synthetic-sensitive-detail' }, 'not_logged_in'],
    [{ status: 0, result: { needCode: true } }, 'rate_limited'],
    [{ status: 400, needCode: true }, 'rate_limited'],
    [{ status: 400, msg: 'synthetic-sensitive-detail' }, 'invalid_response'],
    [null, 'invalid_response'], [{ status: 0, result: {} }, 'invalid_response'],
    [{ status: 0, result: { entry: 'bad' } }, 'invalid_response'],
    [success(Array.from({ length: 20 }, () => entry), null), 'invalid_response'],
  ])('translates response %j into %s', async (response, code) => {
    const { session } = server([response]);
    await expect(session.search('测试', undefined)).rejects.toMatchObject({ code, message: expect.not.stringContaining('synthetic-sensitive-detail') });
  });

  it.each(['', 'bad', '{}', '{"page":0,"timestamp":1}', '{"page":2}', '{"page":2.5,"timestamp":1}'])('rejects invalid cursor before sending: %s', async (cursor) => {
    const { session, fetch } = server([]);
    await expect(session.search('测试', cursor)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'not_logged_in'], [403, 'permission_denied'], [429, 'rate_limited'], [500, 'network']] as const)('translates HTTP %s', async (status, code) => {
    const session = new DuoSourceSession('synthetic', { publicKey: testPublicKey, fetch: async () => new Response('', { status }) });
    await expect(session.search('测试', undefined)).rejects.toMatchObject({ code });
  });

  it('reports network and ciphertext errors without forwarding exception details', async () => {
    const network = new DuoSourceSession('synthetic', { publicKey: testPublicKey, fetch: async () => { throw new Error('synthetic-private'); } });
    await expect(network.search('测试', undefined)).rejects.toMatchObject({ code: 'network', message: expect.not.stringContaining('synthetic-private') });
    const corrupt = new DuoSourceSession('synthetic', { publicKey: testPublicKey, fetch: async () => new Response('bad ciphertext') });
    await expect(corrupt.search('测试', undefined)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('preserves AbortError identity from fetch and response-body reads', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    for (const fetch of [async () => { throw abort; }, async () => {
      const response = new Response(''); response.text = async () => { throw abort; }; return response;
    }]) {
      await expect(new DuoSourceSession('synthetic', { publicKey: testPublicKey, fetch }).search('测试', undefined)).rejects.toBe(abort);
    }
  });

  it('does not send when already cancelled', async () => {
    const { session, fetch } = server([]);
    const controller = new AbortController(); controller.abort();
    await expect(session.search('测试', undefined, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});
