import type { Candidate, FeedbackEvidence, FeedbackRequestInput } from './types';

export const FEEDBACK_TITLE_LIMIT = 80;
export const FEEDBACK_CANDIDATE_LIMIT = 160;
export const FEEDBACK_METADATA_BYTE_LIMIT = 4000;

function evidence(candidate: Candidate): FeedbackEvidence {
  return {
    // Missing or unrecognised provenance is never permission to send a title.
    title: candidate.titleOrigin === 'native' ? candidate.title.slice(0, FEEDBACK_TITLE_LIMIT) : '',
    ...(candidate.author !== undefined && { author: candidate.author.slice(0, 80) }),
    ...(candidate.publishedAt !== undefined && { publishedAt: candidate.publishedAt.slice(0, 40) }),
    ...(candidate.section !== undefined && { section: candidate.section.slice(0, 80) }),
    ...(candidate.replyCount !== undefined && Number.isFinite(candidate.replyCount) && { replyCount: candidate.replyCount }),
  };
}

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
    result.newCandidates.push(evidence(candidate));
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
    const approved = {
      title: candidate.title.slice(0, FEEDBACK_TITLE_LIMIT),
      author: (candidate.author ?? '').slice(0, 80),
      board: (candidate.section ?? '').slice(0, 80),
      time: (candidate.publishedAt ?? '').slice(0, 40),
      reply_count: candidate.replyCount ?? 0,
    };
    payload.new_candidates.push(approved);
    if (encoder.encode(JSON.stringify(payload)).byteLength > FEEDBACK_METADATA_BYTE_LIMIT) {
      payload.new_candidates.pop();
      break;
    }
  }
  return payload;
}
