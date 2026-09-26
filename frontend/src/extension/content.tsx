import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Collapsible, NumberField, Switch, Tabs } from '@base-ui/react';
import { Check, ChevronDown, LoaderCircle, Minus, Plus, Search, ShieldCheck, Settings2, X } from 'lucide-react';
import panelCss from './panel.css?inline';

import { sourceRegistry } from './source-registry';
import type { FeedbackInput } from './planner';
import { SearchSession, SearchSessionError, type SearchPlanner, type SearchSnapshot } from './search-session';
import { SourceError, DEFAULT_SETTINGS, type SourceCapabilities, type ExtensionFailureCode, type ExtensionRequest, type ExtensionResponseFor, type ExtensionSettings, type FeedbackPlan, type FinalRerankPlan, type FinalRerankRequestInput, type ModelQueryPlan, type PublicExtensionSettings } from './types';

export interface RuntimeMessenger {
  send<Request extends ExtensionRequest>(message: Request): Promise<ExtensionResponseFor<Request>>;
  onOpenRequested?(listener: () => void): () => void;
}

interface ChromeRuntime {
  lastError?: { message?: string };
  sendMessage(message: unknown, callback: (response: Record<string, unknown>) => void): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
}

function chromeMessenger(runtime: ChromeRuntime): RuntimeMessenger {
  return {
    send: <Request extends ExtensionRequest>(message: Request) => new Promise<ExtensionResponseFor<Request>>((resolve, reject) => {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) reject(new Error('扩展后台没有响应，请重新加载扩展'));
        else resolve((response ?? {}) as ExtensionResponseFor<Request>);
      });
    }),
    onOpenRequested: (listener) => {
      const onMessage = (message: unknown) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ui:open') listener();
      };
      runtime.onMessage.addListener(onMessage);
      return () => runtime.onMessage.removeListener(onMessage);
    },
  };
}

function responseError(response: { ok: false; error: string; code?: ExtensionFailureCode }, timeoutMessage?: string): Error {
  if (response.code === 'model_timeout') {
    return new SearchSessionError(timeoutMessage ?? '模型调用超过 20 秒，已停止搜索。', 'model_timeout');
  }
  return new Error(response.error || '扩展后台请求失败');
}

class BackgroundPlanner implements SearchPlanner {
  constructor(
    private readonly runtime: RuntimeMessenger,
    private readonly capabilities: SourceCapabilities,
    private readonly modelSearchNarrowingEnabled: boolean,
  ) {}
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
  private async requestPlan(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const request = { type: 'planner:first' as const, requestId, query, capabilities: this.capabilities };
    const response = await this.withCancellation(this.runtime.send(request), requestId, signal);
    if (!response.ok) throw responseError(response, '模型调用超过 20 秒，未开始检索。');
    return response.plan;
  }
  private async requestFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const response = await this.withCancellation(this.runtime.send({
      type: 'planner:feedback', requestId, input, capabilities: this.capabilities,
      modelSearchNarrowingEnabled: this.modelSearchNarrowingEnabled,
    }), requestId, signal);
    if (!response.ok) throw responseError(response, '反馈模型调用超过 20 秒，已保留当前结果。');
    return response.feedback;
  }
  private async requestFinalRerank(input: FinalRerankRequestInput, signal?: AbortSignal): Promise<FinalRerankPlan> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (signal?.aborted) return Promise.reject(new DOMException('模型请求已取消', 'AbortError'));
    const response = await this.withCancellation(this.runtime.send({ type: 'planner:rerank', requestId, input, capabilities: this.capabilities }), requestId, signal);
    if (!response.ok) throw responseError(response, '最终列表重排超过 20 秒，已保留本地预排序。');
    return response.rerank;
  }
  planFirstRound(query: string, signal?: AbortSignal): Promise<ModelQueryPlan> {
    return this.requestPlan(query, signal);
  }
  planFeedback(input: FeedbackInput, signal?: AbortSignal): Promise<FeedbackPlan> {
    return this.requestFeedback(input, signal);
  }
  rerankResults(input: FinalRerankRequestInput, signal?: AbortSignal): Promise<FinalRerankPlan> {
    return this.requestFinalRerank(input, signal);
  }
}

