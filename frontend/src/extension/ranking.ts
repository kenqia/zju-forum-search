import type { ModelQueryPlan, TopicCandidate } from './types';
import { folded, normalizeText } from './planner';

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

function timeStatus(candidate: TopicCandidate, plan: ModelQueryPlan): TimeStatus {
  const start = dateValue(plan.timeConstraint.startDate);
  const end = dateValue(plan.timeConstraint.endDate);
  if (start === null && end === null) return 'in_range';
  const published = dateValue(candidate.time);
  if (published === null) return 'unknown';
  const inRange = (start === null || published >= start) && (end === null || published <= end);
  return inRange ? 'in_range' : 'out_of_range';
}

const TIME_ORDER: Record<TimeStatus, number> = { in_range: 0, unknown: 1, out_of_range: 2 };

export function rankCandidates(candidates: TopicCandidate[], plan: ModelQueryPlan): TopicCandidate[] {
  const ranked = candidates.map((candidate) => {
    const haystack = folded(`${candidate.title} ${candidate.board}`);
    const reasons: string[] = [];

    const matchedConcepts = plan.requiredConcepts.filter((concept) =>
      concept.expressions.some((expression) => includesExpression(haystack, expression)),
    );
    const missingConcepts = plan.requiredConcepts.filter((concept) => !matchedConcepts.includes(concept));
    if (matchedConcepts.length) {
      reasons.push(`命中必须概念：${matchedConcepts.map((c) => c.name).join('、')}`);
    }
    if (missingConcepts.length) {
      reasons.push(`缺少必须概念：${missingConcepts.map((c) => c.name).join('、')}`);
    }

    const matchedSearches = plan.searches.filter((search) => includesExpression(haystack, search.query));
    if (matchedSearches.length) {
      reasons.push(`标题命中 ${matchedSearches.length} 个检索词`);
    }

    const exclusions = plan.excludedTerms.filter((term) => includesExpression(haystack, term));
    if (exclusions.length) {
      reasons.push(`命中排除词：${exclusions.join('、')}`);
    }

    const status = timeStatus(candidate, plan);
    if (status === 'in_range' && (plan.timeConstraint.startDate || plan.timeConstraint.endDate)) {
      reasons.push('发布时间符合时间约束');
    } else if (status === 'out_of_range') {
      reasons.push('发布时间不符合时间约束');
    } else if (status === 'unknown' && (plan.timeConstraint.startDate || plan.timeConstraint.endDate)) {
      reasons.push('发布时间未知');
    }

    if (!reasons.length) reasons.push('仅由 CC98 候选排名和跨查询命中支持');
    return {
      ...candidate,
      missingRequiredCount: missingConcepts.length,
      score: candidate.retrievalScore,
      reason: reasons.join('；'),
      _timeOrder: TIME_ORDER[status],
      _excludedCount: exclusions.length,
    } as TopicCandidate & { _timeOrder: number; _excludedCount: number };
  });

  ranked.sort((a, b) => {
    const ao = (a as TopicCandidate & { _timeOrder: number })._timeOrder;
    const bo = (b as TopicCandidate & { _timeOrder: number })._timeOrder;
    if (ao !== bo) return ao - bo;
    const ae = (a as TopicCandidate & { _excludedCount: number })._excludedCount;
    const be = (b as TopicCandidate & { _excludedCount: number })._excludedCount;
    if (ae !== be) return ae - be;
    if ((a.missingRequiredCount ?? 0) !== (b.missingRequiredCount ?? 0)) {
      return (a.missingRequiredCount ?? 0) - (b.missingRequiredCount ?? 0);
    }
    if (a.plans.length !== b.plans.length) return b.plans.length - a.plans.length;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    if (a.firstRound !== b.firstRound) return a.firstRound - b.firstRound;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
  return ranked.map((r) => {
    const { _timeOrder, _excludedCount, ...rest } = r as TopicCandidate & { _timeOrder: number; _excludedCount: number };
    return rest;
  });
}
