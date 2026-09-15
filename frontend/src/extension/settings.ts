import { DEFAULT_SETTINGS, type ExtensionSettings } from './types';

const MIN_BUDGET_SECONDS = 10;
const MAX_BUDGET_SECONDS = 300;

function parseHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('模型端点不是有效 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('模型端点必须使用 HTTP 或 HTTPS');
  }
  if (parsed.username || parsed.password) throw new Error('模型端点不能包含用户名或密码');
  return parsed;
}

export function normalizeSettings(value: Partial<ExtensionSettings>): ExtensionSettings {
  const baseUrl = parseHttpUrl(value.llmBaseUrl ?? DEFAULT_SETTINGS.llmBaseUrl);
  baseUrl.search = '';
  baseUrl.hash = '';
  const budget = Number(value.searchBudgetSeconds ?? DEFAULT_SETTINGS.searchBudgetSeconds);
  return {
    llmBaseUrl: baseUrl.toString().replace(/\/$/u, ''),
    llmApiKey: String(value.llmApiKey ?? '').trim(),
    llmModel: String(value.llmModel ?? '').trim(),
    searchBudgetSeconds: Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, Number.isFinite(budget) ? Math.round(budget) : DEFAULT_SETTINGS.searchBudgetSeconds)),
  };
}

export function validateSettings(value: Partial<ExtensionSettings>): ExtensionSettings {
  const settings = normalizeSettings(value);
  if (!settings.llmApiKey) throw new Error('请先填写模型 API key');
  if (!settings.llmModel) throw new Error('请先填写模型名称');
  return settings;
}

export function modelHostPermission(baseUrl: string): string {
  const url = parseHttpUrl(baseUrl);
  return `${url.origin}/*`;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeSettings({ llmBaseUrl: baseUrl }).llmBaseUrl}/chat/completions`;
}