export function createBackgroundPlanner(runtime: RuntimeMessenger, capabilities: SourceCapabilities, modelSearchNarrowingEnabled = DEFAULT_SETTINGS.modelSearchNarrowingEnabled): SearchPlanner {
  return new BackgroundPlanner(runtime, capabilities, modelSearchNarrowingEnabled);
}

const EMPTY_SNAPSHOT: SearchSnapshot = {
  query: '', phase: 'planning', round: 0, requestsMade: 0, plan: null,
  activeSearches: [], executedSearches: [], inactiveSearches: [], results: [],
  softIsolatedResults: [],
  outOfRangeCount: 0, planningNotice: '', stopReason: null, statusText: '输入你想找的内容，结果会在每个检索波次后更新。', finalRerank: 'idle',
};

function SettingsPanel({ runtime, settings, onSettings }: {
  runtime: RuntimeMessenger;
  settings: PublicExtensionSettings;
  onSettings(settings: PublicExtensionSettings): void;
}) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const apiKeyInputType = globalThis.CSS?.supports?.('-webkit-text-security', 'disc') ? 'text' : 'password';
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

  const updateCount = (key: 'searchRequestLimit' | 'feedbackEvidenceLimit' | 'finalRerankTopM', value: number | null) => {
    if (value === null || Number.isNaN(value)) return;
    setDraft({ ...draft, [key]: value });
  };

  return <form className="settings-form" onSubmit={save}>
    <section className="settings-section" aria-labelledby="settings-model-heading">
      <h2 id="settings-model-heading">模型</h2>
      <label className="field">OpenAI 兼容 base URL
        <input type="url" value={draft.llmBaseUrl} onChange={(event) => setDraft({ ...draft, llmBaseUrl: event.target.value })} placeholder="https://example.com/v1" required />
      </label>
      <label className="field">API key
        <input className="api-key-input" type={apiKeyInputType} value={draft.llmApiKey} onChange={(event) => setDraft({ ...draft, llmApiKey: event.target.value })} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={settings.hasApiKey ? '已保存；留空表示不修改' : '尚未设置'} required={!settings.hasApiKey} />
      </label>
      <label className="field">模型名称
        <input value={draft.llmModel} onChange={(event) => setDraft({ ...draft, llmModel: event.target.value })} placeholder="model-name" required />
      </label>
      <p className="hint">保存时如尚未授权，浏览器会询问是否允许扩展访问该模型主机，用于发送模型请求。</p>
    </section>

    <section className="settings-section" aria-labelledby="settings-retrieval-heading">
      <h2 id="settings-retrieval-heading">检索</h2>
      <NumberSetting label="站点请求上限" description="包含分页" value={draft.searchRequestLimit} min={1} max={100} onChange={(value) => updateCount('searchRequestLimit', value)} />
      <NumberSetting label="单轮反馈证据" description="每次模型反馈最多候选数" value={draft.feedbackEvidenceLimit} min={10} max={100} onChange={(value) => updateCount('feedbackEvidenceLimit', value)} />
      <SwitchSetting
        title="允许模型提前收窄搜索范围"
        description="关闭后可能发出更多站点请求，但仍受请求上限限制。"
        checked={draft.modelSearchNarrowingEnabled}
        titleId="model-search-narrowing-title"
        descriptionId="model-search-narrowing-description"
        onChange={(checked) => setDraft({ ...draft, modelSearchNarrowingEnabled: checked })}
      />
      <p className="hint">每次站点搜索请求都计入上限，包括分页；模型调用不计入。</p>
    </section>

    <section className="settings-section" aria-labelledby="settings-ranking-heading">
      <h2 id="settings-ranking-heading">排序</h2>
      <SwitchSetting
        title="搜索完成后优化结果顺序"
        description="搜索结束后让模型调整前排顺序；关闭或失败时保留本地排序。"
        checked={draft.finalRerankEnabled}
        titleId="final-rerank-title"
        descriptionId="final-rerank-description"
        onChange={(checked) => setDraft({ ...draft, finalRerankEnabled: checked })}
      />
      <NumberSetting label="重排候选 Top-M" description="发送给最终重排的前排结果数" value={draft.finalRerankTopM} min={10} max={150} disabled={!draft.finalRerankEnabled} onChange={(value) => updateCount('finalRerankTopM', value)} inputLabel="最终列表重排 Top-M" />
    </section>

    <section className="settings-section" aria-labelledby="settings-privacy-heading">
      <h2 id="settings-privacy-heading">隐私</h2>
      <PrivacyDisclosure />
    </section>

    <div className="settings-footer">
      <p className={`settings-status${status && status.includes('失败') ? ' error' : ''}`} role="status">{status || '设置会保存在浏览器本地'}</p>
      <button className="primary" disabled={saving}><>{saving ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}</>{saving ? '保存中…' : '保存'}</button>
    </div>
  </form>;
}

