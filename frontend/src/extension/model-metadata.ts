import type { Candidate, FeedbackEvidence } from './types';

export const MODEL_TITLE_LIMIT = 80;
const MODEL_SECTION_LIMIT = 80;
const MODEL_TIME_LIMIT = 40;

/** Project a local candidate onto the only metadata fields models may receive. */
export function modelMetadata(candidate: Candidate): FeedbackEvidence {
  return {
    title: candidate.titleOrigin === 'native' ? candidate.title.slice(0, MODEL_TITLE_LIMIT) : '',
    ...(candidate.publishedAt !== undefined && { publishedAt: candidate.publishedAt.slice(0, MODEL_TIME_LIMIT) }),
    ...(candidate.section !== undefined && { section: candidate.section.slice(0, MODEL_SECTION_LIMIT) }),
    ...(candidate.replyCount !== undefined && Number.isFinite(candidate.replyCount) && { replyCount: candidate.replyCount }),
  };
}

/** Reapply the same whitelist when converting metadata to the wire field names. */
export function modelMetadataPayload(candidate: FeedbackEvidence) {
  return {
    title: candidate.title.slice(0, MODEL_TITLE_LIMIT),
    board: (candidate.section ?? '').slice(0, MODEL_SECTION_LIMIT),
    time: (candidate.publishedAt ?? '').slice(0, MODEL_TIME_LIMIT),
    reply_count: candidate.replyCount ?? 0,
  };
}
