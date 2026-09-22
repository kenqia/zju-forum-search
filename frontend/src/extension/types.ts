export type QueryRole = 'precise' | 'balanced' | 'anchor';

export interface PlannedSearch {
  query: string;
  purpose: string;
  role?: QueryRole;
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

/** Display-only search result; ranking keys stay private to ranking.ts. */
export interface TopicCandidate {
  id: string;
  title: string;
  board: string;
  time: string;
  author: string;
  replyCount: number;
  url: string;
  firstRound: number;
}

export interface RatePolicy {
  /** Hard per-run cap on site search() calls set by the source; user limit applies on top. */
  maxSearchCalls: number;
  minRequestIntervalMs: number;
}

export interface SourceCapabilities {
  searchSurface: 'title' | 'fulltext' | 'mixed';
  querySyntax: 'plain-keyword' | 'boolean';
  /** 'time-desc' means pages arrive newest-first; anything else must not early-stop on time. */
  resultOrdering: 'time-desc' | 'other';
}

export type SourceErrorCode = 'not_logged_in' | 'rate_limited' | 'permission_denied' | 'network' | 'invalid_response';

export class SourceError extends Error {
  constructor(message: string, readonly code: SourceErrorCode) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface Candidate {
  /** Only native titles may enter model feedback; body-derived titles stay local. */
  titleOrigin: 'native' | 'body-derived';
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
  /** Opaque, run-local model key; never derived from a platform identifier. */
  temporaryKey?: string;
  relevanceGrade?: RelevanceGrade;
  evidenceRevision?: number;
  judgedEvidenceRevision?: number;
  latestIndependentQuery?: string;
}

export interface FeedbackEvidence {
  title: string;
  publishedAt?: string;
  section?: string;
  replyCount?: number;
}

export type RelevanceGrade = 0 | 1 | 2 | 3;

export interface FeedbackCandidate extends FeedbackEvidence {
  key: string;
  matchedQueries: string[];
}

export interface FeedbackJudgment {
  key: string;
  grade: RelevanceGrade;
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

export type FeedbackSearchBasis = 'query' | 'evidence';

export interface FeedbackSearch {
  query: string;
  purpose: string;
  basis?: FeedbackSearchBasis;
  supportKeys?: string[];
  clueOnly?: boolean;
}

export interface StopQuerySuggestion {
  query: string;
  reason: string;
}

export interface FeedbackPlan {
  judgments: FeedbackJudgment[];
  newSearches: FeedbackSearch[];
  /** New protocol: stop continuation for one already-executed branch. */
  stopQueries?: StopQuerySuggestion[];
  /** Legacy wire compatibility; new model prompts must use stop_queries. */
  stopSuggestions: string[];
  shouldStop: boolean;
  reasoning: string;
}

export interface ExtensionSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Site search calls allowed per run, including pagination. */
  searchRequestLimit: number;
  /** Maximum candidates selected for one feedback call. */
  feedbackEvidenceLimit: number;
  /** Whether feedback may close future expansion or live query continuations. */
  modelSearchNarrowingEnabled: boolean;
  /** Default-on final listwise reranking after a search finishes. */
  finalRerankEnabled: boolean;
  /** Number of locally presorted active candidates sent to the final rerank. */
  finalRerankTopM: number;
  /** Legacy field kept for stored-settings compatibility; no longer limits a run. */
  searchBudgetSeconds: number;
}

export type PublicExtensionSettings = ExtensionSettings & { hasApiKey?: boolean };
export type StoredExtensionSettings = Partial<ExtensionSettings> & { intentFilterEnabled?: unknown };

export interface FeedbackRequestInput {
  query: string;
  remainingRequests?: number;
  executedSearches: { query: string; hitCount: number }[];
  searchLedger?: SearchLedgerEntry[];
  candidates: FeedbackCandidate[];
}

export interface SearchLedgerEntry {
  query: string;
  pages: number;
  hits: number;
  uniqueCandidates: number;
  newOnLastPage: number;
  grade23: number;
  grade0: number;
  canContinue: boolean;
}

export interface FinalRerankCandidate extends FeedbackEvidence {
  key: string;
  matchedQueries: string[];
  independentQueryCount: number;
  bestSourcePosition: number | null;
}

export interface FinalRerankRequestInput {
  query: string;
  candidates: FinalRerankCandidate[];
}

export interface FinalRerankPlan {
  orderedKeys: string[];
  removeKeys: string[];
}

export type ExtensionRequest =
  | { type: 'settings:get' }
  | { type: 'settings:save'; settings: Partial<ExtensionSettings> }
  | { type: 'planner:first'; requestId: string; query: string; capabilities: SourceCapabilities }
  | { type: 'planner:feedback'; requestId: string; input: FeedbackRequestInput; capabilities: SourceCapabilities; modelSearchNarrowingEnabled?: boolean }
  | { type: 'planner:rerank'; requestId: string; input: FinalRerankRequestInput; capabilities: SourceCapabilities }
  | { type: 'planner:cancel'; requestId: string };

export type ExtensionFailureCode = 'planner_failed' | 'model_timeout' | 'model_cancelled';
type ExtensionFailure = { ok: false; error: string; code?: ExtensionFailureCode };

export type ExtensionResponseFor<Request extends ExtensionRequest> = ExtensionFailure | (
  Request extends { type: 'settings:get' | 'settings:save' }
    ? { ok: true; settings: PublicExtensionSettings }
    : Request extends { type: 'planner:first' }
      ? { ok: true; plan: ModelQueryPlan }
      : Request extends { type: 'planner:feedback' }
        ? { ok: true; feedback: FeedbackPlan }
        : Request extends { type: 'planner:rerank' }
          ? { ok: true; rerank: FinalRerankPlan }
        : { ok: true }
);

export const DEFAULT_SETTINGS: ExtensionSettings = {
  llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  llmApiKey: '',
  llmModel: 'qwen3.8-27b',
  searchRequestLimit: 30,
  feedbackEvidenceLimit: 30,
  modelSearchNarrowingEnabled: true,
  finalRerankEnabled: true,
  finalRerankTopM: 30,
  searchBudgetSeconds: 60,
};

export const MODEL_TIMEOUT_MS = 20_000;
export const MODEL_MAX_COMPLETION_TOKENS = 1200;
