import { PlannerClient, PlannerError, type FeedbackInput, type PlannerTransport } from './planner';
import { chatCompletionsUrl, modelHostPermission, normalizeSettings, validateSettings } from './settings';
import { DEFAULT_SETTINGS, type ExtensionSettings } from './types';

export interface SettingsStorage {
  get(): Promise<Partial<ExtensionSettings>>;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '模型规划失败，请检查设置后重试';
}

function createTransport(dependencies: BackgroundDependencies): PlannerTransport {
  return {
    async chatCompletions(settings, messages) {
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
          }),
        });
      } catch {
        throw new PlannerError('无法连接模型服务，请检查端点和网络');
      }
      if (!response.ok) throw new PlannerError(`模型服务返回 HTTP ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PlannerError('模型服务没有返回有效 JSON');
      }
      const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new PlannerError('模型没有返回文本内容');
      return content;
    },
  };
}

export function createMessageHandler(dependencies: BackgroundDependencies) {
  const transport = createTransport(dependencies);
  return (message: unknown, sendResponse: SendResponse): boolean => {
    if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return false;
    const request = message as Record<string, unknown>;
    const type = request.type;
    if (!['settings:get', 'settings:save', 'planner:first', 'planner:feedback', 'planner:blind'].includes(String(type))) return false;

    void (async () => {
      try {
        if (type === 'settings:get') {
          const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...await dependencies.storage.get() });
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }
        if (type === 'settings:save') {
          const requested = normalizeSettings(request.settings as Partial<ExtensionSettings>);
          if (!requested.llmModel) throw new Error('请先填写模型名称');
          const permission = modelHostPermission(requested.llmBaseUrl);
          if (!await dependencies.requestPermission(permission)) throw new Error('未授予模型主机访问权限，设置没有保存');
          const stored = normalizeSettings({ ...DEFAULT_SETTINGS, ...await dependencies.storage.get() });
          const settings = validateSettings({ ...requested, llmApiKey: requested.llmApiKey || stored.llmApiKey });
          await dependencies.storage.set(settings);
          sendResponse({ ok: true, settings: publicSettings(settings) });
          return;
        }

        const settings = validateSettings({ ...DEFAULT_SETTINGS, ...await dependencies.storage.get() });
        const planner = new PlannerClient(transport, settings);
        if (type === 'planner:first') {
          sendResponse({ ok: true, plan: await planner.planFirstRound(String(request.query ?? '')) });
        } else if (type === 'planner:blind') {
          sendResponse({ ok: true, plan: await planner.planBlindExpansion(String(request.query ?? '')) });
        } else {
          sendResponse({ ok: true, feedback: await planner.planFeedback(request.input as FeedbackInput) });
        }
      } catch (error) {
        sendResponse({ ok: false, error: errorMessage(error) });
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
          else resolve((value.settings as Partial<ExtensionSettings>) ?? {});
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
  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => handler(message, sendResponse));
}
