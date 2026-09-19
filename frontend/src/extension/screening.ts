import { modelMetadata, modelMetadataPayload } from './model-metadata';
import type { Candidate, ScreeningCandidate, ScreeningPlan, ScreeningRequestInput, TopicCandidate } from './types';

export const SCREENING_BATCH_CANDIDATE_LIMIT = 160;
export const SCREENING_BATCH_BYTE_LIMIT = 4000;

/** Whitelist projection: only batch-local keys plus metadata the model may see. */
function screeningEntry(candidate: Candidate, key: string): ScreeningCandidate {
  return { key, ...modelMetadata(candidate) };
}

/**
 * Split all recalled candidates into screening batches without reordering them.
 * Each batch holds at most SCREENING_BATCH_CANDIDATE_LIMIT entries and the
 * wire payload from buildScreeningPayload stays under SCREENING_BATCH_BYTE_LIMIT.
 */
export function createScreeningBatches(query: string, candidates: Candidate[]): ScreeningRequestInput[] {
  const trimmedQuery = query.slice(0, 500);
  const encoder = new TextEncoder();
  const batches: ScreeningRequestInput[] = [];
  let current: ScreeningCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = screeningEntry(candidates[index], `r${index}`);
    const wouldFit = current.length < SCREENING_BATCH_CANDIDATE_LIMIT
      && encoder.encode(JSON.stringify(buildScreeningPayload({ query: trimmedQuery, candidates: [...current, entry] }))).byteLength <= SCREENING_BATCH_BYTE_LIMIT;
    if (!wouldFit && current.length) {
      batches.push({ query: trimmedQuery, candidates: current });
      current = [];
    }
    current.push(entry);
  }
  if (current.length) batches.push({ query: trimmedQuery, candidates: current });
  return batches;
}

/** Reapply the whitelist at serialization so only approved fields reach the wire. */
export function buildScreeningPayload(input: ScreeningRequestInput) {
  return {
    query: input.query.slice(0, 500),
    candidates: input.candidates.slice(0, SCREENING_BATCH_CANDIDATE_LIMIT).map((candidate) => ({
      key: candidate.key.slice(0, 40),
      ...modelMetadataPayload(candidate),
    })),
  };
}

/** Strict wire shape: any deviation fails the whole screening run. */
export function assertScreeningShape(value: unknown): asserts value is { remove_keys: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'remove_keys')
    || !Array.isArray((value as Record<string, unknown>).remove_keys)
    || !(value as { remove_keys: unknown[] }).remove_keys.every((key) => typeof key === 'string')) {
    throw new Error('模型返回的筛选结构无效');
  }
}

/** Keep only keys that exist in this batch; unknown keys are ignored. */
export function normalizeScreeningPlan(raw: { remove_keys: string[] }, validKeys: Set<string>): { removeKeys: string[] } {
  return { removeKeys: [...new Set(raw.remove_keys.map((key) => key.trim()).filter((key) => validKeys.has(key)))] };
}

export interface ScreeningRunInput {
  query: string;
  candidates: Candidate[];
  visibleResults: TopicCandidate[];
  signal: AbortSignal;
  onStart?(batchCount: number): void;
  onProgress?(completedBatchCount: number, batchCount: number): void;
  request(input: ScreeningRequestInput, signal: AbortSignal): Promise<ScreeningPlan>;
}

/** Screen the complete recalled set, then apply all accepted removals to the visible list at once. */
export async function runFinalScreening(input: ScreeningRunInput): Promise<{ results: TopicCandidate[]; removedCount: number; batchCount: number }> {
  const batches = createScreeningBatches(input.query, input.candidates);
  input.onStart?.(batches.length);
  const keyToId = new Map(input.candidates.map((candidate, index) => [`r${index}`, candidate.id]));
  const removedIds = new Set<string>();
  for (const [index, batch] of batches.entries()) {
    const plan = await input.request(batch, input.signal);
    for (const key of plan.removeKeys) {
      const id = keyToId.get(key);
      if (id) removedIds.add(id);
    }
    input.onProgress?.(index + 1, batches.length);
  }
  const results = input.visibleResults.filter((result) => !removedIds.has(result.id));
  return {
    results,
    removedCount: input.visibleResults.length - results.length,
    batchCount: batches.length,
  };
}
