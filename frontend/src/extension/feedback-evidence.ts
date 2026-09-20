import { modelMetadata } from './model-metadata';
import { folded } from './text';
import type { FeedbackCandidate, FeedbackJudgment, RetrievedCandidate } from './types';

export const MAX_FEEDBACK_CANDIDATES_PER_QUERY = 4;

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

/** Select eligible evidence by priority, then round-robin across newest-evidence queries. */
export function selectFeedbackEvidence(
  entries: RetrievedCandidate[], rankedIds: string[], limit: number,
): { entries: RetrievedCandidate[]; candidates: FeedbackCandidate[] } {
  const rank = new Map(rankedIds.map((id, index) => [id, index]));
  const eligible = entries.filter((entry) => (entry.evidenceRevision ?? 0) > (entry.judgedEvidenceRevision ?? 0)
    && rank.has(entry.candidate.id));
  eligible.sort((a, b) => priority(a) - priority(b)
    || (rank.get(a.candidate.id) ?? Infinity) - (rank.get(b.candidate.id) ?? Infinity)
    || (a.temporaryKey ?? '').localeCompare(b.temporaryKey ?? ''));

  const selected: RetrievedCandidate[] = [];
  const contributions = new Map<string, number>();
  for (const currentPriority of [0, 1, 2]) {
    const groups = new Map<string, RetrievedCandidate[]>();
    for (const entry of eligible.filter((candidate) => priority(candidate) === currentPriority)) {
      const group = folded(entry.latestIndependentQuery ?? '') || '_';
      const values = groups.get(group) ?? [];
      values.push(entry);
      groups.set(group, values);
    }
    const queues = [...groups.entries()];
    while (selected.length < limit && queues.some(([group, queue]) => queue.length && (contributions.get(group) ?? 0) < MAX_FEEDBACK_CANDIDATES_PER_QUERY)) {
      for (const [group, queue] of queues) {
        if ((contributions.get(group) ?? 0) >= MAX_FEEDBACK_CANDIDATES_PER_QUERY) continue;
        const entry = queue.shift();
        if (!entry) continue;
        selected.push(entry);
        contributions.set(group, (contributions.get(group) ?? 0) + 1);
        if (selected.length >= limit) break;
      }
    }
    if (selected.length >= limit) break;
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
