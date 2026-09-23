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
  it('resolves Duo pages without reading login material', () => {
    expect(sourceRegistry.resolve('https://www.duoduo.link/a/123')?.id).toBe('duo');
  });
  it('resolves only the CC98 WebVPN path', () => {
    const base = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab/';
    expect(sourceRegistry.resolve(base)?.id).toBe('cc98');
    expect(sourceRegistry.resolve(`${base}topic/123`)?.id).toBe('cc98');
    expect(sourceRegistry.resolve('https://webvpn.zju.edu.cn/login')).toBeUndefined();
    expect(sourceRegistry.resolve('https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab/')).toBeUndefined();
  });
  it.each(['https://www.duoduo.link.evil.test/', 'http://www.duoduo.link/', 'https://www.cc98.org.evil.test/', 'http://www.cc98.org/', 'https://example.com/', 'invalid'])('ignores unsupported page %s', (url) => {
    expect(sourceRegistry.resolve(url)).toBeUndefined();
  });
});
