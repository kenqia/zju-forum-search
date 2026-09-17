import { describe, expect, it, vi } from 'vitest';

import { createMessageHandler, type BackgroundDependencies } from './background';
import { DEFAULT_SETTINGS } from './types';

function harness(overrides: Partial<BackgroundDependencies> = {}) {
  let stored = { ...DEFAULT_SETTINGS, llmApiKey: 'fake-key' };
  const dependencies: BackgroundDependencies = {
    storage: {
      get: vi.fn(async () => stored),
      set: vi.fn(async (value) => { stored = value; }),
    },
    requestPermission: vi.fn(async () => true),
    fetch: vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: '高数资料',
        searches: [{ query: '高数', purpose: '简称' }],
        required_concepts: [],
        excluded_terms: [],
        time_constraint: { expression: '', start_date: null, end_date: null },
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
    ...overrides,
  };
  const handler = createMessageHandler(dependencies);
  const send = (message: unknown) => new Promise<unknown>((resolve) => {
    expect([true, false]).toContain(handler(message, resolve));
  });
  return { dependencies, send };
}

describe('background message boundary', () => {
  it.each([undefined, { searchSurface: 'unsupported', querySyntax: 'plain-keyword' },
    { searchSurface: ['title'], querySyntax: 'boolean' }, { searchSurface: 'title', querySyntax: 'sql' },
  ])('rejects invalid capabilities before calling the model: %j', (capabilities) => {
    const dependencies: BackgroundDependencies = { storage: { get: vi.fn(), set: vi.fn() }, requestPermission: vi.fn(), fetch: vi.fn() };
    const handler = createMessageHandler(dependencies);
    for (const type of ['planner:first', 'planner:blind', 'planner:feedback']) {
      expect(handler({ type, requestId: 'invalid', query: '测试', input: {}, capabilities }, vi.fn())).toBe(false);
    }
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.storage.get).not.toHaveBeenCalled();
  });

  it('requests only the configured model host before persisting settings', async () => {
    const { dependencies, send } = harness();
    const settings = {
      llmBaseUrl: 'https://models.example.com/v1',
      llmApiKey: 'fake-key',
      llmModel: 'model-name',
      searchBudgetSeconds: 45,
    };

    await expect(send({ type: 'settings:save', settings })).resolves.toEqual({
      ok: true,
      settings: { ...settings, llmApiKey: '', hasApiKey: true },
    });
    expect(dependencies.requestPermission).toHaveBeenCalledWith('https://models.example.com/*');
    expect(dependencies.storage.set).toHaveBeenCalledWith(settings);
  });

  it('never returns the stored API key to a content script', async () => {
    const { send } = harness();

    const response = await send({ type: 'settings:get' });

    expect(response).toMatchObject({ ok: true, settings: { llmApiKey: '', hasApiKey: true } });
    expect(JSON.stringify(response)).not.toContain('fake-key');
  });

  it('keeps the stored API key when the user saves other fields', async () => {
    const { dependencies, send } = harness();

    await send({ type: 'settings:save', settings: { ...DEFAULT_SETTINGS, llmApiKey: '', llmModel: 'updated-model' } });

    expect(dependencies.storage.set).toHaveBeenCalledWith(expect.objectContaining({
      llmApiKey: 'fake-key',
      llmModel: 'updated-model',
    }));
  });

  it('calls chat completions and returns a validated first-round plan', async () => {
    const { dependencies, send } = harness({
      storage: {
        get: vi.fn(async () => ({
          llmBaseUrl: 'https://models.example.com/v1',
          llmApiKey: 'fake-key',
          llmModel: 'model-name',
          searchBudgetSeconds: 45,
        })),
        set: vi.fn(),
      },
    });

    const response = await send({ type: 'planner:first', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword' }, requestId: 'request-1', query: '找高数资料', body: '不得转发' });

    expect(response).toMatchObject({ ok: true, plan: { searches: [{ query: '高数' }] } });
    expect(dependencies.fetch).toHaveBeenCalledOnce();
    const [url, init] = (dependencies.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://models.example.com/v1/chat/completions');
    expect(JSON.parse(String(init.body)).messages[0].content).toContain('仅匹配原生标题');
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer fake-key',
      'Content-Type': 'application/json',
    });
    expect((init as RequestInit).body).not.toContain('不得转发');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      enable_thinking: false,
      max_completion_tokens: 1200,
    });
  });

  it('uses the same fast bounded generation settings for feedback', async () => {
    const { dependencies, send } = harness({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          new_searches: [], learned_terms: [], stop_suggestions: [], should_stop: true, reasoning: '结果足够',
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });

    await send({
      type: 'planner:feedback', capabilities: { searchSurface: 'fulltext', querySyntax: 'plain-keyword' },
      requestId: 'feedback-1',
      input: { query: '高数', executedSearches: [], newCandidates: [], round: 1 },
    });

    const [, init] = (dependencies.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String(init.body)).messages[0].content).toContain('匹配全文');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      enable_thinking: false,
      max_completion_tokens: 1200,
    });
  });

  it('reports a model timeout after 20 seconds instead of a connection failure', async () => {
    vi.useFakeTimers();
    try {
      const { send } = harness({
        fetch: vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })),
      });

      const pending = send({ type: 'planner:first', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword' }, requestId: 'request-timeout', query: '高数' });
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(pending).resolves.toEqual({
        ok: false,
        error: '模型调用超过 20 秒',
        code: 'model_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns readable Chinese errors for malformed model responses', async () => {
    const { send } = harness({
      fetch: vi.fn(async () => new Response('{"choices":[]}', { status: 200 })),
    });

    await expect(send({ type: 'planner:first', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword' }, requestId: 'request-2', query: '高数' })).resolves.toEqual({
      ok: false,
      error: '模型没有返回文本内容',
      code: 'planner_failed',
    });
  });

  it('aborts an in-flight model request when the content session is cancelled', async () => {
    let observedSignal: AbortSignal | undefined;
    const { send } = harness({
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        if (observedSignal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }),
    });

    const pending = send({ type: 'planner:first', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword' }, requestId: 'request-cancel', query: '高数' });
    await send({ type: 'planner:cancel', requestId: 'request-cancel' });

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, error: '模型请求已取消', code: 'model_cancelled' });
  });
});
