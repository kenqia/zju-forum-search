import { modelMetadataPayload } from './model-metadata';
import { folded } from './text';
import type { FeedbackCandidate, FeedbackRequestInput } from './types';

export const FEEDBACK_CANDIDATE_LIMIT = 100;
export const FEEDBACK_METADATA_BYTE_LIMIT = 4000;

function sanitizedCandidate(candidate: FeedbackCandidate): FeedbackCandidate {
  const matchedQueries: string[] = [];
  const seenQueries = new Set<string>();
  for (let index = candidate.matchedQueries.length - 1; index >= 0 && matchedQueries.length < 3; index -= 1) {
    const query = candidate.matchedQueries[index].slice(0, 120);
    const key = folded(query);
    if (!key || seenQueries.has(key)) continue;
    seenQueries.add(key);
    matchedQueries.unshift(query);
  }
  return {
    key: candidate.key.slice(0, 40),
    title: candidate.title.slice(0, 80),
    ...(candidate.publishedAt !== undefined && { publishedAt: candidate.publishedAt.slice(0, 40) }),
    ...(candidate.section !== undefined && { section: candidate.section.slice(0, 80) }),
    ...(candidate.replyCount !== undefined && Number.isFinite(candidate.replyCount) && { replyCount: candidate.replyCount }),
    matchedQueries,
  };
}

/** First whitelist: construct the only candidate representation allowed across the planner port. */
export function createFeedbackInput(input: FeedbackRequestInput): FeedbackRequestInput {
  const result: FeedbackRequestInput = {
    query: input.query.slice(0, 500), executedSearches: [], candidates: [],
  };
  const encoder = new TextEncoder();
  const fits = () => encoder.encode(JSON.stringify(result)).byteLength <= FEEDBACK_METADATA_BYTE_LIMIT;
  for (const candidate of input.candidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    result.candidates.push(sanitizedCandidate(candidate));
    if (!fits()) { result.candidates.pop(); break; }
  }
  for (const search of input.executedSearches.slice(0, 30)) {
    result.executedSearches.push({ query: search.query.slice(0, 120), hitCount: search.hitCount });
    if (!fits()) { result.executedSearches.pop(); break; }
  }
  return result;
}

/** Second whitelist: re-project fields during serialization and enforce the complete byte cap. */
export function buildFeedbackPayload(input: FeedbackRequestInput, currentDate?: string) {
  const encoder = new TextEncoder();
  const payload = {
    query: input.query.slice(0, 500),
    ...(currentDate ? { current_date: currentDate } : {}),
    executed_searches: [] as { query: string; hit_count: number }[],
    candidates: [] as Array<ReturnType<typeof modelMetadataPayload> & { key: string; matched_queries: string[] }>,
  };
  for (const raw of input.candidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    const candidate = sanitizedCandidate(raw);
    payload.candidates.push({ key: candidate.key, ...modelMetadataPayload(candidate), matched_queries: candidate.matchedQueries });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.candidates.pop();
      break;
    }
  }
  for (const search of input.executedSearches.slice(0, 30)) {
    payload.executed_searches.push({ query: search.query.slice(0, 120), hit_count: search.hitCount });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.executed_searches.pop();
      break;
    }
  }
  return payload;
}
