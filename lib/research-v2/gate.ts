import { formatVerdictInjection } from "./inject";
import { estimateTokensApprox } from "./token-budget";
import type {
  CompletionStatus,
  EvidenceGrade,
  ResearchCorpus,
  ResearchGateStatus,
  ResearchPlan,
  ResearchVerdict,
} from "./types";

function preferredOrNormalCount(corpus: ResearchCorpus): number {
  return corpus.sources.filter((s) => s.quality === "preferred" || s.quality === "normal").length;
}

function hasUnconfirmedWithoutAttribution(corpus: ResearchCorpus): boolean {
  return corpus.events.some((e) =>
    e.claims.some((c) => c.claimType === "unconfirmed" && !c.attribution),
  );
}

/** 有來源 ID ≠ 證據充分：需至少一篇 article_body／official_document，或明確標 title_only */
function hasBodyBackedClaim(corpus: ResearchCorpus): boolean {
  return corpus.events.some((e) =>
    e.claims.some(
      (c) =>
        (c.provenance === "article_body" || c.provenance === "official_document") &&
        c.sourceIds.length > 0,
    ),
  );
}

function onlyTitleOrSnippetClaims(corpus: ResearchCorpus): boolean {
  return corpus.events.every((e) =>
    e.claims.every(
      (c) =>
        c.provenance === "title_only" ||
        c.provenance === "search_snippet" ||
        c.provenance === "search_synthesis" ||
        c.provenance === "unknown",
    ),
  );
}

function collectGrades(corpus: ResearchCorpus): EvidenceGrade[] {
  return corpus.events.map((e) => e.evidenceGrade);
}

function completionFromStatus(status: ResearchGateStatus): CompletionStatus {
  if (status === "ok") return "complete";
  if (status === "partial") return "truncated";
  if (status === "failed") return "failed";
  return "unknown";
}

function attachCost(verdict: ResearchVerdict, corpus: ResearchCorpus | null): void {
  verdict.researchCost = {
    estimatedInjectionTokens: estimateTokensApprox(verdict.injectionText),
    flashCalls: corpus ? 1 : 0,
    pageFetchAttempts: corpus?.pagesFetched ?? 0,
    unavailableActualUsage: true,
  };
  verdict.completionStatus = completionFromStatus(verdict.status);
}

/**
 * Evidence Gate：決定 ok／partial／failed／skipped 與注入契約。
 * 缺日期 → partial／body_missing_date，非整段拒絕。
 * 不得僅憑 sourceIds.length > 0 認定證據充分。
 */
export function gateEvidence(input: {
  plan: ResearchPlan;
  corpus: ResearchCorpus | null;
  errorMessage?: string;
}): ResearchVerdict {
  const { plan, corpus, errorMessage } = input;

  if (plan.intent === "skip" || !plan.requireLive) {
    const verdict: ResearchVerdict = {
      status: "skipped",
      plan,
      corpus: null,
      injectionText: "",
      sources: [],
      webSearchQueries: [],
      warnings: plan.skipReason ? [plan.skipReason] : [],
      showVerifiedBadge: false,
      forbidStaleNewsVoice: false,
      completionStatus: "unknown",
      researchCost: {
        estimatedInjectionTokens: 0,
        flashCalls: 0,
        pageFetchAttempts: 0,
        unavailableActualUsage: true,
      },
    };
    return verdict;
  }

  if (!corpus || errorMessage) {
    const warnings = [errorMessage || "search_failed_or_empty", "forbid_stale_news_voice"];
    const status: ResearchGateStatus = "failed";
    const verdict: ResearchVerdict = {
      status,
      plan,
      corpus: null,
      injectionText: "",
      sources: [],
      webSearchQueries: plan.queries,
      warnings,
      showVerifiedBadge: false,
      forbidStaleNewsVoice: true,
      evidenceGrades: ["search_failed"],
    };
    verdict.injectionText = formatVerdictInjection(verdict);
    attachCost(verdict, null);
    return verdict;
  }

  const usable = preferredOrNormalCount(corpus);
  const eventCount = corpus.events.length;
  const warnings: string[] = [...corpus.limitations];
  const grades = collectGrades(corpus);

  if (usable === 0 || eventCount === 0) {
    const verdict: ResearchVerdict = {
      status: "failed",
      plan,
      corpus,
      injectionText: "",
      sources: corpus.sources.map((s) => ({
        title: s.title,
        uri: s.uri,
        originalUrl: s.originalUrl,
        resolvedUrl: s.resolvedUrl,
      })),
      webSearchQueries: corpus.queriesUsed,
      warnings: [...warnings, "no_usable_sources", "forbid_stale_news_voice"],
      showVerifiedBadge: false,
      forbidStaleNewsVoice: true,
      evidenceGrades: grades.length ? grades : ["search_failed"],
    };
    verdict.injectionText = formatVerdictInjection(verdict);
    attachCost(verdict, corpus);
    return verdict;
  }

  let status: ResearchGateStatus = "ok";

  // 僅標題／摘要：不可當完整核對
  if (onlyTitleOrSnippetClaims(corpus) || !hasBodyBackedClaim(corpus)) {
    status = "partial";
    warnings.push("evidence_title_or_snippet_only");
  }

  if (usable < 2) {
    status = "partial";
    warnings.push("fewer_than_2_usable_sources");
  }
  if (eventCount < 2 && plan.coverageHints.length > 1) {
    status = "partial";
    warnings.push("low_event_coverage");
  }
  // 缺日期 → partial，非整段 failed
  if (!corpus.sources.some((s) => s.publishedAt)) {
    status = status === "ok" ? "partial" : status;
    warnings.push("missing_published_at_on_all_sources");
  } else if (corpus.stats.bodyMissingDate > 0) {
    status = status === "ok" ? "partial" : status;
    warnings.push("some_events_body_missing_date");
  }
  if (hasUnconfirmedWithoutAttribution(corpus)) {
    warnings.push("unconfirmed_claims_present");
  }
  if (corpus.stats.truncatedEvents > 0) {
    warnings.push(`truncated_events:${corpus.stats.truncatedEvents}`);
  }
  if (grades.includes("conflict")) {
    status = "partial";
    warnings.push("conflicting_claims");
  }

  // 禁止：sourceIds.length > 0 就標 confirmed——Gate 從不輸出 confirmed 旗標
  const overclaimed = corpus.events.some((e) =>
    e.claims.some(
      (c) =>
        c.claimType === "reported_fact" &&
        (c.provenance === "title_only" || c.provenance === "search_snippet") &&
        c.sourceIds.length > 0,
    ),
  );
  if (overclaimed) {
    status = "partial";
    warnings.push("reported_fact_without_body_downgraded");
  }

  if (status === "ok") {
    warnings.push("ok_does_not_guarantee_truth");
  }

  const verdict: ResearchVerdict = {
    status,
    plan,
    corpus,
    injectionText: "",
    sources: corpus.sources.slice(0, 12).map((s) => ({
      title: s.title,
      uri: s.uri,
      originalUrl: s.originalUrl,
      resolvedUrl: s.resolvedUrl,
    })),
    webSearchQueries: corpus.queriesUsed,
    warnings,
    // UI 依 completionStatus 顯示「已上網查證／部分查證／查證未完成」；failed／skipped 由 gateway 清來源
    showVerifiedBadge: status === "ok" || status === "partial",
    forbidStaleNewsVoice: status === "partial",
    evidenceGrades: grades,
  };
  verdict.injectionText = formatVerdictInjection(verdict);
  attachCost(verdict, corpus);
  return verdict;
}
