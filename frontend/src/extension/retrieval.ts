import type { RetrievedCandidate, SearchHit } from './types';

export function firstObservedRound(entry: RetrievedCandidate): number {
  return entry.observations.reduce((first, observation) => Math.min(first, observation.round), Infinity);
}

/** Each SearchSession owns one source, so ids are scoped to that source. */
export function mergeHits(
  candidates: Map<string, RetrievedCandidate>, hits: SearchHit[], query: string, round: number,
): void {
  for (const hit of hits) {
    if (!hit.candidate.id.trim()) continue;
    let entry = candidates.get(hit.candidate.id);
    if (!entry) {
      entry = { candidate: { ...hit.candidate }, observations: [], documents: [] };
      candidates.set(hit.candidate.id, entry);
    }
    entry.observations.push({ round, query, position: hit.position });
    entry.documents.push({ ...hit.document });
  }
}
