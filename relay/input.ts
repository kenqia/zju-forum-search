import type { FeedbackRequestInput, FinalRerankRequestInput } from '../frontend/src/extension/types';
import { TrialError } from './store';

type RecordValue = Record<string, unknown>;
function object(value: unknown, allowed: string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new TrialError('trial_invalid', 400);
  return value as RecordValue;
}
function string(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) throw new TrialError('trial_invalid', 400);
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e9) throw new TrialError('trial_invalid', 400);
  return value;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new TrialError('trial_invalid', 400);
  return value.map(parse);
}
function evidence(value: unknown, final: boolean) {
  const item = object(value, ['key', 'title', 'publishedAt', 'section', 'replyCount', 'matchedQueries', ...(final ? ['independentQueryCount', 'bestSourcePosition'] : [])]);
  return {
    key: string(item.key, 40), title: string(item.title, 500),
    matchedQueries: list(item.matchedQueries, final ? 5 : 3, (value) => string(value, 120)),
    ...(item.publishedAt !== undefined ? { publishedAt: string(item.publishedAt, 40) } : {}),
    ...(item.section !== undefined ? { section: string(item.section, 80) } : {}),
    ...(item.replyCount !== undefined ? { replyCount: count(item.replyCount) } : {}),
  };
}
export function parseRequest(raw: unknown) {
  const request = object(raw, ['kind', 'runId', 'query', 'input', 'modelSearchNarrowingEnabled']);
  const runId = string(request.runId, 36);
  if (!/^[0-9a-f-]{36}$/u.test(runId)) throw new TrialError('trial_invalid', 400);
  if (request.modelSearchNarrowingEnabled !== undefined && typeof request.modelSearchNarrowingEnabled !== 'boolean') throw new TrialError('trial_invalid', 400);
  if (request.kind === 'first') {
    const query = string(request.query).trim();
    if (!query || request.input !== undefined) throw new TrialError('trial_invalid', 400);
    return { kind: 'first' as const, runId, query };
  }
  const input = object(request.input, request.kind === 'feedback'
    ? ['query', 'remainingRequests', 'executedSearches', 'searchLedger', 'candidates'] : ['query', 'candidates']);
  const query = string(input.query);
  if (request.kind === 'feedback') {
    const feedback: FeedbackRequestInput = {
      query,
      ...(input.remainingRequests !== undefined ? { remainingRequests: Math.min(30, count(input.remainingRequests)) } : {}),
      executedSearches: list(input.executedSearches, 30, (value) => {
        const entry = object(value, ['query', 'hitCount']);
        return { query: string(entry.query, 120), hitCount: count(entry.hitCount) };
      }),
      candidates: list(input.candidates, 100, (value) => evidence(value, false)),
      ...(input.searchLedger !== undefined ? { searchLedger: list(input.searchLedger, 30, (value) => {
        const entry = object(value, ['query', 'pages', 'hits', 'uniqueCandidates', 'newOnLastPage', 'grade23', 'grade0', 'canContinue']);
        if (typeof entry.canContinue !== 'boolean') throw new TrialError('trial_invalid', 400);
        return { query: string(entry.query, 120), pages: count(entry.pages), hits: count(entry.hits),
          uniqueCandidates: count(entry.uniqueCandidates), newOnLastPage: count(entry.newOnLastPage),
          grade23: count(entry.grade23), grade0: count(entry.grade0), canContinue: entry.canContinue };
      }) } : {}),
    };
    return { kind: 'feedback' as const, runId, input: feedback, narrowing: request.modelSearchNarrowingEnabled === true };
  }
  if (request.kind === 'rerank') {
    const rerank: FinalRerankRequestInput = { query, candidates: list(input.candidates, 30, (value) => {
      const entry = value as RecordValue;
      const candidate = evidence(value, true);
      return { ...candidate, independentQueryCount: count(entry.independentQueryCount),
        bestSourcePosition: entry.bestSourcePosition === null ? null : count(entry.bestSourcePosition) };
    }) };
    if (rerank.candidates.length < 2) throw new TrialError('trial_invalid', 400);
    return { kind: 'rerank' as const, runId, input: rerank };
  }
  throw new TrialError('trial_invalid', 400);
}
