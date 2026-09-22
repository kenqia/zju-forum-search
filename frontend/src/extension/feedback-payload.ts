import { modelMetadataPayload } from './model-metadata';
import { folded, normalizeText } from './text';
import type { FeedbackCandidate, FeedbackRequestInput, SearchLedgerEntry } from './types';

export const FEEDBACK_CANDIDATE_LIMIT = 100;
export const FEEDBACK_METADATA_BYTE_LIMIT = 4000;
export const FEEDBACK_SEARCH_QUERY_LIMIT = 120;

function sanitizedCandidate(candidate: FeedbackCandidate): FeedbackCandidate {
  const matchedQueries: string[] = [];
  const seenQueries = new Set<string>();
  for (let index = candidate.matchedQueries.length - 1; index >= 0 && matchedQueries.length < 3; index -= 1) {
    const query = normalizeText(candidate.matchedQueries[index]).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT);
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

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function sanitizedLedgerEntry(entry: SearchLedgerEntry): SearchLedgerEntry {
  return {
    query: normalizeText(entry.query).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT),
    pages: nonNegativeInteger(entry.pages),
    hits: nonNegativeInteger(entry.hits),
    uniqueCandidates: nonNegativeInteger(entry.uniqueCandidates),
    newOnLastPage: nonNegativeInteger(entry.newOnLastPage),
    grade23: nonNegativeInteger(entry.grade23),
    grade0: nonNegativeInteger(entry.grade0),
    canContinue: entry.canContinue === true,
  };
}

/** First whitelist: construct the only candidate representation allowed across the planner port. */
export function createFeedbackInput(input: FeedbackRequestInput): FeedbackRequestInput {
  const result: FeedbackRequestInput = {
    query: input.query.slice(0, 500),
    ...(input.remainingRequests !== undefined && { remainingRequests: nonNegativeInteger(input.remainingRequests) }),
    executedSearches: [],
    ...(input.searchLedger !== undefined && { searchLedger: [] }),
    candidates: [],
  };
  const encoder = new TextEncoder();
  const fits = () => encoder.encode(JSON.stringify(result)).byteLength <= FEEDBACK_METADATA_BYTE_LIMIT;
  for (const entry of (input.searchLedger ?? []).slice(0, 30)) {
    result.searchLedger!.push(sanitizedLedgerEntry(entry));
    if (!fits()) result.searchLedger!.pop();
  }
  for (const search of input.executedSearches.slice(0, 30)) {
    result.executedSearches.push({ query: normalizeText(search.query).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT), hitCount: search.hitCount });
    if (!fits()) result.executedSearches.pop();
  }
  for (const candidate of input.candidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    result.candidates.push(sanitizedCandidate(candidate));
    if (!fits()) result.candidates.pop();
  }
  return result;
}

/** Second whitelist: re-project fields during serialization and enforce the complete byte cap. */
export function buildFeedbackPayload(input: FeedbackRequestInput, currentDate?: string) {
  const encoder = new TextEncoder();
  const payload = {
    query: input.query.slice(0, 500),
    ...(currentDate ? { current_date: currentDate } : {}),
    ...(input.remainingRequests !== undefined && { remaining_requests: nonNegativeInteger(input.remainingRequests) }),
    ...(input.searchLedger !== undefined && { search_ledger: [] as Array<{
      query: string; pages: number; hits: number; unique_candidates: number; new_on_last_page: number;
      grade_2_3: number; grade_0: number; can_continue: boolean;
    }> }),
    executed_searches: [] as { query: string; hit_count: number }[],
    candidates: [] as Array<ReturnType<typeof modelMetadataPayload> & { key: string; matched_queries: string[] }>,
  };
  for (const raw of (input.searchLedger ?? []).slice(0, 30)) {
    const entry = sanitizedLedgerEntry(raw);
    payload.search_ledger!.push({
      query: entry.query, pages: entry.pages, hits: entry.hits, unique_candidates: entry.uniqueCandidates,
      new_on_last_page: entry.newOnLastPage, grade_2_3: entry.grade23, grade_0: entry.grade0,
      can_continue: entry.canContinue,
    });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) payload.search_ledger!.pop();
  }
  for (const search of input.executedSearches.slice(0, 30)) {
    payload.executed_searches.push({ query: normalizeText(search.query).slice(0, FEEDBACK_SEARCH_QUERY_LIMIT), hit_count: search.hitCount });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.executed_searches.pop();
    }
  }
  for (const raw of input.candidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    const candidate = sanitizedCandidate(raw);
    payload.candidates.push({ key: candidate.key, ...modelMetadataPayload(candidate), matched_queries: candidate.matchedQueries });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.candidates.pop();
    }
  }
  return payload;
}
