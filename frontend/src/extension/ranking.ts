import type { ModelQueryPlan, RetrievedCandidate, TopicCandidate } from './types';
import { folded, normalizeText } from './planner';
import { firstObservedRound } from './retrieval';

function includesExpression(haystack: string, expression: string): boolean {
  const normalized = folded(expression);
  if (!normalized) return false;
  return haystack.includes(normalized) || haystack.replace(/\s+/gu, '').includes(normalized.replace(/\s+/gu, ''));
}

function dateValue(value: unknown): number | null {
  const match = normalizeText(value).match(/\d{4}(?:[-/.]\d{1,2})?(?:[-/.]\d{1,2})?/u);
  if (!match) return null;
  const normalized = match[0].replace(/[/.]/gu, '-');
  const parsed = Date.parse(normalized.length === 4 ? `${normalized}-01-01` : normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

type TimeStatus = 'in_range' | 'unknown' | 'out_of_range';

function timeStatus(entry: RetrievedCandidate, plan: ModelQueryPlan): TimeStatus {
  const start = dateValue(plan.timeConstraint.startDate);
  const end = dateValue(plan.timeConstraint.endDate);
  if (start === null && end === null) return 'in_range';
  // The first known document date wins; later snippets cannot rewrite it.
  const published = entry.documents.map((document) => dateValue(document.publishedAt)).find((date) => date !== null);
  if (published === undefined) return 'unknown';
  return (start === null || published >= start) && (end === null || published <= end) ? 'in_range' : 'out_of_range';
}

const TIME_ORDER: Record<TimeStatus, number> = { in_range: 0, unknown: 1, out_of_range: 2 };

interface ScoredCandidate {
  entry: RetrievedCandidate;
  timeOrder: number;
  excludedCount: number;
  missingConceptCount: number;
  queryCount: number;
  bestPosition: number;
  earliestRound: number;
}

function score(entry: RetrievedCandidate, plan: ModelQueryPlan): ScoredCandidate {
  // Match within each document, then union the matched concepts. Joining snippets
  // could fabricate a phrase across unrelated hits.
  const texts = entry.documents.map((document) => folded(`${document.title} ${document.section ?? ''} ${document.snippet ?? ''}`));
  const matches = (expression: string) => texts.some((text) => includesExpression(text, expression));
  const positions = entry.observations.map((observation) => observation.position)
    .filter((position): position is number => position !== undefined && Number.isFinite(position) && position >= 1);
  return {
    entry,
    timeOrder: TIME_ORDER[timeStatus(entry, plan)],
    excludedCount: plan.excludedTerms.filter(matches).length,
    missingConceptCount: plan.requiredConcepts.filter((concept) => !concept.expressions.some(matches)).length,
    queryCount: new Set(entry.observations.map((observation) => folded(observation.query))).size,
    bestPosition: positions.reduce((best, position) => Math.min(best, position), Infinity),
    earliestRound: firstObservedRound(entry),
  };
}

function displayResult({ entry, earliestRound }: ScoredCandidate): TopicCandidate {
  const candidate = entry.candidate;
  return {
    id: candidate.id, title: candidate.title, url: candidate.url,
    board: candidate.section ?? '', time: candidate.publishedAt ?? '',
    author: candidate.author ?? '', replyCount: candidate.replyCount ?? 0,
    firstRound: earliestRound,
  };
}

export function rankCandidates(candidates: RetrievedCandidate[], plan: ModelQueryPlan): TopicCandidate[] {
  const ranked = candidates.map((entry) => score(entry, plan));
  ranked.sort((a, b) => {
    if (a.timeOrder !== b.timeOrder) return a.timeOrder - b.timeOrder;
    if (a.excludedCount !== b.excludedCount) return a.excludedCount - b.excludedCount;
    if (a.missingConceptCount !== b.missingConceptCount) return a.missingConceptCount - b.missingConceptCount;
    if (a.queryCount !== b.queryCount) return b.queryCount - a.queryCount;
    if (a.bestPosition !== b.bestPosition) return a.bestPosition - b.bestPosition;
    if (a.earliestRound !== b.earliestRound) return a.earliestRound - b.earliestRound;
    return a.entry.candidate.title.localeCompare(b.entry.candidate.title, 'zh-CN');
  });
  return ranked.map(displayResult);
}

export interface RankedCandidateView {
  results: TopicCandidate[];
  outOfRangeCount: number;
}

export function rankAndFilterCandidates(
  candidates: RetrievedCandidate[], plan: ModelQueryPlan, enforceTimeRange: boolean,
): RankedCandidateView {
  const visible = enforceTimeRange
    ? candidates.filter((entry) => timeStatus(entry, plan) !== 'out_of_range')
    : candidates;
  return { results: rankCandidates(visible, plan), outOfRangeCount: candidates.length - visible.length };
}
