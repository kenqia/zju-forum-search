// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { createBackgroundPlanner, mountExtension, Terms, type RuntimeMessenger } from './content';
import type { SearchSnapshot } from './search-session';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor } from './types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('extension content UI', () => {
  it('labels zero-hit searches without showing learned-term audit metadata', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const snapshot: SearchSnapshot = {
      query: '计算机网络', phase: 'complete', round: 2, requestsMade: 3, plan: null,
      activeSearches: [], executedSearches: ['计算机网络', '计网'], inactiveSearches: ['计网'],
      learnedTerms: ['网络原理'], results: [], outOfRangeCount: 0, stopReason: 'model_stop', statusText: '完成',
    };

    await act(async () => {
      root.render(<Terms snapshot={snapshot} />);
    });

    expect(container.textContent).toContain('未命中检索词');
    expect(container.textContent).not.toContain('已停用');
    expect(container.textContent).not.toContain('学到的扩展词');
    expect(container.textContent).not.toContain('网络原理');
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

    await expect(createBackgroundPlanner(runtime).planFeedback({
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
