import { sourceRegistry } from './source-registry';
import { PlannerClient, PlannerError, type FeedbackInput, type PlannerTransport } from './planner';
import { chatCompletionsUrl, modelHostPermission, normalizeSettings, validateSettings } from './settings';
import { TrialClient, TrialClientError, type TrialCredentialStorage } from './trial';
import {
  MODEL_MAX_COMPLETION_TOKENS,
  MODEL_TIMEOUT_MS,
  type ExtensionRequest,
  type ExtensionSettings,
  type StoredExtensionSettings,
  type SourceCapabilities,
} from './types';

export interface SettingsStorage {
  get(): Promise<StoredExtensionSettings>;
  set(settings: ExtensionSettings): Promise<void>;
}

export interface BackgroundDependencies {
  storage: SettingsStorage;
  requestPermission(origin: string): Promise<boolean>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  trialStorage?: TrialCredentialStorage;
  keepAlive?(): void;
}

type SendResponse = (response: unknown) => void;

function publicSettings(settings: ExtensionSettings) {
  return { ...settings, llmApiKey: '', hasApiKey: Boolean(settings.llmApiKey) };
}

interface ChromeApi {
  action: {
    onClicked: { addListener(listener: (tab: { id?: number }) => void): void };
  };
  tabs: {
    sendMessage(tabId: number, message: unknown, callback: () => void): void;
  };
  runtime: {
    lastError?: { message?: string };
    onMessage: { addListener(listener: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean): void };
  };
  storage: {
    local: {
      get(key: string, callback: (value: Record<string, unknown>) => void): void;
      set(value: Record<string, unknown>, callback: () => void): void;
    };
  };
  permissions: {
    request(value: { origins: string[] }, callback: (granted: boolean) => void): void;
  };
}

export function registerActionClick(chromeApi: Pick<ChromeApi, 'action' | 'tabs'> & { runtime: Pick<ChromeApi['runtime'], 'lastError'> }): void {
  chromeApi.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    chromeApi.tabs.sendMessage(tab.id, { type: 'ui:open' }, () => {
      // Pages without this extension's content script have no receiver.
      void chromeApi.runtime.lastError;
    });
  });
}

function isSourceCapabilities(value: unknown): value is SourceCapabilities {
  if (!value || typeof value !== 'object') return false;
  const capabilities = value as Record<string, unknown>;
  return typeof capabilities.searchSurface === 'string'
    && ['title', 'fulltext', 'mixed'].includes(capabilities.searchSurface)
    && typeof capabilities.querySyntax === 'string'
    && ['plain-keyword', 'boolean'].includes(capabilities.querySyntax)
    && typeof capabilities.resultOrdering === 'string'
    && ['time-desc', 'other'].includes(capabilities.resultOrdering);
}

function isFinalRerankInput(value: unknown): value is import('./types').FinalRerankRequestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.query !== 'string' || !Array.isArray(input.candidates)
    || input.candidates.length < 2 || input.candidates.length > 150) return false;
  return input.candidates.every((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    return typeof item.key === 'string' && Boolean(item.key)
      && typeof item.title === 'string'
      && Array.isArray(item.matchedQueries)
      && item.matchedQueries.length <= 5
      && item.matchedQueries.every((query) => typeof query === 'string')
      && typeof item.independentQueryCount === 'number'
      && Number.isInteger(item.independentQueryCount)
      && item.independentQueryCount >= 0
      && (item.bestSourcePosition === null
        || (typeof item.bestSourcePosition === 'number' && Number.isFinite(item.bestSourcePosition) && item.bestSourcePosition >= 1))
      && (item.publishedAt === undefined || typeof item.publishedAt === 'string')
      && (item.section === undefined || typeof item.section === 'string')
      && (item.replyCount === undefined || (typeof item.replyCount === 'number' && Number.isFinite(item.replyCount)));
  });
}

function isExtensionRequest(message: unknown): message is ExtensionRequest {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !value.runId || value.runId.length > 100)) return false;
  if (value.type === 'planner:begin' || value.type === 'planner:finish') return typeof value.runId === 'string';
  if (value.type === 'settings:get') return true;
  if (value.type === 'trial:get') return true;
  if (value.type === 'trial:finish') return typeof value.runId === 'string';
  if (value.type === 'settings:save') return Boolean(value.settings) && typeof value.settings === 'object';
  if (value.type === 'planner:cancel') return typeof value.requestId === 'string' && Boolean(value.requestId);
  if (value.type === 'planner:first') {
    return isSourceCapabilities(value.capabilities) && typeof value.requestId === 'string' && Boolean(value.requestId) && typeof value.query === 'string';
  }
  if (value.type === 'planner:feedback') {
    return isSourceCapabilities(value.capabilities) && typeof value.requestId === 'string' && Boolean(value.requestId) && Boolean(value.input) && typeof value.input === 'object'
      && (value.modelSearchNarrowingEnabled === undefined || typeof value.modelSearchNarrowingEnabled === 'boolean');
  }
  if (value.type === 'planner:rerank') {
    return isSourceCapabilities(value.capabilities) && typeof value.requestId === 'string' && Boolean(value.requestId) && isFinalRerankInput(value.input);
  }
  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '模型规划失败，请检查设置后重试';
}

