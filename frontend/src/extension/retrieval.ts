import { modelMetadata } from './model-metadata';
import { folded } from './text';
import type { Candidate, RetrievedCandidate, SearchHit } from './types';

export function firstObservedRound(entry: RetrievedCandidate): number {
  return entry.observations.reduce((first, observation) => Math.min(first, observation.round), Infinity);
}

/** Each SearchSession owns one source, so ids are scoped to that source. */
export function mergeHits(
  candidates: Map<string, RetrievedCandidate>, hits: SearchHit[], query: string, round: number,
  nextTemporaryKey: () => string = () => `c${candidates.size}`,
): void {
  for (const hit of hits) {
    if (!hit.candidate.id.trim()) continue;
    let entry = candidates.get(hit.candidate.id);
    if (!entry) {
      entry = {
        candidate: { ...hit.candidate }, observations: [], documents: [],
        temporaryKey: nextTemporaryKey(), evidenceRevision: 1, judgedEvidenceRevision: 0,
        latestIndependentQuery: query,
      };
      candidates.set(hit.candidate.id, entry);
    } else {
      const before = JSON.stringify(modelMetadata(entry.candidate));
      const stable = entry.candidate;
      entry.candidate = mergeVisibleMetadata(stable, hit.candidate);
      const metadataChanged = JSON.stringify(modelMetadata(entry.candidate)) !== before;
      const differentQuery = !entry.observations.some((observation) => folded(observation.query) === folded(query));
      if (metadataChanged || differentQuery) {
        entry.evidenceRevision = (entry.evidenceRevision ?? 0) + 1;
        entry.latestIndependentQuery = query;
      }
    }
    entry.observations.push({ round, query, position: hit.position });
    entry.documents.push({ ...hit.document });
  }
}

function mergeVisibleMetadata(current: Candidate, incoming: Candidate): Candidate {
  return {
    ...current,
    ...(incoming.title.trim() && { title: incoming.title }),
    ...(incoming.author?.trim() && { author: incoming.author }),
    ...(incoming.publishedAt?.trim() && { publishedAt: incoming.publishedAt }),
    ...(incoming.section?.trim() && { section: incoming.section }),
    ...(incoming.replyCount !== undefined && Number.isFinite(incoming.replyCount) && { replyCount: incoming.replyCount }),
    sourceId: current.sourceId,
    id: current.id,
    url: current.url,
    titleOrigin: current.titleOrigin,
  };
}
