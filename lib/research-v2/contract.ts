/**
 * 三模型共同結果契約：欄位可缺失／unknown，禁止填造。
 */
import type {
  CompletionStatus,
  ResearchClaim,
  ResearchEvent,
  ResearchResult,
  ResearchSource,
  ResearchVerdict,
} from "./types";

export function completionFromGate(
  status: ResearchVerdict["status"],
): CompletionStatus {
  if (status === "ok") return "complete";
  if (status === "partial") return "truncated";
  if (status === "failed") return "failed";
  return "unknown";
}

/** V2 verdict → 共同 ResearchResult（缺欄保持 undefined） */
export function verdictToResearchResult(verdict: ResearchVerdict): ResearchResult {
  const events: ResearchEvent[] = verdict.corpus?.events ?? [];
  const claims: ResearchClaim[] = events.flatMap((e) => e.claims);
  const sources: ResearchSource[] = verdict.corpus?.sources ?? [];
  return {
    status: verdict.status,
    events,
    claims,
    sources,
    warnings: verdict.warnings,
    researchCost: verdict.researchCost,
    completionStatus: verdict.completionStatus ?? completionFromGate(verdict.status),
    injectionText: verdict.injectionText,
    webSearchQueries: verdict.webSearchQueries,
    showVerifiedBadge: verdict.showVerifiedBadge,
  };
}

/**
 * Gemini 原生 Grounding → 共同契約。
 * 不填造 publishedAt／articleBody／eventAt／claimType；缺則 unknown。
 */
export function geminiGroundingToResearchResult(input: {
  sources: { title: string; uri: string }[];
  queries?: string[];
  warnings?: string[];
}): ResearchResult {
  const sources: ResearchSource[] = [];
  for (const s of input.sources) {
    const uri = (s.uri || "").trim();
    if (!uri || uri.includes("…")) continue;
    let host = "";
    try {
      host = new URL(uri).hostname.replace(/^www\./i, "");
    } catch {
      continue;
    }
    sources.push({
      sourceId: `gem_${sources.length + 1}`,
      title: (s.title || host || uri).trim(),
      uri,
      originalUrl: uri,
      // resolvedUrl／publishedAt／excerpt 故意省略（unknown）
      host,
      quality: "normal",
      fetchStatus: "unresolved",
      provenance: "unknown",
    });
  }

  return {
    status: sources.length ? "partial" : "failed",
    events: [],
    claims: [],
    sources,
    warnings: [
      ...(input.warnings ?? []),
      "gemini_native_grounding_partial_fields",
      "unknown_fields_not_fabricated",
    ],
    researchCost: {
      estimatedInjectionTokens: 0,
      flashCalls: 0,
      pageFetchAttempts: 0,
      unavailableActualUsage: true,
    },
    completionStatus: sources.length ? "truncated" : "failed",
    injectionText: "",
    webSearchQueries: input.queries ?? [],
    showVerifiedBadge: sources.length > 0,
  };
}
