import { sourceRegistry } from './source-registry';
import { PlannerClient, PlannerError, type FeedbackInput, type PlannerTransport } from './planner';
import { chatCompletionsUrl, modelHostPermission, normalizeSettings, validateSettings } from './settings';
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
}

type SendResponse = (response: unknown) => void;

function publicSettings(settings: ExtensionSettings) {
  return { ...settings, llmApiKey: '', hasApiKey: Boolean(settings.llmApiKey) };
}

interface ChromeApi {
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
      && (item.author === undefined || typeof item.author === 'string')
      && (item.publishedAt === undefined || typeof item.publishedAt === 'string')
      && (item.section === undefined || typeof item.section === 'string')
      && (item.replyCount === undefined || (typeof item.replyCount === 'number' && Number.isFinite(item.replyCount)));
  });
}

function isExtensionRequest(message: unknown): message is ExtensionRequest {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.type === 'settings:get') return true;
  if (value.type === 'settings:save') return Boolean(value.settings) && typeof value.settings === 'object';
  if (value.type === 'planner:cancel') return typeof value.requestId === 'string' && Boolean(value.requestId);
  if (value.type === 'planner:first' || value.type === 'planner:blind') {
    return isSourceCapabilities(value.capabilities) && typeof value.requestId === 'string' && Boolean(value.requestId) && typeof value.query === 'string';
  }
  if (value.type === 'planner:feedback') {
    return isSourceCapabilities(value.capabilities) && typeof value.requestId === 'string' && Boolean(value.requestId) && Boolean(value.input) && typeof value.input === 'object';
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
    ...(error instanceof PlannerError ? { code: error.code } : {}),
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
          if (timedOut) throw new PlannerError('模型调用超过 20 秒', 'model_timeout');
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
          if (timedOut) throw new PlannerError('模型调用超过 20 秒', 'model_timeout');
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
  const plannerControllers = new Map<string, AbortController>();
  return (message: unknown, sendResponse: SendResponse): boolean => {
    if (!isExtensionRequest(message)) return false;
    const request = message;
    const type = request.type;

    if (type === 'planner:cancel') {
      plannerControllers.get(request.requestId)?.abort();
      sendResponse({ ok: true });
      return false;
    }

    const plannerController = type.startsWith('planner:') ? new AbortController() : null;
    if (plannerController && 'requestId' in request) plannerControllers.set(request.requestId, plannerController);

    void (async () => {
      try {
        if (type === 'settings:get') {
          const settings = normalizeSettings(await dependencies.storage.get());
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }
        if (type === 'settings:save') {
          const requested = normalizeSettings(request.settings);
          if (!requested.llmModel) throw new Error('请先填写模型名称');
          const permission = modelHostPermission(requested.llmBaseUrl);
          if (!await dependencies.requestPermission(permission)) throw new Error('未授予模型主机访问权限，设置没有保存');
          const stored = normalizeSettings(await dependencies.storage.get());
          const settings = validateSettings({ ...requested, llmApiKey: requested.llmApiKey || stored.llmApiKey });
          await dependencies.storage.set(settings);
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }

        const settings = validateSettings(await dependencies.storage.get());
        const planner = new PlannerClient(transport, settings, request.capabilities);
        if (type === 'planner:first') {
          sendResponse({ ok: true, plan: await planner.planFirstRound(request.query, plannerController!.signal) });
        } else if (type === 'planner:blind') {
          sendResponse({ ok: true, plan: await planner.planBlindExpansion(request.query, plannerController!.signal) });
        } else if (type === 'planner:feedback') {
          sendResponse({ ok: true, feedback: await planner.planFeedback(request.input as FeedbackInput, plannerController!.signal) });
        } else {
          sendResponse({ ok: true, rerank: await planner.rerankResults(request.input as import('./types').FinalRerankRequestInput, plannerController!.signal) });
        }
        plannerControllers.delete(request.requestId);
      } catch (error) {
        if ('requestId' in request) plannerControllers.delete(request.requestId);
        sendResponse(errorResponse(error));
      }
    })();
    return true;
  };
}

function browserDependencies(chromeApi: ChromeApi): BackgroundDependencies {
  return {
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
  const handler = createMessageHandler(browserDependencies(chromeApi));
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const senderUrl = (sender as { url?: unknown } | undefined)?.url;
    if (typeof senderUrl !== 'string' || !sourceRegistry.resolve(senderUrl)) return false;
    return handler(message, sendResponse);
  });
}
