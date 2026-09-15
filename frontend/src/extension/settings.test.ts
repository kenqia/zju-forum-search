import { describe, expect, it } from 'vitest';

import { modelHostPermission, normalizeSettings } from './settings';

describe('extension settings', () => {
  it('normalizes an OpenAI-compatible endpoint and budget', () => {
    expect(normalizeSettings({
      llmBaseUrl: 'https://models.example.com/openai/v1/',
      llmApiKey: '  key-value  ',
      llmModel: ' qwen-test ',
      searchBudgetSeconds: 999,
    })).toEqual({
      llmBaseUrl: 'https://models.example.com/openai/v1',
      llmApiKey: 'key-value',
      llmModel: 'qwen-test',
      searchBudgetSeconds: 300,
    });
    expect(modelHostPermission('https://models.example.com/openai/v1')).toBe('https://models.example.com/*');
  });

  it('rejects non-http model endpoints', () => {
    expect(() => modelHostPermission('file:///tmp/model')).toThrow('模型端点必须使用 HTTP 或 HTTPS');
  });
});
