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
      feedbackEvidenceLimit: 30,
      modelSearchNarrowingEnabled: false,
      finalRerankEnabled: true,
      finalRerankTopM: 30,
      searchBudgetSeconds: 300,
    });
    expect(modelHostPermission('https://models.example.com/openai/v1')).toBe('https://models.example.com/*');
  });

  it('defaults the request limit for fresh installs and legacy settings', () => {
    expect(normalizeSettings({}).searchRequestLimit).toBe(30);
    expect(normalizeSettings({ searchBudgetSeconds: 45 }).searchRequestLimit).toBe(30);
  });

  it('defaults model search narrowing off and rejects invalid stored values', () => {
    expect(normalizeSettings({}).modelSearchNarrowingEnabled).toBe(false);
    expect(normalizeSettings({ modelSearchNarrowingEnabled: true }).modelSearchNarrowingEnabled).toBe(true);
    expect(normalizeSettings({ modelSearchNarrowingEnabled: false }).modelSearchNarrowingEnabled).toBe(false);
    for (const value of [null, 'false', 0, {}, []]) {
      expect(normalizeSettings({ modelSearchNarrowingEnabled: value as boolean }).modelSearchNarrowingEnabled).toBe(false);
    }
  });

  it('defaults and clamps the feedback evidence limit to 10 through 100', () => {
    expect(normalizeSettings({}).feedbackEvidenceLimit).toBe(30);
    expect(normalizeSettings({ feedbackEvidenceLimit: 1 }).feedbackEvidenceLimit).toBe(10);
    expect(normalizeSettings({ feedbackEvidenceLimit: 101 }).feedbackEvidenceLimit).toBe(100);
    expect(normalizeSettings({ feedbackEvidenceLimit: 42.6 }).feedbackEvidenceLimit).toBe(43);
  });

  it('最终列表重排 Top-M 默认 30 并限制在 10 至 150', () => {
    expect(normalizeSettings({}).finalRerankTopM).toBe(30);
    expect(normalizeSettings({ finalRerankTopM: 1 }).finalRerankTopM).toBe(10);
    expect(normalizeSettings({ finalRerankTopM: 151 }).finalRerankTopM).toBe(150);
    expect(normalizeSettings({ finalRerankTopM: 42.6 }).finalRerankTopM).toBe(43);
  });

  it('migrates the legacy intent filter switch only when the new switch is absent', () => {
    expect(normalizeSettings({}).finalRerankEnabled).toBe(true);
    expect(normalizeSettings({ intentFilterEnabled: false })).toMatchObject({ finalRerankEnabled: false, finalRerankTopM: 30 });
    expect(normalizeSettings({ intentFilterEnabled: false, finalRerankEnabled: true }).finalRerankEnabled).toBe(true);
    expect(normalizeSettings({ intentFilterEnabled: false, finalRerankEnabled: null as unknown as boolean }).finalRerankEnabled).toBe(true);
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
