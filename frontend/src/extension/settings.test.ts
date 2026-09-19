import { describe, expect, it } from 'vitest';

import { modelHostPermission, normalizeSettings } from './settings';

describe('extension settings', () => {
  it('normalizes an OpenAI-compatible endpoint and request limit', () => {
    expect(normalizeSettings({
      llmBaseUrl: 'https://models.example.com/openai/v1/',
      llmApiKey: '  key-value  ',
      llmModel: ' qwen-test ',
      searchRequestLimit: 999,
      searchBudgetSeconds: 999,
    })).toEqual({
      llmBaseUrl: 'https://models.example.com/openai/v1',
      llmApiKey: 'key-value',
      llmModel: 'qwen-test',
      searchRequestLimit: 100,
      intentFilterEnabled: true,
      searchBudgetSeconds: 300,
    });
    expect(modelHostPermission('https://models.example.com/openai/v1')).toBe('https://models.example.com/*');
  });

  it('defaults the request limit for fresh installs and legacy settings', () => {
    expect(normalizeSettings({}).searchRequestLimit).toBe(30);
    expect(normalizeSettings({ searchBudgetSeconds: 45 }).searchRequestLimit).toBe(30);
  });

  it('falls back to the default request limit for invalid values', () => {
    for (const value of [Number.NaN, 'abc', '', null, Number.POSITIVE_INFINITY]) {
      expect(normalizeSettings({ searchRequestLimit: value as number }).searchRequestLimit).toBe(30);
    }
    expect(normalizeSettings({ searchRequestLimit: 0 }).searchRequestLimit).toBe(1);
  });

  it('rejects non-http model endpoints', () => {
    expect(() => modelHostPermission('file:///tmp/model')).toThrow('模型端点必须使用 HTTP 或 HTTPS');
  });
});