function errorResponse(error: unknown) {
  return {
    ok: false as const,
    error: errorMessage(error),
    ...(error instanceof PlannerError || error instanceof TrialClientError ? { code: error.code } : {}),
  };
}

function createTransport(dependencies: BackgroundDependencies): PlannerTransport {
  return {
    async chatCompletions(settings, messages, signal) {
      const requestController = new AbortController();
      let timedOut = false;
      const forwardAbort = () => requestController.abort(signal?.reason);
      signal?.addEventListener('abort', forwardAbort, { once: true });
      if (signal?.aborted) forwardAbort();
      const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, MODEL_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await dependencies.fetch(chatCompletionsUrl(settings.llmBaseUrl), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${settings.llmApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: settings.llmModel,
              messages,
              response_format: { type: 'json_object' },
              enable_thinking: false,
              max_completion_tokens: MODEL_MAX_COMPLETION_TOKENS,
            }),
            signal: requestController.signal,
          });
        } catch (error) {
          if (timedOut) throw new PlannerError('模型调用超过 60 秒', 'model_timeout');
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw new PlannerError('模型请求已取消', 'model_cancelled');
          }
          throw new PlannerError('无法连接模型服务，请检查端点和网络');
        }
        if (!response.ok) throw new PlannerError(`模型服务返回 HTTP ${response.status}`);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          if (timedOut) throw new PlannerError('模型调用超过 60 秒', 'model_timeout');
          throw new PlannerError('模型服务没有返回有效 JSON');
        }
        const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new PlannerError('模型没有返回文本内容');
        return content;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

export function createMessageHandler(dependencies: BackgroundDependencies) {
  const transport = createTransport(dependencies);
  const trial = dependencies.trialStorage ? new TrialClient(dependencies.trialStorage, dependencies.fetch) : undefined;
  const plannerControllers = new Map<string, AbortController>();
  type ModelRun = { settings: Promise<ExtensionSettings>; expires: number; pending: Set<Promise<void>>; closing: boolean };
  const runSettings = new Map<string, ModelRun>();
  const newRun = (): ModelRun => ({ settings: dependencies.storage.get().then(normalizeSettings),
    expires: Date.now() + 2 * 60 * 60 * 1000, pending: new Set(), closing: false });
  return (message: unknown, sendResponse: SendResponse, sourceId?: string, documentId = ''): boolean => {
    if (!isExtensionRequest(message)) return false;
    const request = message;
    const type = request.type;
    const scopedKey = (id: string) => JSON.stringify([sourceId, documentId, id]);
    for (const [key, run] of runSettings) if (run.expires < Date.now() && !run.pending.size) runSettings.delete(key);

    if (type === 'planner:cancel') {
      plannerControllers.get(scopedKey(request.requestId))?.abort();
      sendResponse({ ok: true });
      return false;
    }

    const runKey = 'runId' in request && request.runId ? scopedKey(request.runId) : undefined;
    if (runKey && type === 'planner:begin' && !runSettings.has(runKey)) runSettings.set(runKey, newRun());
    const run = runKey ? runSettings.get(runKey) : undefined;
    const isModelCall = type === 'planner:first' || type === 'planner:feedback' || type === 'planner:rerank';
    if (run?.closing && (isModelCall || type === 'planner:begin')) {
      sendResponse(errorResponse(new PlannerError('搜索运行已结束，请重新开始搜索')));
      return false;
    }
    let releaseCall: (() => void) | undefined;
    const pendingCall = isModelCall && run ? new Promise<void>((resolve) => { releaseCall = resolve; }) : undefined;
    if (pendingCall) run!.pending.add(pendingCall);
    if (type === 'planner:finish' && run) run.closing = true;
    const plannerController = isModelCall ? new AbortController() : null;
    const keepAlive = (isModelCall || type === 'planner:finish') && dependencies.keepAlive
      ? setInterval(() => dependencies.keepAlive!(), 20_000) : undefined;
    if (plannerController && 'requestId' in request) plannerControllers.set(scopedKey(request.requestId), plannerController);

    void (async () => {
      try {
        if (type === 'planner:begin') {
          try { sendResponse({ ok: true, settings: publicSettings(await run!.settings) }); }
          catch (error) { runSettings.delete(runKey!); throw error; }
          return;
        }
        if (type === 'planner:finish') {
          if (run) {
            await Promise.allSettled([...run.pending]);
            const saved = await run.settings;
            if (!saved.llmApiKey && trial && sourceId === 'cc98') await trial.finish(request.runId);
            runSettings.delete(runKey!);
          }
          sendResponse({ ok: true });
          return;
        }
        if (type === 'trial:get' || type === 'trial:finish') {
          if (!trial || sourceId !== 'cc98') throw new TrialClientError('免费体验暂不可用，当前只开放 CC98', 'trial_unavailable');
          if (type === 'trial:get') sendResponse({ ok: true, trial: await trial.status() });
          else { await trial.finish(request.runId); sendResponse({ ok: true }); }
          return;
        }
        if (type === 'settings:get') {
          const settings = normalizeSettings(await dependencies.storage.get());
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }
        if (type === 'settings:save') {
          const requested = normalizeSettings(request.settings);
          if (!requested.llmModel) throw new Error('请先填写模型名称');
          const stored = normalizeSettings(await dependencies.storage.get());
          const settings = normalizeSettings({ ...requested, llmApiKey: requested.llmApiKey || stored.llmApiKey });
          if (settings.llmApiKey && !await dependencies.requestPermission(modelHostPermission(settings.llmBaseUrl))) throw new Error('未授予模型主机访问权限，设置没有保存');
          await dependencies.storage.set(settings);
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }

        if (runKey && !run) throw new PlannerError('搜索运行已失效，请重新开始搜索');
        const saved = run ? await run.settings : normalizeSettings(await dependencies.storage.get());
        if (!saved.llmApiKey) {
          if (!trial || sourceId !== 'cc98') throw new TrialClientError('免费体验暂不可用，当前只开放 CC98，请配置自己的 API Key', 'trial_unavailable');
          sendResponse(await trial.plan(request, plannerController!.signal));
          return;
        }
        const settings = validateSettings(saved);
        const plannerSettings = type === 'planner:feedback' && request.modelSearchNarrowingEnabled !== undefined
          ? { ...settings, modelSearchNarrowingEnabled: request.modelSearchNarrowingEnabled }
          : settings;
        const planner = new PlannerClient(transport, plannerSettings, request.capabilities);
        if (type === 'planner:first') {
          sendResponse({ ok: true, plan: await planner.planFirstRound(request.query, plannerController!.signal) });
        } else if (type === 'planner:feedback') {
          sendResponse({ ok: true, feedback: await planner.planFeedback(request.input as FeedbackInput, plannerController!.signal) });
        } else {
          sendResponse({ ok: true, rerank: await planner.rerankResults(request.input as import('./types').FinalRerankRequestInput, plannerController!.signal) });
        }
        plannerControllers.delete(scopedKey(request.requestId));
      } catch (error) {
        if ('requestId' in request) plannerControllers.delete(scopedKey(request.requestId));
        sendResponse(errorResponse(error));
      } finally {
        if (pendingCall) { run!.pending.delete(pendingCall); releaseCall!(); }
        if (keepAlive !== undefined) clearInterval(keepAlive);
        if ('requestId' in request) plannerControllers.delete(scopedKey(request.requestId));
      }
    })();
    return true;
  };
}

