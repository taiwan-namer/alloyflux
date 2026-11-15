import { formatVerdictInjection } from "./inject";
import type { ResearchCorpus, ResearchGateStatus, ResearchPlan, ResearchVerdict } from "./types";

function preferredOrNormalCount(corpus: ResearchCorpus): number {
  return corpus.sources.filter((s) => s.quality === "preferred" || s.quality === "normal").length;
}

function hasUnconfirmedWithoutAttribution(corpus: ResearchCorpus): boolean {
  return corpus.events.some((e) =>
    e.claims.some((c) => c.claimType === "unconfirmed" && !c.attribution),
  );
}

/**
 * Evidence Gate：決定 ok／partial／failed／skipped 與注入契約
 */
export function gateEvidence(input: {
  plan: ResearchPlan;
  corpus: ResearchCorpus | null;
  errorMessage?: string;
}): ResearchVerdict {
  const { plan, corpus, errorMessage } = input;

  if (plan.intent === "skip" || !plan.requireLive) {
    return {
      status: "skipped",
      plan,
      corpus: null,
      injectionText: "",
      sources: [],
      webSearchQueries: [],
      warnings: plan.skipReason ? [plan.skipReason] : [],
      showVerifiedBadge: false,
      forbidStaleNewsVoice: false,
    };
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
    };
    verdict.injectionText = formatVerdictInjection(verdict);
    return verdict;
  }

  const usable = preferredOrNormalCount(corpus);
  const eventCount = corpus.events.length;
  const warnings: string[] = [...corpus.limitations];

  if (usable === 0 || eventCount === 0) {
    const verdict: ResearchVerdict = {
      status: "failed",
      plan,
      corpus,
      injectionText: "",
      sources: corpus.sources.map((s) => ({ title: s.title, uri: s.uri })),
      webSearchQueries: corpus.queriesUsed,
      warnings: [...warnings, "no_usable_sources", "forbid_stale_news_voice"],
      showVerifiedBadge: false,
      forbidStaleNewsVoice: true,
    };
    verdict.injectionText = formatVerdictInjection(verdict);
    return verdict;
  }

  let status: ResearchGateStatus = "ok";
  if (usable < 2) {
    status = "partial";
    warnings.push("fewer_than_2_usable_sources");
  }
  if (eventCount < 2 && plan.coverageHints.length > 1) {
    status = "partial";
    warnings.push("low_event_coverage");
  }
  if (!corpus.sources.some((s) => s.publishedAt)) {
    status = status === "ok" ? "partial" : status;
    warnings.push("missing_published_at_on_all_sources");
  }
  if (hasUnconfirmedWithoutAttribution(corpus)) {
    warnings.push("unconfirmed_claims_present");
  }
  if (corpus.stats.truncatedEvents > 0) {
    warnings.push(`truncated_events:${corpus.stats.truncatedEvents}`);
  }

  // ok ≠ 新聞絕對正確
  if (status === "ok") {
    warnings.push("ok_does_not_guarantee_truth");
  }

  const verdict: ResearchVerdict = {
    status,
    plan,
    corpus,
    injectionText: "",
    sources: corpus.sources.slice(0, 12).map((s) => ({ title: s.title, uri: s.uri })),
    webSearchQueries: corpus.queriesUsed,
    warnings,
    showVerifiedBadge: status === "ok" || status === "partial",
    forbidStaleNewsVoice: status === "partial",
  };
  verdict.injectionText = formatVerdictInjection(verdict);
  return verdict;
}
