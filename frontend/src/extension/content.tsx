import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import panelCss from './panel.css?inline';

import { sourceRegistry } from './source-registry';
import type { FeedbackInput } from './planner';
import { SearchSession, SearchSessionError, type SearchPlanner, type SearchSnapshot } from './search-session';
import { SourceError, DEFAULT_SETTINGS, type SourceCapabilities, type ExtensionFailureCode, type ExtensionRequest, type ExtensionResponseFor, type ExtensionSettings, type FeedbackPlan, type ModelQueryPlan, type PublicExtensionSettings } from './types';

export interface RuntimeMessenger {
  send<Request extends ExtensionRequest>(message: Request): Promise<ExtensionResponseFor<Request>>;
}

interface ChromeRuntime {
  lastError?: { message?: string };
  sendMessage(message: unknown, callback: (response: Record<string, unknown>) => void): void;
}

function chromeMessenger(runtime: ChromeRuntime): RuntimeMessenger {
  return {
    send: <Request extends ExtensionRequest>(message: Request) => new Promise<ExtensionResponseFor<Request>>((resolve, reject) => {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) reject(new Error('扩展后台没有响应，请重新加载扩展'));
        else resolve((response ?? {}) as ExtensionResponseFor<Request>);
      });
    }),
  };
}

function responseError(response: { ok: false; error: string; code?: ExtensionFailureCode }, timeoutMessage?: string): Error {
  if (response.code === 'model_timeout') {
    return new SearchSessionError(timeoutMessage ?? '模型调用超过 20 秒，已停止搜索。', 'model_timeout');
  }
  return new Error(response.error || '扩展后台请求失败');
}

class BackgroundPlanner implements SearchPlanner {
  constructor(private readonly runtime: RuntimeMessenger, private readonly capabilities: SourceCapabilities) {}
  private withCancellation<T>(response: Promise<T>, requestId: string, signal?: AbortSignal): Promise<T> {
    if (!signal) return response;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        void this.runtime.send({ type: 'planner:cancel', requestId }).catch(() => undefined);
        reject(new DOMException('模型请求已取消', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void response.then(
        (value) => { signal.removeEventListener('abort', abort); resolve(value); },
        (error) => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }
  private async requestPlan(type: 'planner:first' | 'planner:blind', query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const request = { type, requestId, query, capabilities: this.capabilities };
    const response = await this.withCancellation(this.runtime.send(request), requestId, signal);
    if (!response.ok) throw responseError(response, '模型调用超过 20 秒，未开始 CC98 检索。');
    return response.plan;
  }
  private async requestFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const response = await this.withCancellation(this.runtime.send({ type: 'planner:feedback', requestId, input, capabilities: this.capabilities }), requestId, signal);
    if (!response.ok) throw responseError(response, '反馈模型调用超过 20 秒，已保留当前结果。');
    return response.feedback;
  }
  planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    return this.requestPlan('planner:first', query, signal);
  }
  planBlindExpansion(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    return this.requestPlan('planner:blind', query, signal);
  }
  planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    return this.requestFeedback(input, signal);
  }
}

export function createBackgroundPlanner(runtime: RuntimeMessenger, capabilities: SourceCapabilities): SearchPlanner {
  return new BackgroundPlanner(runtime, capabilities);
}

const EMPTY_SNAPSHOT: SearchSnapshot = {
  query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
  activeSearches: [], executedSearches: [], inactiveSearches: [], learnedTerms: [], results: [],
  outOfRangeCount: 0, planningNotice: '', stopReason: null, statusText: '输入你想找的内容，结果会在每轮结束后更新。',
};

