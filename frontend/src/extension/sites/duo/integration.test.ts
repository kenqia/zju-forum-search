import { describe, expect, it, vi } from 'vitest';
import { SearchSession } from '../../search-session';
import { PlannerClient } from '../../planner';
import { DEFAULT_SETTINGS } from '../../types';
import { DuoSourceSession, DUO_CAPABILITIES } from './index';
import { receiveEnvelope, testPublicKey } from './test-server';

describe('Duo through the unchanged search core', () => {
  it('recalls, ranks and feeds back metadata without sending body-derived titles to the model', async () => {
    const messages: { role: string; content: string }[][] = [];
    const planner = new PlannerClient({ chatCompletions: async (_settings, input) => {
      messages.push(input);
      if (messages.length === 1) {
        return JSON.stringify({ searches: ['校园合成词'], required_concepts: [{ name: '课程', expressions: ['微积分'] }] });
      }
      if (messages.length === 2) {
        return JSON.stringify({ judgments: [], new_searches: [], learned_terms: [], stop_suggestions: [], should_stop: true, reasoning: '' });
      }
      return JSON.stringify({ remove_keys: [] });
    } }, DEFAULT_SETTINGS, DUO_CAPABILITIES);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const receiver = receiveEnvelope(String(init?.body));
      return new Response(receiver.respond({ status: 0, result: { entry: [
        { sns_id: 1, content: '无关合成文本', nickname: '作者甲' },
        { sns_id: 2, content: '微积分正文只供本地匹配', nickname: '作者乙' },
      ], timestamp: 123, needCode: false } }));
    });
    const source = new DuoSourceSession('synthetic', { fetch, publicKey: testPublicKey });
    const result = await new SearchSession({ source, planner, sleep: async () => undefined }).run('课程资料', 60);
    expect(result.stopReason).toBe('model_stop');
    expect(result.results.map((item) => item.id)).toEqual(['2', '1']);
    expect(result.results[0].url).toBe('https://www.duoduo.link/a/2');
    expect(fetch).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(3);
    expect(messages[0][0].content).toContain('匹配全文');
    expect(JSON.parse(messages[1][1].content).candidates).toEqual([
      { key: 'c1', matched_queries: ['校园合成词'], title: '', author: '作者乙', board: '', time: '', reply_count: 0 },
      { key: 'c0', matched_queries: ['校园合成词'], title: '', author: '作者甲', board: '', time: '', reply_count: 0 },
    ]);
    expect(messages[1][1].content).not.toContain('正文只供本地匹配');
  });
});
