/**
 * Research Pipeline V2 — 資料契約（Phase 4）
 * 缺欄位允許 unknown／undefined；不得為符合型別而填造。
 */

export type ResearchClaimType = "reported_fact" | "party_claim" | "unconfirmed" | "denied" | "unknown";

/** 證據載體分類（不代表內容自動為真） */
export type EvidenceProvenance =
  | "article_body"
  | "official_document"
  | "structured_metadata"
  | "search_snippet"
  | "search_synthesis"
  | "title_only"
  | "unknown";

/** 證據強度（非統計機率） */
export type EvidenceLevel = "strong" | "moderate" | "weak" | "insufficient";

export type ResearchGateStatus = "ok" | "partial" | "failed" | "skipped";

/** Gate 證據分級（缺日期 ≠ 不可信） */
export type EvidenceGrade =
  | "body_with_date"
  | "body_missing_date"
  | "title_only"
  | "conflict"
  | "search_failed"
  | "unknown";

export type ResearchIntent = "news" | "factcheck" | "general" | "skip";

export type ResearchSupplyPath = "local" | "node" | "unknown";

export type FetchStatus = "ok" | "failed" | "skipped" | "unresolved" | "blocked_ssrf";

export type CompletionStatus = "complete" | "truncated" | "failed" | "unknown";

export interface ResearchSource {
  sourceId: string;
  title: string;
  /** 顯示／配對用主 URI（優先 resolved，否則 original；禁止含 …） */
  uri: string;
  originalUrl: string;
  resolvedUrl?: string;
  host: string;
  /** 來源發布時間（ISO）；缺則勿填造 */
  publishedAt?: string;
  /** 可讀摘錄（已淨化）；缺則勿填造 */
  excerpt?: string;
  quality: "preferred" | "normal" | "demoted";
  fetchStatus: FetchStatus;
  /** 此來源摘錄的證據載體 */
  provenance: EvidenceProvenance;
  /** 抓到的 HTML 快照相對檔名 */
  htmlPath?: string;
  htmlSha256?: string;
}

export interface ResearchClaim {
  claimId: string;
  statement: string;
  claimType: ResearchClaimType;
  sourceIds: string[];
  /** 歸屬：僅當該來源文本支持時填寫 */
  attribution?: string;
  evidenceLevel: EvidenceLevel;
  provenance: EvidenceProvenance;
}

export interface ResearchEvent {
  eventId: string;
  title: string;
  /** 事件發生時間（可缺）；不得用 publishedAt 冒充 */
  eventAt?: string;
  /** 來源發布時間彙整（可缺） */
  publishedAt?: string;
  topic: string;
  claims: ResearchClaim[];
  sourceIds: string[];
  relevance: number;
  freshness: number;
  diversityKey: string;
  evidenceGrade: EvidenceGrade;
}

export interface ResearchPlan {
  intent: ResearchIntent;
  requireLive: boolean;
  timeWindow: { fromIso: string; toIso: string; preferRecentHours: number } | null;
  userDateHint?: string;
  timeZone: string;
  queries: string[];
  coverageHints: string[];
  limits: {
    maxQueries: number;
    maxPages: number;
    maxEvents: number;
    maxInjectionChars: number;
  };
  skipReason?: string;
  rawUserQuery: string;
}

export interface ResearchCorpus {
  plan: ResearchPlan;
  sources: ResearchSource[];
  events: ResearchEvent[];
  queriesUsed: string[];
  pagesFetched: number;
  limitations: string[];
  searchProvider?: string;
  stats: {
    rawSourceCount: number;
    dedupedSourceCount: number;
    rawEventCount: number;
    dedupedEventCount: number;
    truncatedEvents: number;
    excluded: { eventId: string; title: string; reason: string }[];
    bodyWithDate: number;
    bodyMissingDate: number;
    titleOnly: number;
  };
}

export interface ResearchCost {
  estimatedInjectionTokens: number;
  flashCalls: number;
  pageFetchAttempts: number;
  unavailableActualUsage: boolean;
}

/** 三路徑共同結果形狀（Gemini 允許大量 unknown） */
export interface ResearchResult {
  status: ResearchGateStatus;
  events: ResearchEvent[];
  claims: ResearchClaim[];
  sources: ResearchSource[];
  warnings: string[];
  researchCost?: ResearchCost;
  completionStatus?: CompletionStatus;
  injectionText: string;
  webSearchQueries: string[];
  showVerifiedBadge: boolean;
}

export interface ResearchVerdict {
  status: ResearchGateStatus;
  plan: ResearchPlan;
  corpus: ResearchCorpus | null;
  injectionText: string;
  sources: { title: string; uri: string; originalUrl?: string; resolvedUrl?: string }[];
  webSearchQueries: string[];
  warnings: string[];
  showVerifiedBadge: boolean;
  forbidStaleNewsVoice: boolean;
  evidenceGrades?: EvidenceGrade[];
  researchCost?: ResearchCost;
  completionStatus?: CompletionStatus;
  debug?: ResearchDebugSnapshot;
}

export interface ResearchDebugSnapshot {
  requestId: string;
  supplyPath: ResearchSupplyPath;
  plan: {
    intent: ResearchIntent;
    requireLive: boolean;
    timeWindow: ResearchPlan["timeWindow"];
    queryCount: number;
    coverageHints: string[];
    queryFingerprint: string;
  };
  searchProvider?: string;
  rawSourceCount: number;
  pagesFetched: number;
  eventCount: number;
  claimCount: number;
  dedupedSources: number;
  truncatedEvents: number;
  injectedEventIds: string[];
  injectedSourceIds: string[];
  excludedEvents: { eventId: string; reason: string }[];
  gateStatus: ResearchGateStatus;
  warnings: string[];
  limitations: string[];
  durationMs: number;
  modelCallCount: number;
  flashCalls: number;
}

export interface RawSearchHit {
  brief: string;
  sources: {
    title: string;
    uri: string;
    publishedAt?: string;
    originalUrl?: string;
    resolvedUrl?: string;
  }[];
  queries: string[];
  pages: {
    title: string;
    uri: string;
    excerpt: string;
    publishedAt?: string;
    originalUrl?: string;
    resolvedUrl?: string;
    fetchStatus?: FetchStatus;
    htmlPath?: string;
    htmlSha256?: string;
  }[];
  provider: string;
  limitations?: string[];
  /**
   * Flash Grounding 原始 groundingSupports。
   * search_synthesis 由此產生，不得升格 article_body。
   */
  rawGroundingSupports?: unknown[];
}

/** 驗收鎖定的三模型產品路由 */
export const PHASE4_PRODUCT_MODELS = {
  astra: "gpt-6-astra",
  claude: "agy-claude-opus-5-5-medium",
  argon: "gemini-4-argon-medium",
} as const;
