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

export interface FeedbackSearch {
  query: string;
  purpose: string;
}

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

export const DEFAULT_SETTINGS: ExtensionSettings = {
  llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  llmApiKey: '',
  llmModel: 'qwen3.8-27b',
  searchBudgetSeconds: 60,
};

export const MAX_CC98_REQUESTS = 30;
export const REQUEST_INTERVAL_MS = 2000;
export const PAGE_SIZE = 20;
