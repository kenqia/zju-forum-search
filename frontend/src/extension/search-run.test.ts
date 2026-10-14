import { describe, expect, it, vi } from 'vitest';
import { SearchRun } from './search-run';
import { createMessageHandler } from './background';
import { DEFAULT_SETTINGS, type ExtensionRequest, type ExtensionResponseFor, type SearchSourceSession } from './types';
import type { RuntimeMessenger } from './search-run';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const own = { ...DEFAULT_SETTINGS, llmApiKey: '', hasApiKey: true };
const source: SearchSourceSession = {
  sourceId: 'cc98', capabilities: { searchSurface: 'title', querySyntax: 'plain-keyword', resultOrdering: 'time-desc' },
  ratePolicy: { maxSearchCalls: 100, minRequestIntervalMs: 0 }, search: async () => ({ hits: [] }),
};
const plan = { summary: '', searches: [{ query: '高数', purpose: '' }], requiredConcepts: [], excludedTerms: [],
  timeConstraint: { expression: '', startDate: null, endDate: null } };
function messenger() {
  const messages: ExtensionRequest[] = [];
  const runtime: RuntimeMessenger = { send: async <Request extends ExtensionRequest>(request: Request) => {
    messages.push(request);
    return (request.type === 'planner:begin' ? { ok: true, settings: own }
      : request.type === 'planner:first' ? { ok: true, plan }
      : request.type === 'planner:feedback' ? { ok: true, feedback: { judgments: [], newSearches: [], stopSuggestions: [], shouldStop: false, reasoning: '' } }
      : { ok: true }) as ExtensionResponseFor<Request>;
  } };
  return { runtime, messages };
}

