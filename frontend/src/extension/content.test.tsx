// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountExtension, type RuntimeMessenger } from './content';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor } from './types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('extension content UI', () => {
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
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      (root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click();
    });
    expect(root.querySelector('[aria-label="CC98 自然语言搜索"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});
