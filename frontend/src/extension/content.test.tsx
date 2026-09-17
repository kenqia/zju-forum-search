// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { createBackgroundPlanner, mountExtension, Terms, type RuntimeMessenger } from './content';
import type { SearchSnapshot } from './search-session';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor } from './types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('extension content UI', () => {
  it('forwards source capabilities for first, blind, and feedback requests', async () => {
    const capabilities = { searchSurface: 'fulltext', querySyntax: 'plain-keyword' } as const;
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
    await expect(planner.planFeedback({ query: '测试', round: 1, executedSearches: [], newCandidates: [] })).rejects.toThrow('test response');
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
      planningNotice: '模型计划无效，已直接搜索原词。', stopReason: 'model_stop', statusText: '完成',
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

    await expect(createBackgroundPlanner(runtime, { searchSurface: 'title', querySyntax: 'plain-keyword' }).planFeedback({
      query: '高数', executedSearches: [], newCandidates: [], round: 1,
    })).rejects.toMatchObject({
      reason: 'model_timeout',
      message: '反馈模型调用超过 20 秒，已保留当前结果。',
    });
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
    expect(root.querySelector('[aria-label="CC98 自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      (root.querySelector('[aria-label="打开 CC98 自然语言搜索"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="CC98 自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('false');

    await act(async () => {
      (root.querySelector('[data-tab="settings"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('input[type="password"]')).not.toBeNull();
    expect((root.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    expect(root.textContent).toContain('CC98 检索时长（秒）');
    expect(root.textContent).toContain('模型每次最多等待 20 秒，不占用这段检索时长。');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      (root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="CC98 自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});


describe('registered source UI', () => {
  it('shows the adapter login prompt without calling the model', async () => {
    vi.stubGlobal('location', new URL('https://www.cc98.org/'));
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
      expect(root.textContent).toContain('请先登录 CC98，然后刷新页面再试。');
      expect(messages).toEqual(['settings:get']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
