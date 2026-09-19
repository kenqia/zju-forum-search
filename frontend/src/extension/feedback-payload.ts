import type { Candidate, FeedbackRequestInput } from './types';
import { MODEL_TITLE_LIMIT, modelMetadata, modelMetadataPayload } from './model-metadata';

export const FEEDBACK_TITLE_LIMIT = MODEL_TITLE_LIMIT;
export const FEEDBACK_CANDIDATE_LIMIT = 160;
export const FEEDBACK_METADATA_BYTE_LIMIT = 4000;

/** Construct the only candidate representation allowed across the planner port. */
export function createFeedbackInput(
  input: Omit<FeedbackRequestInput, 'newCandidates'> & { newCandidates: Candidate[] },
): FeedbackRequestInput {
  const result: FeedbackRequestInput = {
    query: input.query.slice(0, 500), round: input.round, executedSearches: [], newCandidates: [],
  };
  const encoder = new TextEncoder();
  const fits = () => encoder.encode(JSON.stringify(result)).byteLength <= FEEDBACK_METADATA_BYTE_LIMIT;
  for (const search of input.executedSearches.slice(0, 30)) {
    result.executedSearches.push({ query: search.query.slice(0, 120), hitCount: search.hitCount });
    if (!fits()) { result.executedSearches.pop(); break; }
  }
  for (const candidate of input.newCandidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    result.newCandidates.push(modelMetadata(candidate));
    if (!fits()) { result.newCandidates.pop(); break; }
  }
  return result;
}

/** Reapply the whitelist at serialization, including the date in the byte budget. */
export function buildFeedbackPayload(input: FeedbackRequestInput, currentDate?: string) {
  const encoder = new TextEncoder();
  const payload = {
    query: input.query.slice(0, 500),
    ...(currentDate ? { current_date: currentDate } : {}),
    round: input.round,
    executed_searches: [] as { query: string; hitCount: number }[],
    new_candidates: [] as { title: string; author: string; board: string; time: string; reply_count: number }[],
  };
  for (const search of input.executedSearches.slice(0, 30)) {
    payload.executed_searches.push({ query: search.query.slice(0, 120), hitCount: search.hitCount });
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.executed_searches.pop();
      break;
    }
  }
  for (const candidate of input.newCandidates.slice(0, FEEDBACK_CANDIDATE_LIMIT)) {
    payload.new_candidates.push(modelMetadataPayload(candidate));
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.new_candidates.pop();
      break;
    }
  }
  return payload;
}