function SettingsPanel({ runtime, settings, onSettings }: {
  runtime: RuntimeMessenger;
  settings: PublicExtensionSettings;
  onSettings(settings: PublicExtensionSettings): void;
}) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState('API key 只保存在 chrome.storage，不会写入页面、日志或仓库。');
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await runtime.send({ type: 'settings:save', settings: draft });
      if (!response.ok) throw responseError(response);
      onSettings(response.settings);
      setStatus('设置已保存，并已授予该模型主机的访问权限。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  }

  return <>
    <form className="settings-form" onSubmit={save}>
      <label>OpenAI 兼容 base URL
        <input type="url" value={draft.llmBaseUrl} onChange={(event) => setDraft({ ...draft, llmBaseUrl: event.target.value })} placeholder="https://example.com/v1" required />
      </label>
      <label>API key
        <input type="password" value={draft.llmApiKey} onChange={(event) => setDraft({ ...draft, llmApiKey: event.target.value })} autoComplete="new-password" placeholder={settings.hasApiKey ? '已保存；留空表示不修改' : '尚未设置'} required={!settings.hasApiKey} />
      </label>
      <label>模型名称
        <input value={draft.llmModel} onChange={(event) => setDraft({ ...draft, llmModel: event.target.value })} placeholder="model-name" required />
      </label>
      <label>CC98 检索时长（秒）
        <input type="number" min="10" max="300" value={draft.searchBudgetSeconds} onChange={(event) => setDraft({ ...draft, searchBudgetSeconds: Number(event.target.value) })} required />
      </label>
      <p className="hint">模型每次最多等待 20 秒，不占用这段检索时长。</p>
      <div className="settings-actions">
        <p className="hint">保存时只申请该 base URL 所在主机。</p>
        <button className="primary" disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
      </div>
    </form>
    <p className="status" role="status">{status}</p>
  </>;
}

