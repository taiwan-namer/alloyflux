import {
  fetchLiveResearchSearchHit,
  fetchPagesForSources,
  type ResearchBundle,
} from "../web-research";
import { collectEventsFromHit } from "./collector";
import { attachDebugIfEnabled, isResearchDebugEnabled } from "./debug";
import { gateEvidence } from "./gate";
import { planResearch } from "./planner";
import { fingerprintQuery } from "./sanitize";
import type {
  RawSearchHit,
  ResearchDebugSnapshot,
  ResearchPlan,
  ResearchSupplyPath,
  ResearchVerdict,
} from "./types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type PipelineOptions = {
  messages: ChatTurn[];
  now?: Date;
  timeZone?: string;
  prefer?: { sourceId: string; creds: import("../oauth").OAuthCredentials };
  signal?: AbortSignal;
  supplyPath?: ResearchSupplyPath;
  requestId?: string;
  /** 測試用：完全不連網 */
  mockHit?: RawSearchHit | null;
  /** 測試用：強制搜尋錯誤 */
  mockError?: string;
};

export function isResearchPipelineV2Enabled(): boolean {
  const v = process.env.RESEARCH_PIPELINE?.trim().toLowerCase();
  if (v === "v1" || v === "legacy" || v === "0" || v === "off") return false;
  // 預設啟用 V2；設 RESEARCH_PIPELINE=v1 可回退
  return true;
}

