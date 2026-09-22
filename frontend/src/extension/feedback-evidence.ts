import { modelMetadata } from './model-metadata';
import { folded } from './text';
import type { FeedbackCandidate, FeedbackJudgment, RetrievedCandidate } from './types';

export const FAIR_SHARE_TARGET_PER_QUERY = 2;

function recentDistinctQueries(entry: RetrievedCandidate): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = entry.observations.length - 1; index >= 0 && result.length < 3; index -= 1) {
    const query = entry.observations[index].query;
    const key = folded(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.unshift(query);
  }
  return result;
}

function priority(entry: RetrievedCandidate): number {
  if (entry.relevanceGrade === undefined) return 0;
  return entry.relevanceGrade === 0 ? 1 : 2;
}

function selectWithinPriority(
  entries: RetrievedCandidate[], limit: number,
): RetrievedCandidate[] {
  if (limit <= 0) return [];
  const groups = new Map<string, RetrievedCandidate[]>();
  for (const entry of entries) {
    const group = folded(entry.latestIndependentQuery ?? '') || '_';
    const values = groups.get(group) ?? [];
    values.push(entry);
    groups.set(group, values);
  }

  const queues = [...groups.entries()];
  const selected: RetrievedCandidate[] = [];
  for (let share = 0; share < FAIR_SHARE_TARGET_PER_QUERY && selected.length < limit; share += 1) {
    for (const [, queue] of queues) {
      const entry = queue.shift();
      if (!entry) continue;
      selected.push(entry);
      if (selected.length >= limit) break;
    }
  }

  if (selected.length >= limit) return selected;
  const selectedIds = new Set(selected.map((entry) => entry.candidate.id));
  selected.push(...entries
    .filter((entry) => !selectedIds.has(entry.candidate.id))
    .slice(0, limit - selected.length));
  return selected;
}

/** Select eligible evidence by priority, fair share, then local pre-rank refill. */
export function selectFeedbackEvidence(
  entries: RetrievedCandidate[], rankedIds: string[], limit: number,
): { entries: RetrievedCandidate[]; candidates: FeedbackCandidate[] } {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const rank = new Map(rankedIds.map((id, index) => [id, index]));
  const eligible = entries.filter((entry) => (entry.evidenceRevision ?? 0) > (entry.judgedEvidenceRevision ?? 0)
    && rank.has(entry.candidate.id));
  eligible.sort((a, b) => priority(a) - priority(b)
    || (rank.get(a.candidate.id) ?? Infinity) - (rank.get(b.candidate.id) ?? Infinity)
    || (a.temporaryKey ?? '').localeCompare(b.temporaryKey ?? ''));

  const byPriority = [0, 1, 2].map((currentPriority) => eligible
    .filter((entry) => priority(entry) === currentPriority));
  const rescueReserve = normalizedLimit > 0 && byPriority[1].length > 0 ? 1 : 0;
  const selected = selectWithinPriority(byPriority[0], normalizedLimit - rescueReserve);
  let remaining = normalizedLimit - selected.length;
  for (const currentPriority of [1, 2]) {
    if (remaining <= 0) break;
    const next = selectWithinPriority(byPriority[currentPriority], remaining);
    selected.push(...next);
    remaining -= next.length;
  }
  return {
    entries: selected,
    candidates: selected.map((entry) => ({
      key: entry.temporaryKey!,
      ...modelMetadata(entry.candidate),
      matchedQueries: recentDistinctQueries(entry),
    })),
  };
}

export function applyFeedbackJudgments(entries: RetrievedCandidate[], judgments: FeedbackJudgment[]): void {
  const byKey = new Map(entries.map((entry) => [entry.temporaryKey, entry]));
  for (const judgment of judgments) {
    const entry = byKey.get(judgment.key);
    if (!entry) continue;
    entry.relevanceGrade = judgment.grade;
    entry.judgedEvidenceRevision = entry.evidenceRevision ?? 0;
  }
}