export function Terms({ snapshot }: { snapshot: SearchSnapshot }) {
  const planned = snapshot.plan?.searches.map((search) => search.query) ?? [];
  return <>
    {snapshot.planningNotice && <p className="fallback-notice" role="status">{snapshot.planningNotice}</p>}
    <details>
    <summary>检索进度 · 第 {snapshot.round || 0} 轮 · {snapshot.requestsMade} 次请求</summary>
    <div className="term-group">首轮检索词<div className="chips">{planned.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>
    {snapshot.activeSearches.length > 0 && <div className="term-group">正在执行<div className="chips">{snapshot.activeSearches.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>}
    {snapshot.executedSearches.length > 0 && <div className="term-group">已执行<div className="chips">{snapshot.executedSearches.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>}
    {snapshot.inactiveSearches.length > 0 && <div className="term-group">未命中检索词<div className="chips">{snapshot.inactiveSearches.map((term) => <span className="chip inactive" key={term}>{term}</span>)}</div></div>}
    </details>
  </>;
}

interface SearchState {
  query: string;
  snapshot: SearchSnapshot;
}

interface SearchController {
  session: SearchSession | null;
  runId: number;
}

function SearchPanel({ runtime, settings, state, onState, controller }: {
  runtime: RuntimeMessenger;
  settings: ExtensionSettings;
  state: SearchState;
  onState(patch: Partial<SearchState>): void;
  controller: SearchController;
}) {
  const { query, snapshot } = state;
  const setQuery = (value: string) => onState({ query: value });
  const setSnapshot = (next: SearchSnapshot) => onState({ snapshot: next });
  const running = snapshot.phase !== 'complete' && snapshot.round > 0;

  async function search(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    controller.session?.stop('replaced');
    controller.session = null;
    const currentRun = ++controller.runId;
    try {
      const adapter = sourceRegistry.resolve(location.href);
      if (!adapter) throw new Error('当前页面没有可用的搜索源。');
      const source = await adapter.createSession({ url: location.href });
      if (controller.runId !== currentRun) return;
      const nextSession = new SearchSession({
        planner: createBackgroundPlanner(runtime, source.capabilities),
        source,
        onUpdate: (next) => { if (controller.runId === currentRun) setSnapshot(next); },
      });
      controller.session = nextSession;
      await nextSession.run(normalized, settings.searchBudgetSeconds);
      if (controller.session === nextSession) controller.session = null;
    } catch (error) {
      if (controller.runId !== currentRun) return;
      const stopReason = error instanceof SourceError && error.code === 'not_logged_in' ? 'not_logged_in'
        : error instanceof SourceError && error.code === 'rate_limited' ? 'rate_limited' : 'failed';
      setSnapshot({ ...EMPTY_SNAPSHOT, query: normalized, phase: 'complete', stopReason,
        statusText: error instanceof Error ? error.message : '无法创建搜索源。' });
    }
  }

  function stop() {
    controller.session?.stop('user_stopped');
  }

  return <>
    <form className="search-form" onSubmit={search}>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：找 2025 年的高数复习资料" aria-label="自然语言查询" required />
      <button className="primary">{running ? '开始新搜索' : '开始搜索'}</button>
    </form>
    <p className={`status${snapshot.stopReason === 'failed' || snapshot.stopReason === 'model_timeout' ? ' error' : ''}`} role="status">{snapshot.statusText}</p>
    {running && <div className="run-actions"><button className="secondary" type="button" onClick={stop}>停止并查看结果</button></div>}
    {(snapshot.plan || snapshot.round > 0) && <Terms snapshot={snapshot} />}
    {snapshot.outOfRangeCount > 0 && <p className="filtered-count">另有 {snapshot.outOfRangeCount} 条范围外结果已忽略。</p>}
    <div aria-live="polite">
      {snapshot.results.length === 0
        ? <div className="empty">{snapshot.phase === 'complete' && snapshot.stopReason === 'no_results' ? '没有找到主题帖。' : '结果将在这里逐轮出现。'}</div>
        : snapshot.results.map((topic, index) => <article className="result" key={topic.id}>
          <span className="rank">{index + 1}</span>
          <div><h2><a href={topic.url} target="_blank" rel="noreferrer">{topic.title}</a></h2><p>{topic.board || '板块未知'} · {topic.time || '时间未知'} · {topic.replyCount} 条回复 · 首次命中第 {topic.firstRound} 轮</p></div>
        </article>)}
    </div>
  </>;
}

function App({ runtime }: { runtime: RuntimeMessenger }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'search' | 'settings'>('search');
  const [settings, setSettings] = useState<PublicExtensionSettings>(DEFAULT_SETTINGS);
  const [searchState, setSearchState] = useState<SearchState>({ query: '', snapshot: EMPTY_SNAPSHOT });
  const searchController = useRef<SearchController>({ session: null, runId: 0 });
  useEffect(() => {
    void runtime.send({ type: 'settings:get' }).then((response) => {
      if (response.ok) setSettings(response.settings);
    }).catch(() => undefined);
  }, [runtime]);

  return <>
    <style>{panelCss}</style>
    <button className="orb" type="button" aria-label="打开 CC98 自然语言搜索" onClick={() => setOpen(true)}>
      <span className="orb-mark">98</span><span className="orb-dot" />
    </button>
    <aside className={`drawer${open ? ' open' : ''}`} aria-label="CC98 自然语言搜索" aria-hidden={!open}>
      <div className="drawer-head"><div><p className="kicker">CC98 SEARCH</p><h1>找到真正相关的讨论</h1><p className="subtitle">模型规划检索词，CC98 返回候选，浏览器本地重排。</p></div><button className="close" type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button></div>
      <nav className="tabs" aria-label="功能切换">
        <button className={`tab${tab === 'search' ? ' active' : ''}`} data-tab="search" type="button" onClick={() => setTab('search')}>搜索</button>
        <button className={`tab${tab === 'settings' ? ' active' : ''}`} data-tab="settings" type="button" onClick={() => setTab('settings')}>模型设置</button>
      </nav>
      {tab === 'search'
        ? <SearchPanel runtime={runtime} settings={settings} state={searchState} onState={(patch) => setSearchState((current) => ({ ...current, ...patch }))} controller={searchController.current} />
        : <SettingsPanel runtime={runtime} settings={settings} onSettings={setSettings} />}
      <p className="privacy">反馈轮只会向模型发送标题、作者、时间、板块和回复数。正文、回帖和 CC98 登录信息不会离开浏览器。</p>
    </aside>
  </>;
}

export function mountExtension(targetDocument: Document, runtime: RuntimeMessenger, mode: ShadowRootMode = 'closed') {
  const existing = targetDocument.getElementById('zju-forum-search-extension');
  if (existing) throw new Error('CC98 自然语言搜索扩展已经加载');
  const host = targetDocument.createElement('div');
  host.id = 'zju-forum-search-extension';
  const shadowRoot = host.attachShadow({ mode });
  targetDocument.documentElement.append(host);
  createRoot(shadowRoot).render(<App runtime={runtime} />);
  return { host, shadowRoot };
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: { runtime?: ChromeRuntime } }).chrome;
if (chromeApi?.runtime && document.documentElement && !document.getElementById('zju-forum-search-extension')) {
  mountExtension(document, chromeMessenger(chromeApi.runtime));
}