function lastUserText(messages: ChatTurn[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
}

function composeLiveQuery(plan: ResearchPlan): string {
  const primary = plan.queries[0] || plan.rawUserQuery;
  const cover =
    plan.coverageHints.length > 0
      ? `\n【盡量涵蓋不同主題，勿只報單一熱點】${plan.coverageHints.join("；")}`
      : "";
  const window = plan.timeWindow
    ? `\n【時間窗】${plan.timeWindow.fromIso}～${plan.timeWindow.toIso}，優先近 ${plan.timeWindow.preferRecentHours} 小時內重要事件`
    : "";
  return `${primary}${window}${cover}\n【多事件並列】若同窗內有多起重大新聞請條列，保留「尚未確認」等限定條件。`;
}

async function liveFetchHit(
  plan: ResearchPlan,
  opts: PipelineOptions,
): Promise<{ hit: RawSearchHit | null; modelCallCount: number; error?: string }> {
  let modelCallCount = 0;
  try {
    const q = composeLiveQuery(plan);
    modelCallCount += 1; // Flash / search（層 1，未經 V1 700 字／3 頁截斷）
    const searchHit = await fetchLiveResearchSearchHit(q, {
      prefer: opts.prefer,
      signal: opts.signal,
    });
    if (!searchHit) return { hit: null, modelCallCount, error: "live_search_hit_null" };

    // 層 2：由 V2 plan.limits.maxPages 控制（預設 4），不再鎖死 V1 的 3 頁
    const pages = await fetchPagesForSources(
      searchHit.sources,
      opts.signal,
      plan.limits.maxPages,
    );

    const hit: RawSearchHit = {
      brief: searchHit.brief, // Flash 原文；Collector 不以 brief 當 article_body
      sources: searchHit.sources.map((s) => ({
        title: s.title,
        uri: s.uri,
        originalUrl: s.uri,
      })),
      queries: searchHit.queries.length ? searchHit.queries : plan.queries,
      pages: pages.map((p) => ({
        title: p.title,
        uri: p.uri,
        excerpt: p.excerpt,
        publishedAt: p.publishedAt,
        originalUrl: p.originalUrl || p.uri,
        resolvedUrl: p.resolvedUrl || p.uri,
        fetchStatus: p.fetchStatus ?? "ok",
      })),
      provider: searchHit.provider,
      limitations: [
        "grounding_partial_serp",
        "published_at_often_missing_from_grounding",
        "brief_is_flash_summary_not_full_serp",
        "flash_brief_is_search_snippet_not_article_body",
      ],
    };
    return { hit, modelCallCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.signal?.aborted) throw e;
    return { hit: null, modelCallCount, error: msg.slice(0, 200) };
  }
}

function buildDebugSnapshot(input: {
  requestId: string;
  supplyPath: ResearchSupplyPath;
  plan: ResearchPlan;
  verdict: ResearchVerdict;
  durationMs: number;
  modelCallCount: number;
}): ResearchDebugSnapshot {
  const { plan, verdict } = input;
  const corpus = verdict.corpus;
  return {
    requestId: input.requestId,
    supplyPath: input.supplyPath,
    plan: {
      intent: plan.intent,
      requireLive: plan.requireLive,
      timeWindow: plan.timeWindow,
      queryCount: plan.queries.length,
      coverageHints: plan.coverageHints,
      queryFingerprint: fingerprintQuery(plan.queries.join("|") || plan.rawUserQuery),
    },
    searchProvider: corpus?.searchProvider,
    rawSourceCount: corpus?.stats.rawSourceCount ?? 0,
    pagesFetched: corpus?.pagesFetched ?? 0,
    eventCount: corpus?.events.length ?? 0,
    claimCount: corpus?.events.reduce((n, e) => n + e.claims.length, 0) ?? 0,
    dedupedSources: corpus?.stats.dedupedSourceCount ?? 0,
    truncatedEvents: corpus?.stats.truncatedEvents ?? 0,
    injectedEventIds: corpus?.events.map((e) => e.eventId) ?? [],
    injectedSourceIds: corpus?.sources.slice(0, 12).map((s) => s.sourceId) ?? [],
    excludedEvents: (corpus?.stats.excluded ?? []).map((e) => ({
      eventId: e.eventId,
      reason: e.reason,
    })),
    gateStatus: verdict.status,
    warnings: verdict.warnings.slice(0, 12),
    limitations: corpus?.limitations.slice(0, 8) ?? [],
    durationMs: input.durationMs,
    modelCallCount: input.modelCallCount,
    flashCalls: input.modelCallCount,
  };
}

/** Mock／Debug：可追溯事件流失統計（不含秘密與使用者原文） */
export function buildResearchFlowTrace(verdict: ResearchVerdict): {
  rawSourceCount: number;
  pagesFetched: number;
  eventCount: number;
  dedupedEventCount: number;
  excludedEvents: { eventId: string; reason: string }[];
  injectedEventIds: string[];
  injectedSourceIds: string[];
  gateStatus: string;
  warnings: string[];
  showVerifiedBadge: boolean;
} {
  const c = verdict.corpus;
  return {
    rawSourceCount: c?.stats.rawSourceCount ?? 0,
    pagesFetched: c?.pagesFetched ?? 0,
    eventCount: c?.events.length ?? 0,
    dedupedEventCount: c?.stats.dedupedEventCount ?? 0,
    excludedEvents: c?.stats.excluded.map((e) => ({ eventId: e.eventId, reason: e.reason })) ?? [],
    injectedEventIds: c?.events.map((e) => e.eventId) ?? [],
    injectedSourceIds: c?.sources.slice(0, 12).map((s) => s.sourceId) ?? [],
    gateStatus: verdict.status,
    warnings: verdict.warnings,
    showVerifiedBadge: verdict.showVerifiedBadge,
  };
}

/**
 * Research Pipeline V2 主入口（規則 Planner → Collector → Gate）
 */
export async function runResearchPipelineV2(opts: PipelineOptions): Promise<ResearchVerdict> {
  const started = Date.now();
  const requestId = opts.requestId || crypto.randomUUID();
  const supplyPath = opts.supplyPath ?? "unknown";
  const text = lastUserText(opts.messages);
  const plan = planResearch({ text, now: opts.now, timeZone: opts.timeZone });

  if (!plan.requireLive || plan.intent === "skip") {
    const verdict = gateEvidence({ plan, corpus: null });
    const snap = buildDebugSnapshot({
      requestId,
      supplyPath,
      plan,
      verdict,
      durationMs: Date.now() - started,
      modelCallCount: 0,
    });
    return attachDebugIfEnabled(verdict, snap);
  }

  let hit: RawSearchHit | null = null;
  let modelCallCount = 0;
  let errorMessage: string | undefined;

  if (opts.mockError) {
    errorMessage = opts.mockError;
  } else if (opts.mockHit !== undefined) {
    hit = opts.mockHit;
  } else {
    const live = await liveFetchHit(plan, opts);
    hit = live.hit;
    modelCallCount = live.modelCallCount;
    errorMessage = live.error;
  }

  const corpus = hit ? collectEventsFromHit(plan, hit, { now: opts.now }) : null;
  const verdict = gateEvidence({ plan, corpus, errorMessage });
  const snap = buildDebugSnapshot({
    requestId,
    supplyPath,
    plan,
    verdict,
    durationMs: Date.now() - started,
    modelCallCount,
  });

  if (isResearchDebugEnabled() && !verdict.debug) {
    return attachDebugIfEnabled(verdict, snap);
  }
  return attachDebugIfEnabled(verdict, snap);
}

/** 轉成舊 ResearchBundle，供 groundingSources 合併；failed 不轉 */
export function verdictToLegacyBundle(verdict: ResearchVerdict): ResearchBundle | null {
  if (!verdict.corpus || (verdict.status !== "ok" && verdict.status !== "partial")) return null;
  const c = verdict.corpus;
  return {
    brief: c.events.map((e) => e.title).join("；").slice(0, 500) || "（結構化事件）",
    sources: c.sources.map((s) => ({ title: s.title, uri: s.uri })),
    queries: c.queriesUsed,
    pages: c.sources
      .filter((s) => s.excerpt)
      .slice(0, c.plan.limits.maxPages)
      .map((s) => ({ title: s.title, uri: s.uri, excerpt: s.excerpt! })),
  };
}
