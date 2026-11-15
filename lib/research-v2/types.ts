/**
 * Research Pipeline V2 — 資料契約
 * 事件／主張為一級物件；700 字 brief 不再是真相來源。
 */

export type ResearchClaimType = "reported_fact" | "party_claim" | "unconfirmed" | "denied";

/** 證據強度（非統計機率） */
export type EvidenceLevel = "strong" | "moderate" | "weak" | "insufficient";

export type ResearchGateStatus = "ok" | "partial" | "failed" | "skipped";

export type ResearchIntent = "news" | "factcheck" | "general" | "skip";

export type ResearchSupplyPath = "local" | "node" | "unknown";

export interface ResearchSource {
  sourceId: string;
  title: string;
  uri: string;
  host: string;
  /** 來源發布時間（ISO）；缺則勿填造 */
  publishedAt?: string;
  /** 可讀摘錄（已淨化）；缺則勿填造 */
  excerpt?: string;
  quality: "preferred" | "normal" | "demoted";
}

export interface ResearchClaim {
  claimId: string;
  statement: string;
  claimType: ResearchClaimType;
  sourceIds: string[];
  /** 歸屬：美方宣布／克里姆林宮確認／中方尚未確認… */
  attribution?: string;
  evidenceLevel: EvidenceLevel;
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
}

export interface ResearchPlan {
  intent: ResearchIntent;
  requireLive: boolean;
  /** 相對請求當下的查詢窗 */
  timeWindow: { fromIso: string; toIso: string; preferRecentHours: number } | null;
  /** 使用者指定日期（若有） */
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
  /** Grounding／SERP 已知限制 */
  limitations: string[];
  searchProvider?: string;
  /** Collector 統計 */
  stats: {
    rawSourceCount: number;
    dedupedSourceCount: number;
    rawEventCount: number;
    dedupedEventCount: number;
    truncatedEvents: number;
    /** 被多樣性／上限排除的事件 */
    excluded: { eventId: string; title: string; reason: string }[];
  };
}

export interface ResearchVerdict {
  status: ResearchGateStatus;
  plan: ResearchPlan;
  corpus: ResearchCorpus | null;
  injectionText: string;
  sources: { title: string; uri: string }[];
  webSearchQueries: string[];
  warnings: string[];
  /** 供 UI：僅 ok／partial 可標「已上網查證」 */
  showVerifiedBadge: boolean;
  /** 禁止主模型用舊知識冒充今日新聞 */
  forbidStaleNewsVoice: boolean;
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
    /** 遮蔽後的查詢指紋，非原文 */
    queryFingerprint: string;
  };
  searchProvider?: string;
  rawSourceCount: number;
  pagesFetched: number;
  eventCount: number;
  claimCount: number;
  dedupedSources: number;
  truncatedEvents: number;
  /** 注入主模型的事件 id（預算後） */
  injectedEventIds: string[];
  /** 注入／UI 可見的來源 id */
  injectedSourceIds: string[];
  excludedEvents: { eventId: string; reason: string }[];
  gateStatus: ResearchGateStatus;
  warnings: string[];
  limitations: string[];
  durationMs: number;
  modelCallCount: number;
}

/** Collector 可接受的原始搜尋命中（live 或 mock） */
export interface RawSearchHit {
  brief: string;
  sources: { title: string; uri: string; publishedAt?: string }[];
  queries: string[];
  pages: { title: string; uri: string; excerpt: string; publishedAt?: string }[];
  provider: string;
  limitations?: string[];
}
