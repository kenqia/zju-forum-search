// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { createBackgroundPlanner, mountExtension, ResultLists, SearchStatus, Terms, type RuntimeMessenger } from './content';
import type { SearchSnapshot } from './search-session';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor } from './types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('extension content UI', () => {
  it('forwards source capabilities for first-round and feedback requests', async () => {
    const capabilities = { searchSurface: 'fulltext', querySyntax: 'plain-keyword', resultOrdering: 'other' } as const;
    const requests: ExtensionRequest[] = [];
    const runtime: RuntimeMessenger = {
      send: async <Request extends ExtensionRequest>(message: Request) => {
        requests.push(message);
        return { ok: false, error: 'test response' };
      },
    };
    const planner = createBackgroundPlanner(runtime, capabilities);
    await expect(planner.planFirstRound('测试')).rejects.toThrow('test response');
    await expect(planner.planFeedback({ query: '测试', executedSearches: [], candidates: [] })).rejects.toThrow('test response');
    expect(requests.map((request) => request.type)).toEqual(['planner:first', 'planner:feedback']);
    expect(requests[1]).toMatchObject({ modelSearchNarrowingEnabled: false });
    for (const request of requests) expect(request).toMatchObject({ capabilities });
  });

  it('labels zero-hit searches without showing learned-term audit metadata', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const snapshot: SearchSnapshot = {
      query: '计算机网络', phase: 'complete', round: 2, requestsMade: 3, plan: {
        summary: '直接搜索原词：计算机网络', searches: [{ query: '计算机网络', purpose: '' }],
        requiredConcepts: [], excludedTerms: [], timeConstraint: { expression: '', startDate: null, endDate: null },
        usedOriginalQueryFallback: true,
      },
      activeSearches: [], executedSearches: ['计算机网络', '计网'], inactiveSearches: ['计网'],
      results: [], outOfRangeCount: 0,
      softIsolatedResults: [],
      planningNotice: '模型计划无效，已直接搜索原词。', stopReason: 'model_stop', statusText: '完成', finalRerank: 'idle',
    };

    await act(async () => {
      root.render(<Terms snapshot={snapshot} />);
    });

    expect(container.textContent).toContain('未命中检索词');
    expect(container.textContent).not.toContain('已停用');
    expect(container.textContent).not.toContain('学到的扩展词');
    expect(container.textContent).not.toContain('网络原理');
    expect(container.textContent).toContain('模型计划无效，已直接搜索原词。');
    expect(container.querySelectorAll('.chip-marker')).toHaveLength(0);
    expect([...container.querySelectorAll('.chip')].map((chip) => chip.textContent)).toEqual([
      '计算机网络', '计算机网络', '计网', '计网',
    ]);
    await act(async () => root.unmount());
  });

  it('shows the exact search terms sent to the source without adding markers', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const snapshot: SearchSnapshot = {
      query: '98关键词搜索讨论', phase: 'complete', round: 1, requestsMade: 1,
      plan: {
        summary: '', searches: [{ query: '98关键词搜索', purpose: '' }],
        requiredConcepts: [], excludedTerms: [], timeConstraint: { expression: '', startDate: null, endDate: null },
      },
      activeSearches: [], executedSearches: ['98搜索bug'], inactiveSearches: [],
      results: [], softIsolatedResults: [], outOfRangeCount: 0,
      planningNotice: '', stopReason: 'model_stop', statusText: '完成', finalRerank: 'idle',
    };

    await act(async () => root.render(<Terms snapshot={snapshot} />));
    expect([...container.querySelectorAll('.chip')].map((chip) => chip.textContent)).toEqual([
      '98关键词搜索', '98搜索bug',
    ]);
    expect(container.textContent).not.toContain('•');
    expect(snapshot.plan?.searches[0].query).toBe('98关键词搜索');
    await act(async () => root.unmount());
  });

  it('turns a feedback timeout into a partial-result stop reason', async () => {
    const runtime: RuntimeMessenger = {
      send: async <Request extends ExtensionRequest>(_message: Request) => ({
        ok: false,
        error: '模型调用超过 20 秒',
        code: 'model_timeout',
      } as ExtensionResponseFor<Request>),
    };

    await expect(createBackgroundPlanner(runtime, { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' }).planFeedback({
      query: '高数', executedSearches: [], candidates: [],
    })).rejects.toMatchObject({
      reason: 'model_timeout',
      message: '反馈模型调用超过 20 秒，已保留当前结果。',
    });
  });

  it('呈现最终列表重排的进行中、成功和失败状态', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const base: SearchSnapshot = {
      query: '资料', phase: 'reranking', round: 1, requestsMade: 1, plan: null,
      activeSearches: [], executedSearches: [], inactiveSearches: [], results: [],
      softIsolatedResults: [],
      outOfRangeCount: 0, planningNotice: '', stopReason: null,
      statusText: '正在重排本地预排序前 30 条结果…', finalRerank: 'running',
    };

    await act(async () => root.render(<SearchStatus snapshot={base} running onStop={vi.fn()} />));
    expect(container.textContent).toContain('正在重排本地预排序前 30 条结果');
    expect(container.querySelector('.run-actions button')?.textContent).toBe('取消最终列表重排');
    expect(container.textContent).not.toContain('停止并查看结果');

    await act(async () => root.render(<SearchStatus snapshot={{ ...base, phase: 'complete', stopReason: 'model_stop', finalRerank: 'done', statusText: '模型停止。最终列表重排完成。' }} running={false} onStop={vi.fn()} />));
    expect(container.textContent).toContain('最终列表重排完成');

    await act(async () => root.render(<SearchStatus snapshot={{ ...base, phase: 'complete', stopReason: 'model_stop', finalRerank: 'failed', statusText: '最终列表重排未完成。' }} running={false} onStop={vi.fn()} />));
    expect(container.querySelector('.status-row.error')?.textContent).toContain('最终列表重排未完成');
    await act(async () => root.unmount());
  });

  it('在折叠区域呈现相关性等级 0 候选及普通原帖链接', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const topic = { id: 'hidden', title: '可能误判的资料', board: '学习天地', time: '2026-09-20', author: '', replyCount: 2, url: 'https://www.cc98.org/topic/hidden', firstRound: 1 };
    await act(async () => root.render(<ResultLists results={[]} softIsolatedResults={[topic]} outOfRangeCount={0} emptyText="暂无" />));

    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('已隐藏 1 个低相关结果');
    expect(details?.querySelector('a')?.getAttribute('href')).toBe(topic.url);
    expect(details?.textContent).not.toContain('grade');
    await act(async () => root.unmount());
  });

  it('shows separate result counts without exposing local presorting signals on ordinary cards', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const active = { id: 'active', title: '高数资料', board: '学习天地', time: '2026-09-20', author: '本地作者', replyCount: 2, url: 'https://www.cc98.org/topic/active', firstRound: 3 };
    const isolated = { ...active, id: 'isolated', title: '无关资料', url: 'https://www.cc98.org/topic/isolated' };

    await act(async () => root.render(<ResultLists
      results={[active]}
      softIsolatedResults={[isolated]}
      outOfRangeCount={2}
      emptyText="暂无"
    />));

    expect(container.querySelector('.result-counts')?.textContent).toBe('1 个结果 · 1 个已隐藏 · 2 个超出时间范围');
    const activeCard = container.querySelector('.result');
    expect(activeCard?.textContent).toContain('高数资料');
    expect(activeCard?.textContent).toContain('本地作者');
    expect(activeCard?.textContent).not.toContain('首次命中');
    expect(activeCard?.textContent).not.toMatch(/等级|得分|检索词|排序原因|判断历史/u);
    await act(async () => root.unmount());
  });

  it('mounts in Shadow DOM and toggles Scheme A without exposing the API key to page DOM', async () => {
    vi.stubGlobal('CSS', { supports: (property: string, value: string) => property === '-webkit-text-security' && value === 'disc' });
    let requestOpen: (() => void) | undefined;
    const runtime: RuntimeMessenger = {
      send: async <Request extends ExtensionRequest>(_message: Request) => ({
        ok: true,
        settings: { ...DEFAULT_SETTINGS, llmApiKey: '', hasApiKey: true },
      } as ExtensionResponseFor<Request>),
      onOpenRequested: (listener) => {
        requestOpen = listener;
        return () => { requestOpen = undefined; };
      },
    };
    let mounted: ReturnType<typeof mountExtension>;
    await act(async () => {
      mounted = mountExtension(document, runtime, 'open');
    });
    const root = mounted!.shadowRoot;

    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(root.querySelector('[aria-label="社区自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      (root.querySelector('[aria-label="打开自然语言搜索"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="社区自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('false');
    expect((root.querySelector('[aria-label="自然语言查询"]') as HTMLInputElement).placeholder).toBe('找课程、老师、资料或校园讨论…');
    expect(root.textContent).toContain('作者只在本地结果卡片显示，不会发送给模型');

    await act(async () => {
      (root.querySelector('[data-tab="settings"]') as HTMLButtonElement).click();
    });
    const apiKeyInput = root.querySelector('.api-key-input') as HTMLInputElement;
    expect(apiKeyInput.type).toBe('text');
    expect(apiKeyInput.autocomplete).toBe('off');
    expect(apiKeyInput.getAttribute('spellcheck')).toBe('false');
    expect(apiKeyInput.value).toBe('');
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.textContent).toContain('如尚未授权，浏览器会询问是否允许扩展访问该模型主机');
    expect(root.textContent).toContain('站点请求上限');
    expect(root.textContent).not.toContain('检索时长');
    expect(root.textContent).toContain('包括分页');
    const narrowing = root.querySelector('[role="switch"][aria-labelledby="model-search-narrowing-title"]') as HTMLElement;
    const finalRerank = root.querySelector('[role="switch"][aria-labelledby="final-rerank-title"]') as HTMLElement;
    expect(narrowing.hasAttribute('data-checked')).toBe(false);
    expect(narrowing.parentElement?.textContent).toContain('允许模型提前收窄搜索范围');
    expect(narrowing.parentElement?.textContent).toContain('更多站点请求');
    expect(root.querySelector('.switch-setting')?.textContent).toContain('允许模型提前收窄搜索范围');
    const finalRerankTopM = root.querySelector('input[aria-label="最终列表重排 Top-M"]') as HTMLInputElement;
    expect(finalRerank.hasAttribute('data-checked')).toBe(true);
    expect(finalRerank.getAttribute('aria-labelledby')).toBe('final-rerank-title');
    expect(finalRerank.getAttribute('aria-describedby')).toBe('final-rerank-description');
    expect(finalRerank.parentElement?.textContent).toContain('搜索完成后优化结果顺序');
    expect(finalRerank.parentElement?.textContent).toContain('调整前排顺序');
    expect(finalRerankTopM.value).toBe('30');
    expect(finalRerankTopM.disabled).toBe(false);
    await act(async () => finalRerank.click());
    expect(finalRerankTopM.disabled).toBe(true);
    expect(finalRerankTopM.value).toBe('30');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      (root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="社区自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => requestOpen?.());
    expect(root.querySelector('[aria-label="社区自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('false');
    vi.unstubAllGlobals();
  });
});


describe('registered source UI', () => {
  it.each([['https://www.cc98.org/', '请先登录 CC98，然后刷新页面再试。'], ['https://www.duoduo.link/', '请先登录朵朵校友圈，然后刷新页面再试。']])('shows the login prompt on %s without calling the model', async (url, message) => {
    vi.stubGlobal('location', new URL(url));
    vi.stubGlobal('localStorage', { getItem: () => null });
    const messages: string[] = [];
    const runtime: RuntimeMessenger = {
      send: async <Request extends ExtensionRequest>(message: Request) => {
        messages.push(message.type);
        return { ok: true, settings: DEFAULT_SETTINGS } as ExtensionResponseFor<Request>;
      },
    };
    // Use a separate document so prior mounts cannot affect this interaction.
    const page = document.implementation.createHTMLDocument();
    let mounted: ReturnType<typeof mountExtension>;
    try {
      await act(async () => { mounted = mountExtension(page, runtime, 'open'); });
      const root = mounted!.shadowRoot;
      const input = root.querySelector('[aria-label="自然语言查询"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '测试');
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      });
      await act(async () => {
        root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(root.textContent).toContain(message);
      expect(messages).toEqual(['settings:get']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
