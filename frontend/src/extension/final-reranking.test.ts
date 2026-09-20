import { describe, expect, it } from 'vitest';

import {
  applyFinalRerankPlan,
  buildFinalRerankPayload,
  createFinalRerankSelection,
  normalizeFinalRerankPlan,
} from './final-reranking';
import type { RetrievedCandidate, TopicCandidate } from './types';

function entry(id: string, grade?: 0 | 1 | 2 | 3, titleOrigin: 'native' | 'body-derived' = 'native'): RetrievedCandidate {
  return {
    candidate: {
      sourceId: titleOrigin === 'native' ? 'cc98' : 'duo',
      id,
      title: `title-${id}`,
      titleOrigin,
      url: `https://example.com/${id}`,
      author: `author-${id}`,
      section: 'board',
      publishedAt: '2026-09-20',
      replyCount: 3,
    },
    documents: [],
    observations: [],
    temporaryKey: `c-${id}`,
    ...(grade === undefined ? {} : { relevanceGrade: grade }),
  };
}

function topic(id: string): TopicCandidate {
  return {
    id,
    title: `title-${id}`,
    board: 'board',
    time: '2026-09-20',
    author: `author-${id}`,
    replyCount: 3,
    url: `https://example.com/${id}`,
    firstRound: 1,
  };
}

describe('最终列表重排', () => {
  it('只选择本地预排序 Top-M 主结果候选，并在序列化时再次应用元数据白名单', () => {
    const entries = [entry('grade-zero', 0), entry('duo', undefined, 'body-derived'), entry('judged', 2), entry('outside')];
    const results = [topic('duo'), topic('judged'), topic('outside')];

    const selection = createFinalRerankSelection('  找资料  ', results, entries, 2);

    expect(selection?.input).toEqual({
      query: '找资料',
      candidates: [
        { key: 'c-duo', title: '', author: 'author-duo', section: 'board', publishedAt: '2026-09-20', replyCount: 3 },
        { key: 'c-judged', title: 'title-judged', author: 'author-judged', section: 'board', publishedAt: '2026-09-20', replyCount: 3 },
      ],
    });
    expect(buildFinalRerankPayload(selection!.input)).toEqual({
      query: '找资料',
      candidates: [
        { key: 'c-duo', title: '', author: 'author-duo', board: 'board', time: '2026-09-20', reply_count: 3 },
        { key: 'c-judged', title: 'title-judged', author: 'author-judged', board: 'board', time: '2026-09-20', reply_count: 3 },
      ],
    });
    expect(JSON.stringify(buildFinalRerankPayload(selection!.input))).not.toMatch(/grade|sourceId|url|observations|documents/u);
  });

  it('规范化部分顺序并忽略重复键和未知键', () => {
    const validKeys = new Set(['c-a', 'c-b', 'c-c']);

    expect(normalizeFinalRerankPlan({ ordered_keys: ['c-b', 'unknown', 'c-b'], remove_keys: ['c-c', 'c-c', 'unknown'] }, validKeys)).toEqual({
      orderedKeys: ['c-b'],
      removeKeys: ['c-c'],
    });
    expect(normalizeFinalRerankPlan({ ordered_keys: ['c-a'] }, validKeys)).toEqual({ orderedKeys: ['c-a'], removeKeys: [] });
    expect(normalizeFinalRerankPlan({ remove_keys: ['c-a'] }, validKeys)).toEqual({ orderedKeys: [], removeKeys: ['c-a'] });
  });

  it('跨相关性等级排序，只删除请求前未判断的候选，并保留 Top-M 外顺序', () => {
    const entries = [entry('grade-3', 3), entry('unjudged'), entry('grade-1', 1), entry('tail')];
    const localResults = entries.map(({ candidate }) => topic(candidate.id));
    const selection = createFinalRerankSelection('资料', localResults, entries, 3)!;

    const outcome = applyFinalRerankPlan(localResults, selection, {
      orderedKeys: ['c-grade-1', 'c-unjudged', 'c-grade-3'],
      removeKeys: ['c-grade-3', 'c-grade-1', 'c-unjudged'],
    });

    expect(outcome.results.map((candidate) => candidate.id)).toEqual(['grade-1', 'grade-3', 'tail']);
    expect(outcome.removedCount).toBe(1);
  });

  it('主结果候选为零条或一条时跳过', () => {
    expect(createFinalRerankSelection('资料', [], [], 30)).toBeNull();
    expect(createFinalRerankSelection('资料', [topic('one')], [entry('one')], 30)).toBeNull();
  });
});