function NumberSetting({ label, description, value, min, max, disabled, inputLabel, onChange }: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  inputLabel?: string;
  onChange(value: number | null): void;
}) {
  return <div className={`number-setting${disabled ? ' disabled' : ''}`}>
    <div><span className="setting-title">{label}</span><span className="setting-description">{description}</span></div>
    <NumberField.Root value={value} min={min} max={max} step={1} disabled={disabled} onValueChange={onChange}>
      <NumberField.Group className="number-control">
        <NumberField.Decrement className="number-step" aria-label={`减少${label}`}><Minus size={13} aria-hidden="true" /></NumberField.Decrement>
        <NumberField.Input className="number-input" aria-label={inputLabel ?? label} />
        <NumberField.Increment className="number-step" aria-label={`增加${label}`}><Plus size={13} aria-hidden="true" /></NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  </div>;
}

function SwitchSetting({ title, description, checked, titleId, descriptionId, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  titleId: string;
  descriptionId: string;
  onChange(checked: boolean): void;
}) {
  return <div className="switch-setting">
    <div className="switch-copy"><span className="setting-title" id={titleId}>{title}</span><span className="setting-description" id={descriptionId}>{description}</span></div>
    <Switch.Root checked={checked} onCheckedChange={onChange} aria-labelledby={titleId} aria-describedby={descriptionId} className="switch-control"><Switch.Thumb /></Switch.Root>
  </div>;
}

function PrivacyDisclosure() {
  return <Collapsible.Root className="disclosure">
    <Collapsible.Trigger className="disclosure-trigger"><span><ShieldCheck size={15} aria-hidden="true" />隐私与发送给模型的数据</span><ChevronDown size={15} aria-hidden="true" /></Collapsible.Trigger>
    <Collapsible.Panel className="disclosure-panel" keepMounted>
      <p>反馈轮只会向模型发送原生标题、时间、板块和回复数。作者只在本地结果卡片显示，不会发送给模型。</p>
      <p>正文派生标题仅在本地显示。正文、回帖和站点登录信息不会发送给模型。</p>
      <p>API key 只保存在 chrome.storage，不会写入页面、日志或仓库。</p>
    </Collapsible.Panel>
  </Collapsible.Root>;
}

