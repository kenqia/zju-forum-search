// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { createBackgroundPlanner, mountExtension, ResultLists, SearchStatus, Terms, type RuntimeMessenger } from './content';
import type { SearchSnapshot } from './search-session';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor } from './types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('extension content UI', () => {
  it('forwards source capabilities for first, blind, and feedback requests', async () => {
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
    await expect(planner.planBlindExpansion('测试')).rejects.toThrow('test response');
    await expect(planner.planFeedback({ query: '测试', executedSearches: [], candidates: [] })).rejects.toThrow('test response');
    expect(requests.map((request) => request.type)).toEqual(['planner:first', 'planner:blind', 'planner:feedback']);
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
      learnedTerms: ['网络原理'], results: [], outOfRangeCount: 0,
      softIsolatedResults: [],
      planningNotice: '模型计划无效，已直接搜索原词。', stopReason: 'model_stop', statusText: '完成', screening: 'idle',
    };

    await act(async () => {
      root.render(<Terms snapshot={snapshot} />);
    });

    expect(container.textContent).toContain('未命中检索词');
    expect(container.textContent).not.toContain('已停用');
    expect(container.textContent).not.toContain('学到的扩展词');
    expect(container.textContent).not.toContain('网络原理');
    expect(container.textContent).toContain('模型计划无效，已直接搜索原词。');
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

  it('renders screening progress, success, and failure states', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const base: SearchSnapshot = {
      query: '资料', phase: 'screening', round: 1, requestsMade: 1, plan: null,
      activeSearches: [], executedSearches: [], inactiveSearches: [], learnedTerms: [], results: [],
      softIsolatedResults: [],
      outOfRangeCount: 0, planningNotice: '', stopReason: null,
      statusText: '已完成 2/7 批候选筛选。全部成功后统一应用结果…', screening: 'running',
    };

    await act(async () => root.render(<SearchStatus snapshot={base} running onStop={vi.fn()} />));
    expect(container.textContent).toContain('已完成 2/7 批候选筛选');
    expect(container.textContent).toContain('全部成功后统一应用结果');

    await act(async () => root.render(<SearchStatus snapshot={{ ...base, phase: 'complete', stopReason: 'model_stop', screening: 'done', statusText: '模型停止。意图筛选完成。' }} running={false} onStop={vi.fn()} />));
    expect(container.textContent).toContain('意图筛选完成');

    await act(async () => root.render(<SearchStatus snapshot={{ ...base, phase: 'complete', stopReason: 'model_stop', screening: 'failed', statusText: '意图筛选未完成。' }} running={false} onStop={vi.fn()} />));
    expect(container.querySelector('.status.error')?.textContent).toContain('意图筛选未完成');
    await act(async () => root.unmount());
  });

  it('renders grade 0 candidates in a collapsed section with ordinary original-post links', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const topic = { id: 'hidden', title: '可能误判的资料', board: '学习天地', time: '2026-09-20', author: '', replyCount: 2, url: 'https://www.cc98.org/topic/hidden', firstRound: 1 };
    await act(async () => root.render(<ResultLists results={[]} softIsolatedResults={[topic]} emptyText="暂无" />));

    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('已隐藏的明确无关结果（1）');
    expect(details?.querySelector('a')?.getAttribute('href')).toBe(topic.url);
    expect(details?.textContent).not.toContain('grade');
    await act(async () => root.unmount());
  });

  it('mounts in Shadow DOM and toggles Scheme A without exposing the API key to page DOM', async () => {
    const runtime: RuntimeMessenger = {
      send: async <Request extends ExtensionRequest>(_message: Request) => ({
        ok: true,
        settings: { ...DEFAULT_SETTINGS, llmApiKey: '', hasApiKey: true },
      } as ExtensionResponseFor<Request>),
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
    expect((root.querySelector('[aria-label="自然语言查询"]') as HTMLInputElement).placeholder).toBe('例如：找近两年的操作系统课程的讨论和资料');

    await act(async () => {
      (root.querySelector('[data-tab="settings"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('input[type="password"]')).not.toBeNull();
    expect((root.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    expect(root.textContent).toContain('站点检索请求次数上限');
    expect(root.textContent).not.toContain('检索时长');
    expect(root.textContent).toContain('包括分页');
    const intentFilter = root.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(intentFilter.checked).toBe(true);
    expect(intentFilter.getAttribute('aria-labelledby')).toBe('intent-filter-title');
    expect(intentFilter.getAttribute('aria-describedby')).toBe('intent-filter-description');
    expect(intentFilter.closest('label')?.textContent).toContain('最终意图筛选');
    expect(intentFilter.closest('label')?.textContent).toContain('按原始查询移除明显无关的结果');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      (root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="社区自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');
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