function browserDependencies(chromeApi: ChromeApi): BackgroundDependencies {
  return {
    trialStorage: {
      get: () => new Promise((resolve, reject) => {
        chromeApi.storage.local.get('trialCredential', (value) => {
          if (chromeApi.runtime.lastError) reject(new Error('读取试用资格失败'));
          else resolve(typeof value.trialCredential === 'string' ? value.trialCredential : undefined);
        });
      }),
      set: (token) => new Promise((resolve, reject) => {
        chromeApi.storage.local.set({ trialCredential: token }, () => {
          if (chromeApi.runtime.lastError) reject(new Error('保存试用资格失败'));
          else resolve();
        });
      }),
    },
    keepAlive: () => chromeApi.storage.local.get('__keepAlive', () => { void chromeApi.runtime.lastError; }),
    storage: {
      get: () => new Promise((resolve, reject) => {
        chromeApi.storage.local.get('settings', (value) => {
          if (chromeApi.runtime.lastError) reject(new Error('读取扩展设置失败'));
          else resolve((value.settings as StoredExtensionSettings) ?? {});
        });
      }),
      set: (settings) => new Promise((resolve, reject) => {
        chromeApi.storage.local.set({ settings }, () => {
          if (chromeApi.runtime.lastError) reject(new Error('保存扩展设置失败'));
          else resolve();
        });
      }),
    },
    requestPermission: (origin) => new Promise((resolve) => {
      chromeApi.permissions.request({ origins: [origin] }, resolve);
    }),
    fetch: (input, init) => fetch(input, init),
  };
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome;
if (chromeApi) {
  registerActionClick(chromeApi);
  const handler = createMessageHandler(browserDependencies(chromeApi));
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const senderUrl = (sender as { url?: unknown } | undefined)?.url;
    if (typeof senderUrl !== 'string' || !sourceRegistry.resolve(senderUrl)) return false;
    const senderIdentity = sender as { documentId?: string; tab?: { id?: number }; frameId?: number };
    return handler(message, sendResponse, sourceRegistry.resolve(senderUrl)?.id,
      senderIdentity.documentId ?? `${senderIdentity.tab?.id}:${senderIdentity.frameId}`);
  });
}
