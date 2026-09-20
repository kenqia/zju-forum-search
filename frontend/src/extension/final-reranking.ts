import { modelMetadata, modelMetadataPayload } from './model-metadata';
import { normalizeText } from './text';
import type {
  FinalRerankCandidate,
  FinalRerankPlan,
  FinalRerankRequestInput,
  RetrievedCandidate,
  TopicCandidate,
} from './types';

export interface FinalRerankSelection {
  input: FinalRerankRequestInput;
  keyToId: Map<string, string>;
  removableKeys: Set<string>;
}

export function createFinalRerankSelection(
  query: string,
  localResults: TopicCandidate[],
  entries: RetrievedCandidate[],
  topM: number,
): FinalRerankSelection | null {
  const entryById = new Map(entries.map((entry) => [entry.candidate.id, entry]));
  const selected = localResults.slice(0, Math.max(0, Math.floor(topM)))
    .map((result) => entryById.get(result.id))
    .filter((entry): entry is RetrievedCandidate => Boolean(entry?.temporaryKey));
  if (selected.length <= 1) return null;

  const candidates: FinalRerankCandidate[] = selected.map((entry) => ({
    key: entry.temporaryKey!,
    ...modelMetadata(entry.candidate),
  }));
  return {
    input: { query: normalizeText(query).slice(0, 500), candidates },
    keyToId: new Map(selected.map((entry) => [entry.temporaryKey!, entry.candidate.id])),
    removableKeys: new Set(selected
      .filter((entry) => entry.relevanceGrade === undefined)
      .map((entry) => entry.temporaryKey!)),
  };
}

/** Reapply the metadata whitelist immediately before serialization. */
export function buildFinalRerankPayload(input: FinalRerankRequestInput) {
  return {
    query: normalizeText(input.query).slice(0, 500),
    candidates: input.candidates.map((candidate) => ({
      key: candidate.key.slice(0, 40),
      ...modelMetadataPayload(candidate),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKeys(value: unknown, validKeys: Set<string>, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((key) => typeof key === 'string')) {
    throw new Error(`模型返回的最终列表重排 ${field} 无效`);
  }
  return [...new Set(value.map((key) => key.trim()).filter((key) => validKeys.has(key)))];
}

export function normalizeFinalRerankPlan(raw: unknown, validKeys: Set<string>): FinalRerankPlan {
  if (!isRecord(raw) || (!Object.hasOwn(raw, 'ordered_keys') && !Object.hasOwn(raw, 'remove_keys'))) {
    throw new Error('模型返回的最终列表重排结构无效');
  }
  return {
    orderedKeys: normalizedKeys(raw.ordered_keys, validKeys, 'ordered_keys'),
    removeKeys: normalizedKeys(raw.remove_keys, validKeys, 'remove_keys'),
  };
}

export function applyFinalRerankPlan(
  localResults: TopicCandidate[],
  selection: FinalRerankSelection,
  plan: FinalRerankPlan,
): { results: TopicCandidate[]; removedCount: number } {
  const selectedKeys = selection.input.candidates.map((candidate) => candidate.key);
  const selectedKeySet = new Set(selectedKeys);
  const removable = new Set(plan.removeKeys.filter((key) => selection.removableKeys.has(key)));
  const ordered = [
    ...plan.orderedKeys.filter((key) => selectedKeySet.has(key) && !removable.has(key)),
    ...selectedKeys.filter((key) => !plan.orderedKeys.includes(key) && !removable.has(key)),
  ];
  const resultById = new Map(localResults.map((result) => [result.id, result]));
  const selectedIds = new Set(selectedKeys.map((key) => selection.keyToId.get(key)).filter(Boolean));
  const results = [
    ...ordered.map((key) => resultById.get(selection.keyToId.get(key)!)).filter((result): result is TopicCandidate => Boolean(result)),
    ...localResults.filter((result) => !selectedIds.has(result.id)),
  ];
  return { results, removedCount: localResults.length - results.length };
}