describe('search run lifecycle', () => {
  it('retries failed sponsored cleanup before refreshing quota and reopening admission', async () => {
    const { runtime } = messenger(); const send = runtime.send;
    const sponsored = { ...own, hasApiKey: false };
    let finishCount = 0;
    const events: string[] = [];
    runtime.send = async <Request extends ExtensionRequest>(request: Request) => {
      events.push(request.type);
      return (request.type === 'planner:begin' ? { ok: true, settings: sponsored }
        : request.type === 'planner:finish' ? (++finishCount === 1 ? { ok: false, error: 'offline' } : { ok: true })
        : request.type === 'trial:get' ? { ok: true, trial: { remaining: 4, available: true } }
        : await send(request)) as ExtensionResponseFor<Request>;
    };
    const run = new SearchRun({ runtime, createSource: async () => source });
    await run.refreshTrial(); await run.start('高数', sponsored);
    expect(run.state.snapshot.phase).toBe('complete');
    expect(run.state.trial).toBeNull();
    expect(run.canStart(sponsored)).toBe(false);
    await run.refreshTrial();
    expect(events.slice(-2)).toEqual(['planner:finish', 'trial:get']);
    expect(run.canStart(sponsored)).toBe(true);
  });

  it('disposes initialization without publishing late state and still finishes the background run', async () => {
    const pendingSource = deferred<SearchSourceSession>();
    const { runtime, messages } = messenger();
    const updates = vi.fn();
    const createSource = vi.fn(() => pendingSource.promise);
    const run = new SearchRun({ runtime, createSource, onUpdate: updates });
    const pending = run.start('高数', own);
    await vi.waitFor(() => expect(createSource).toHaveBeenCalledOnce());
    run.dispose();
    const count = updates.mock.calls.length;
    await pending;
    pendingSource.resolve(source); await Promise.resolve();
    expect(updates).toHaveBeenCalledTimes(count);
    expect(run.canStart(own)).toBe(false);
    expect(messages.filter((message) => message.type === 'planner:finish')).toHaveLength(1);
    expect(messages.some((message) => message.type === 'planner:first')).toBe(false);
  });

  it('keeps sponsored admission closed after cancellation until the original background call releases', async () => {
    const provider = deferred<Response>();
    let plannerStarted = false;
    let finishCalls = 0;
    const handler = createMessageHandler({ storage: { get: async () => DEFAULT_SETTINGS, set: async () => undefined },
      requestPermission: async () => true, trialStorage: { get: async () => 'a'.repeat(64), set: async () => undefined },
      fetch: async (url) => {
        if (url.endsWith('/status')) return new Response(JSON.stringify({ ok: true, remaining: 5, available: true }));
        if (url.endsWith('/finish')) { finishCalls++; return new Response('{"ok":true}'); }
        plannerStarted = true;
        return provider.promise;
      },
    });
    const runtime: RuntimeMessenger = { send: <Request extends ExtensionRequest>(message: Request) =>
      new Promise<ExtensionResponseFor<Request>>((resolve) => { handler(message, (response) => resolve(response as ExtensionResponseFor<Request>), 'cc98', 'synthetic-document'); }) };
    const run = new SearchRun({ runtime, createSource: async () => source });
    const sponsored = { ...own, hasApiKey: false };
    await run.refreshTrial();
    const pending = run.start('高数', sponsored);
    await vi.waitFor(() => expect(plannerStarted).toBe(true));
    run.stop();
    await vi.waitFor(() => expect(run.state.snapshot.phase).toBe('complete'));
    expect(run.state.settling).toBe(true);
    expect(run.canStart(sponsored)).toBe(false);
    expect(finishCalls).toBe(0);
    provider.resolve(new Response(JSON.stringify({ ok: true, plan })));
    await pending;
    expect(finishCalls).toBe(1);
    expect(run.canStart(sponsored)).toBe(true);
    expect(run.state.snapshot.results).toEqual([]);
  });

  it('ignores stale quota responses and keeps failed refreshes closed until retry', async () => {
    const old = deferred<ExtensionResponseFor<{ type: 'trial:get' }>>();
    const newer = deferred<ExtensionResponseFor<{ type: 'trial:get' }>>();
    let calls = 0;
    const runtime: RuntimeMessenger = { send: async <Request extends ExtensionRequest>() => (
      ++calls === 1 ? await old.promise : calls === 2 ? await newer.promise
        : calls === 3 ? { ok: false, error: 'offline' } : { ok: true, trial: { remaining: 3, available: true } }
    ) as ExtensionResponseFor<Request> };
    const run = new SearchRun({ runtime });
    const first = run.refreshTrial(); const second = run.refreshTrial();
    old.resolve({ ok: true, trial: { remaining: 5, available: true } }); await first;
    expect(run.state.trialLoading).toBe(true);
    expect(run.state.trial).toBeNull();
    newer.resolve({ ok: true, trial: { remaining: 4, available: true } }); await second;
    expect(run.state.trial).toEqual({ remaining: 4, available: true });
    await run.refreshTrial();
    expect(run.canStart({ ...own, hasApiKey: false })).toBe(false);
    await run.refreshTrial();
    expect(run.canStart({ ...own, hasApiKey: false })).toBe(true);
  });

  it('shows completed results but blocks another sponsored run until finish and quota refresh settle', async () => {
    const cleanup = deferred<ExtensionResponseFor<{ type: 'planner:finish'; runId: string }>>();
    const quota = deferred<ExtensionResponseFor<{ type: 'trial:get' }>>();
    const { runtime, messages } = messenger();
    const send = runtime.send;
    const sponsored = { ...own, hasApiKey: false };
    let statusCalls = 0;
    runtime.send = async <Request extends ExtensionRequest>(request: Request) => {
      if (request.type === 'trial:get') {
        statusCalls++;
        return (statusCalls === 1 ? { ok: true, trial: { remaining: 5, available: true } } : await quota.promise) as ExtensionResponseFor<Request>;
      }
      if (request.type === 'planner:begin') return { ok: true, settings: sponsored } as ExtensionResponseFor<Request>;
      if (request.type === 'planner:finish') return await cleanup.promise as ExtensionResponseFor<Request>;
      return send(request);
    };
    const run = new SearchRun({ runtime, createSource: async () => ({ ...source, search: async () => ({ hits: [{
      candidate: { sourceId: 'cc98', id: 'one', title: '高数资料', titleOrigin: 'native', url: 'https://www.cc98.org/topic/one' },
      document: { title: '高数资料' }, position: 1,
    }] }) }) });
    await run.refreshTrial();
    const pending = run.start('高数', sponsored);
    await vi.waitFor(() => expect(run.state.snapshot.phase).toBe('complete'));
    expect(run.state.settling).toBe(true);
    await run.start('不能开始', sponsored);
    expect(run.state.snapshot.query).toBe('高数');
    expect(run.state.snapshot.results.map((candidate) => candidate.title)).toEqual(['高数资料']);
    cleanup.resolve({ ok: true });
    await vi.waitFor(() => expect(statusCalls).toBe(2));
    expect(run.state.trialLoading).toBe(true);
    expect(run.state.settling).toBe(true);
    quota.resolve({ ok: true, trial: { remaining: 4, available: true } });
    await pending;
    expect(run.state.settling).toBe(false);
    expect(run.state.trial).toEqual({ remaining: 4, available: true });
    expect(messages.filter((request) => request.type === 'planner:first')).toHaveLength(1);
  });

  it('can stop during source initialization and ignores a late source after replacement', async () => {
    const pendingSource = deferred<SearchSourceSession>();
    const { runtime, messages } = messenger();
    const createSource = vi.fn().mockReturnValueOnce(pendingSource.promise).mockResolvedValue(source);
    const run = new SearchRun({ runtime, createSource });
    const first = run.start('旧搜索', own);
    expect(run.state.running).toBe(true);
    expect(run.state.snapshot.query).toBe('旧搜索');
    await vi.waitFor(() => expect(createSource).toHaveBeenCalledOnce());
    run.stop();
    expect(run.state.running).toBe(false);
    expect(run.state.snapshot.stopReason).toBe('user_stopped');
    await run.start('新搜索', own);
    const latest = run.state.snapshot;
    pendingSource.resolve(source); await first;
    expect(run.state.snapshot).toEqual(latest);
    expect(run.state.snapshot.query).toBe('新搜索');
    expect(messages.filter((message) => message.type === 'planner:first')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'planner:finish')).toHaveLength(2);
  });
});
