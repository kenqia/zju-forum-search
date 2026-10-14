export interface RelayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  dailyBudget: number;
  monthlyBudget: number;
  searchBudget: number;
  enabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): RelayConfig {
  if (env.TRIAL_ENABLED === 'true' && (!env.INPUT_CNY_PER_MILLION || !env.OUTPUT_CNY_PER_MILLION)) throw new Error('Explicit CNY token prices are required before enabling trials');
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  const baseUrl = env.MODEL_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid MODEL_BASE_URL');
  return {
    baseUrl: baseUrl.replace(/\/$/u, ''),
    apiKey: env.MODEL_API_KEY ?? '',
    model: env.MODEL_NAME ?? 'qwen3.8-27b',
    inputPrice: positive('INPUT_CNY_PER_MILLION', 3),
    outputPrice: positive('OUTPUT_CNY_PER_MILLION', 12),
    dailyBudget: positive('DAILY_BUDGET_CNY', 20),
    monthlyBudget: positive('MONTHLY_BUDGET_CNY', 100),
    searchBudget: positive('SEARCH_BUDGET_CNY', 1.5),
    enabled: env.TRIAL_ENABLED === 'true' && Boolean(env.MODEL_API_KEY),
  };
}
