/**
 * search_synthesis feature flag 與層 2 防爬自動備援（Auto-Fallback）。
 * - 明確開啟：RESEARCH_SEARCH_SYNTHESIS=1
 * - 明確關閉：RESEARCH_SEARCH_SYNTHESIS=0 / off / false（連自動備援一併停用）
 * - 自動備援（autoFallback=true）任一成立即開啟：
 *   · 合格正文頁數 < 2 或正文 claim 數 < 2
 *   · 任一來源為 title_only（防爬／空殼）
 *   · plan.intent === "factcheck"
 */
export function isSearchSynthesisEnabled(): boolean {
  return process.env.RESEARCH_SEARCH_SYNTHESIS === "1";
}

export function isSearchSynthesisExplicitlyOff(): boolean {
  const v = process.env.RESEARCH_SEARCH_SYNTHESIS?.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

export type SynthesisDecision = {
  enabled: boolean;
  reason: "env_on" | "env_off" | "auto_fallback" | "default_off";
};

export function shouldEnableSearchSynthesis(opts?: {
  autoFallback?: boolean;
  validBodyPageCount?: number;
  bodyClaimCount?: number;
  /** 防爬失敗、僅有標題的來源數 */
  titleOnlySourceCount?: number;
  /** ResearchPlan.intent；factcheck 一律備援 */
  intent?: string;
}): SynthesisDecision {
  if (isSearchSynthesisExplicitlyOff()) {
    return { enabled: false, reason: "env_off" };
  }
  if (isSearchSynthesisEnabled()) {
    return { enabled: true, reason: "env_on" };
  }
  if (opts?.autoFallback) {
    const pages = opts.validBodyPageCount ?? 0;
    const bodyClaims = opts.bodyClaimCount ?? 0;
    const titleOnly = opts.titleOnlySourceCount ?? 0;
    if (pages < 2 || bodyClaims < 2 || titleOnly > 0 || opts.intent === "factcheck") {
      return { enabled: true, reason: "auto_fallback" };
    }
  }
  return { enabled: false, reason: "default_off" };
}
