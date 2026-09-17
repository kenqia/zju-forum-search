export interface PlannedSearch {
  query: string;
  purpose: string;
}

export interface RequiredConcept {
  name: string;
  expressions: string[];
}

export interface TimeConstraint {
  expression: string;
  startDate: string | null;
  endDate: string | null;
}

export interface ModelQueryPlan {
  summary: string;
  searches: PlannedSearch[];
  requiredConcepts: RequiredConcept[];
  excludedTerms: string[];
  timeConstraint: TimeConstraint;
  usedOriginalQueryFallback?: boolean;
}

export interface TopicCandidate {
  id: string;
  title: string;
  board: string;
  time: string;
  author: string;
  replyCount: number;
  url: string;
  retrievalScore: number;
  bestRank: number;
  plans: string[];
  firstRound: number;
  score?: number;
  reason?: string;
  missingRequiredCount?: number;
}

export interface RatePolicy {
  maxSearchCalls: number;
  minRequestIntervalMs: number;
}

export interface SourceCapabilities {
  searchSurface: 'title' | 'fulltext' | 'mixed';
  querySyntax: 'plain-keyword' | 'boolean';
}

export type SourceErrorCode = 'not_logged_in' | 'rate_limited' | 'permission_denied' | 'network' | 'invalid_response';

export class SourceError extends Error {
  constructor(message: string, readonly code: SourceErrorCode) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface Candidate {
  sourceId: string;
  id: string;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  section?: string;
  replyCount?: number;
}

export interface RankingDocument {
  title: string;
  section?: string;
  author?: string;
  publishedAt?: string;
  replyCount?: number;
  snippet?: string;
}

export interface SearchHit {
  candidate: Candidate;
  document: RankingDocument;
  position?: number;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor?: string;
}

export interface RetrievalObservation {
  round: number;
  query: string;
  position?: number;
}

export interface RetrievedCandidate {
  candidate: Candidate;
  observations: RetrievalObservation[];
  documents: RankingDocument[];
}

export interface FeedbackEvidence {
  title: string;
  author?: string;
  publishedAt?: string;
  section?: string;
  replyCount?: number;
}

export interface SearchSourceSession {
  readonly sourceId: string;
  readonly ratePolicy: RatePolicy;
  readonly capabilities: SourceCapabilities;
  search(query: string, cursor: string | undefined, signal?: AbortSignal): Promise<SearchPage>;
}

export interface PageContext {
  url: string;
}

export interface SearchSourceAdapter {
  readonly id: string;
  readonly capabilities: SourceCapabilities;
  readonly ratePolicy: RatePolicy;
  readonly pageMatches: string[];
  readonly apiHosts: string[];
  createSession(pageContext: PageContext): SearchSourceSession | Promise<SearchSourceSession>;
}

export type FeedbackSearch = PlannedSearch;

export interface FeedbackPlan {
  newSearches: FeedbackSearch[];
  learnedTerms: string[];
  stopSuggestions: string[];
  shouldStop: boolean;
  reasoning: string;
}

export interface ExtensionSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  searchBudgetSeconds: number;
}

export type PublicExtensionSettings = ExtensionSettings & { hasApiKey?: boolean };

export interface FeedbackRequestInput {
  query: string;
  executedSearches: { query: string; hitCount: number }[];
  newCandidates: TopicCandidate[];
  round: number;
}

export type ExtensionRequest =
  | { type: 'settings:get' }
  | { type: 'settings:save'; settings: Partial<ExtensionSettings> }
  | { type: 'planner:first'; requestId: string; query: string }
  | { type: 'planner:blind'; requestId: string; query: string }
  | { type: 'planner:feedback'; requestId: string; input: FeedbackRequestInput }
  | { type: 'planner:cancel'; requestId: string };

export type ExtensionFailureCode = 'planner_failed' | 'model_timeout' | 'model_cancelled';
type ExtensionFailure = { ok: false; error: string; code?: ExtensionFailureCode };

export type ExtensionResponseFor<Request extends ExtensionRequest> = ExtensionFailure | (
  Request extends { type: 'settings:get' | 'settings:save' }
    ? { ok: true; settings: PublicExtensionSettings }
    : Request extends { type: 'planner:first' | 'planner:blind' }
      ? { ok: true; plan: ModelQueryPlan }
      : Request extends { type: 'planner:feedback' }
        ? { ok: true; feedback: FeedbackPlan }
        : { ok: true }
);

export const DEFAULT_SETTINGS: ExtensionSettings = {
  llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  llmApiKey: '',
  llmModel: 'qwen3.8-27b',
  searchBudgetSeconds: 60,
};

export const MODEL_TIMEOUT_MS = 20_000;
export const MODEL_MAX_COMPLETION_TOKENS = 1200;
