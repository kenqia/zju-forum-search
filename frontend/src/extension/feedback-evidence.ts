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
