import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceRegistry } from './source-registry';

afterEach(() => vi.unstubAllGlobals());

describe('source registry', () => {
  it('resolves supported pages and keeps authentication inside the adapter', async () => {
    const adapter = sourceRegistry.resolve('https://www.cc98.org/topic/1');
    expect(adapter?.id).toBe('cc98');
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(() => adapter!.createSession({ url: 'https://www.cc98.org/' })).toThrow('请先登录 CC98');
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'accessToken' ? 'str-Bearer synthetic' : null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[{"id":1,"title":"合成帖子"}]', {
      headers: { 'content-type': 'application/json' },
    })));
    const session = await adapter!.createSession({ url: 'https://www.cc98.org/' });
    expect((await session.search('测试', undefined)).hits[0].candidate.url).toBe('https://www.cc98.org/topic/1');
  });
  it.each(['https://www.cc98.org.evil.test/', 'http://www.cc98.org/', 'https://example.com/', 'invalid'])('ignores unsupported page %s', (url) => {
    expect(sourceRegistry.resolve(url)).toBeUndefined();
  });
});
