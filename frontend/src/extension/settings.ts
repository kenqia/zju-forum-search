import { DEFAULT_SETTINGS, type ExtensionSettings } from './types';

const MIN_BUDGET_SECONDS = 10;
const MAX_BUDGET_SECONDS = 300;
const MIN_REQUEST_LIMIT = 1;
const MAX_REQUEST_LIMIT = 100;
const MIN_FEEDBACK_EVIDENCE_LIMIT = 10;
const MAX_FEEDBACK_EVIDENCE_LIMIT = 100;

function clampedCount(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'string' && !value.trim()) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

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
    searchRequestLimit: clampedCount(value.searchRequestLimit ?? DEFAULT_SETTINGS.searchRequestLimit, MIN_REQUEST_LIMIT, MAX_REQUEST_LIMIT, DEFAULT_SETTINGS.searchRequestLimit),
    feedbackEvidenceLimit: clampedCount(value.feedbackEvidenceLimit ?? DEFAULT_SETTINGS.feedbackEvidenceLimit, MIN_FEEDBACK_EVIDENCE_LIMIT, MAX_FEEDBACK_EVIDENCE_LIMIT, DEFAULT_SETTINGS.feedbackEvidenceLimit),
    intentFilterEnabled: typeof value.intentFilterEnabled === 'boolean' ? value.intentFilterEnabled : DEFAULT_SETTINGS.intentFilterEnabled,
    searchBudgetSeconds: clampedCount(budget, MIN_BUDGET_SECONDS, MAX_BUDGET_SECONDS, DEFAULT_SETTINGS.searchBudgetSeconds),
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