export function Terms({ snapshot }: { snapshot: SearchSnapshot }) {
  const planned = snapshot.plan?.searches.map((search) => search.query) ?? [];
  return <>
    {snapshot.planningNotice && <p className="fallback-notice" role="status">{snapshot.planningNotice}</p>}
    <Collapsible.Root className="terms">
    <Collapsible.Trigger className="terms-trigger"><span><span>检索详情</span><small>第 {snapshot.round || 0} 波 · {snapshot.requestsMade} 次请求</small></span><ChevronDown size={15} aria-hidden="true" /></Collapsible.Trigger>
    <Collapsible.Panel className="terms-panel" keepMounted>
    <div className="term-group">首轮检索词<div className="chips">{planned.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>
    {snapshot.activeSearches.length > 0 && <div className="term-group">正在执行<div className="chips">{snapshot.activeSearches.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>}
    {snapshot.executedSearches.length > 0 && <div className="term-group">已执行<div className="chips">{snapshot.executedSearches.map((term) => <span className="chip" key={term}>{term}</span>)}</div></div>}
    {snapshot.inactiveSearches.length > 0 && <div className="term-group">未命中检索词<div className="chips">{snapshot.inactiveSearches.map((term) => <span className="chip inactive" key={term}>{term}</span>)}</div></div>}
    </Collapsible.Panel>
    </Collapsible.Root>
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

export function SearchStatus({ snapshot, running, onStop }: {
  snapshot: SearchSnapshot;
  running: boolean;
  onStop(): void;
}) {
  const error = snapshot.stopReason === 'failed' || snapshot.stopReason === 'model_timeout' || snapshot.finalRerank === 'failed';
  return <>
    <div className={`status-row${error ? ' error' : ''}${running ? ' running' : ''}`} role="status">
      {running ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : error ? <X size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      <span>{snapshot.statusText}</span>
    </div>
    {running && <div className="run-actions"><button className="secondary" type="button" onClick={onStop}>
      {snapshot.phase === 'reranking' ? '取消最终列表重排' : '停止并查看结果'}
    </button></div>}
  </>;
}

function SearchPanel({ runtime, settings, state, onState, controller }: {
  runtime: RuntimeMessenger;
  settings: ExtensionSettings;
  state: SearchState;
  onState(patch: Partial<SearchState>): void;
  controller: SearchController;
}) {
  const { query, snapshot } = state;
  const inputRef = useRef<HTMLInputElement>(null);
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
        planner: createBackgroundPlanner(runtime, source.capabilities, settings.modelSearchNarrowingEnabled),
        source,
        finalRerankEnabled: settings.finalRerankEnabled,
        finalRerankTopM: settings.finalRerankTopM,
        modelSearchNarrowingEnabled: settings.modelSearchNarrowingEnabled,
        onUpdate: (next) => { if (controller.runId === currentRun) setSnapshot(next); },
      });
      controller.session = nextSession;
      await nextSession.run(normalized, settings.searchRequestLimit, settings.feedbackEvidenceLimit);
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

  function fillExample(example: string) {
    setQuery(example);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return <>
    <form className="search-form" onSubmit={search}>
      <Search size={16} aria-hidden="true" />
      <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找课程、老师、资料或校园讨论…" aria-label="自然语言查询" required />
      <button className="primary">{running ? '新搜索' : '搜索'}</button>
    </form>
    {(snapshot.round > 0 || snapshot.query) && <SearchStatus snapshot={snapshot} running={running} onStop={stop} />}
    {(snapshot.plan || snapshot.round > 0) && <Terms snapshot={snapshot} />}
    {snapshot.round === 0 && !snapshot.query && <div className="empty-state">
      <span className="empty-icon"><Search size={18} aria-hidden="true" /></span>
      <h2>搜索校园里的真实讨论</h2>
      <p>可以直接描述你想找什么，模型会迭代规划检索词。</p>
      <div className="examples" aria-label="示例查询">
        {['操作系统课程评价', '近两年的微积分历年卷', '紫金港租房讨论'].map((example) => <button type="button" key={example} onClick={() => fillExample(example)}>{example}</button>)}
      </div>
    </div>}
    <ResultLists
      results={snapshot.results}
      softIsolatedResults={snapshot.softIsolatedResults}
      outOfRangeCount={snapshot.outOfRangeCount}
      emptyText={snapshot.phase === 'complete' && snapshot.stopReason === 'no_results' ? '没有找到相关主题' : '结果将在这里逐轮出现。'}
    />
    {snapshot.round > 0 && <PrivacyDisclosure />}
  </>;
}

function ResultCard({ topic, rank }: { topic: import('./types').TopicCandidate; rank?: number }) {
  return <article className="result">
    {rank !== undefined && <span className="rank" aria-hidden="true">{rank}</span>}
    <div><h2><a href={topic.url} target="_blank" rel="noreferrer">{topic.title}</a></h2><p>{topic.board || '板块未知'} · {topic.author || '作者未知'} · {topic.time || '时间未知'} · {topic.replyCount} 条回复</p></div>
  </article>;
}

export function ResultLists({ results, softIsolatedResults, outOfRangeCount, emptyText }: {
  results: import('./types').TopicCandidate[];
  softIsolatedResults: import('./types').TopicCandidate[];
  outOfRangeCount: number;
  emptyText: string;
}) {
  return <div aria-live="polite">
    {(results.length > 0 || softIsolatedResults.length > 0 || outOfRangeCount > 0) && <p className="result-counts"><strong>{results.length} 个结果</strong>{softIsolatedResults.length > 0 && ` · ${softIsolatedResults.length} 个已隐藏`}{outOfRangeCount > 0 && ` · ${outOfRangeCount} 个超出时间范围`}</p>}
    {results.length === 0
      ? <div className="empty">{emptyText === '结果将在这里逐轮出现。' ? '' : <><Search size={16} aria-hidden="true" /><span>{emptyText}</span></>}</div>
      : results.map((topic, index) => <ResultCard topic={topic} rank={index + 1} key={topic.id} />)}
    {softIsolatedResults.length > 0 && <details className="soft-isolated">
      <summary>已隐藏 {softIsolatedResults.length} 个低相关结果</summary>
      {softIsolatedResults.map((topic) => <ResultCard topic={topic} key={topic.id} />)}
    </details>}
  </div>;
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
  useEffect(() => runtime.onOpenRequested?.(() => setOpen(true)), [runtime]);

  return <>
    <style>{panelCss}</style>
    <button className="orb" type="button" aria-label="打开自然语言搜索" onClick={() => setOpen(true)}>
      <Search size={20} aria-hidden="true" />
    </button>
    <aside className={`drawer${open ? ' open' : ''}`} aria-label="社区自然语言搜索" aria-hidden={!open}>
      <header className="drawer-head"><div className="brand"><span className="brand-icon"><Search size={16} aria-hidden="true" /></span><div><h1>Campus Search</h1><p>语义搜索校园讨论</p></div></div><button className="close" type="button" aria-label="关闭" onClick={() => setOpen(false)}><X size={17} aria-hidden="true" /></button></header>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as 'search' | 'settings')} className="app-tabs">
        <Tabs.List className="tabs" aria-label="功能切换"><Tabs.Tab value="search" data-tab="search" className="tab">搜索</Tabs.Tab><Tabs.Tab value="settings" data-tab="settings" className="tab"><Settings2 size={14} aria-hidden="true" />设置</Tabs.Tab></Tabs.List>
        <main className="drawer-main">
          <Tabs.Panel value="search" keepMounted className="tab-panel"><SearchPanel runtime={runtime} settings={settings} state={searchState} onState={(patch) => setSearchState((current) => ({ ...current, ...patch }))} controller={searchController.current} /></Tabs.Panel>
          <Tabs.Panel value="settings" keepMounted className="tab-panel"><SettingsPanel runtime={runtime} settings={settings} onSettings={setSettings} /></Tabs.Panel>
        </main>
      </Tabs.Root>
    </aside>
  </>;
}

export function mountExtension(targetDocument: Document, runtime: RuntimeMessenger, mode: ShadowRootMode = 'closed') {
  const existing = targetDocument.getElementById('zju-forum-search-extension');
  if (existing) throw new Error('社区自然语言搜索扩展已经加载');
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
