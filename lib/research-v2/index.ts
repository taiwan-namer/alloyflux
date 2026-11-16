export type {
  CompletionStatus,
  EvidenceGrade,
  EvidenceLevel,
  EvidenceProvenance,
  FetchStatus,
  RawSearchHit,
  ResearchClaim,
  ResearchClaimType,
  ResearchCorpus,
  ResearchCost,
  ResearchDebugSnapshot,
  ResearchEvent,
  ResearchGateStatus,
  ResearchIntent,
  ResearchPlan,
  ResearchResult,
  ResearchSource,
  ResearchSupplyPath,
  ResearchVerdict,
} from "./types";

export { PHASE4_PRODUCT_MODELS } from "./types";
export {
  planResearch,
  formatDateInTimeZone,
  plannerQueryFingerprint,
  detectIntent,
  extractUserInstructionText,
  hasExplicitLiveDemand,
  isSummarizeOrTranslateOnly,
} from "./planner";
export {
  collectEventsFromHit,
  rankEventsWithDiversity,
  stripSearchSynthesisFromCorpus,
} from "./collector";
export {
  isSearchSynthesisEnabled,
  isSearchSynthesisExplicitlyOff,
  shouldEnableSearchSynthesis,
} from "./synthesis-flag";
export { gateEvidence } from "./gate";
export { formatVerdictInjection, shouldShowVerifiedBadge, measureInjectionBudget } from "./inject";
export {
  estimateTokensApprox,
  injectionMaxTokens,
  charsBudgetForTokens,
  DEFAULT_INJECTION_MAX_TOKENS,
} from "./token-budget";
export { sanitizeEvidenceText, wrapAsUntrustedEvidence, fingerprintQuery } from "./sanitize";
export {
  runResearchPipelineV2,
  isResearchPipelineV2Enabled,
  verdictToLegacyBundle,
  buildResearchFlowTrace,
  type PipelineOptions,
  type ChatTurn,
} from "./pipeline";
export {
  getPreparedVerdict,
  isPlatformResearchDone,
  getResearchContext,
  runWithResearchContext,
  runWithResearchContextAsync,
} from "./context";
export { isResearchDebugEnabled, logResearchDebug } from "./debug";
export {
  attachResearchToDone,
  modelNeedsPlatformResearch,
  mockGatewayWithResearch,
} from "./gateway-contract";
export {
  verdictToResearchResult,
  geminiGroundingToResearchResult,
  completionFromGate,
} from "./contract";
export {
  createLiveBudget,
  checkLiveBudget,
  recordLiveUsage,
  combinedAnswerCap,
  isLiveE2EEnabled,
  DEFAULT_LIVE_BUDGET,
  type LiveTestMode,
  type LiveBudgetCounters,
} from "./live-budget";
export { validatePublicHttpsUrl, isBlockedIp, safeFetchText } from "./ssrf";

import { needsWebResearch, shouldSkipLiveResearch } from "../web-research";
import {
  getPreparedVerdict,
  isPlatformResearchDone,
  runWithResearchContextAsync,
} from "./context";
import {
  extractUserInstructionText,
  hasExplicitLiveDemand,
} from "./instruction-text";
import { isResearchPipelineV2Enabled, runResearchPipelineV2, type ChatTurn } from "./pipeline";
import { planResearch } from "./planner";
import type { ResearchSupplyPath, ResearchVerdict } from "./types";

/** 平台側只跑一次；供 Gateway 在 Node／local 前呼叫 */
export async function preparePlatformResearch(input: {
  messages: ChatTurn[];
  supplyPath: ResearchSupplyPath;
  signal?: AbortSignal;
  now?: Date;
  timeZone?: string;
}): Promise<ResearchVerdict | null> {
  if (!isResearchPipelineV2Enabled()) return null;
  const last = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!last.trim()) return null;
  // 與 Planner 同一剝離規則；intent=skip 時不進 pipeline（省 Flash）
  const early = planResearch({ text: last, now: input.now, timeZone: input.timeZone });
  if (!early.requireLive || early.intent === "skip") return null;
  // 雙保險：剝離後仍無聯網意圖
  const instruction = extractUserInstructionText(last);
  if (
    instruction &&
    !hasExplicitLiveDemand(instruction) &&
    shouldSkipLiveResearch(instruction) &&
    !needsWebResearch(instruction) &&
    early.intent !== "news" &&
    early.intent !== "factcheck"
  ) {
    return null;
  }

  return runResearchPipelineV2({
    messages: input.messages,
    supplyPath: input.supplyPath,
    signal: input.signal,
    now: input.now,
    timeZone: input.timeZone,
  });
}

/**
 * 將 AsyncGenerator 的每次 next 綁定到 Research Context，
 * 避免 Node→local failover 時 provider 重複搜尋。
 */
export async function* withPlatformResearchScope<T>(
  verdict: ResearchVerdict | null,
  supplyPath: ResearchSupplyPath,
  gen: AsyncGenerator<T>,
): AsyncGenerator<T> {
  if (!verdict) {
    yield* gen;
    return;
  }
  const ctx = {
    verdict,
    supplyPath,
    platformResearchDone: true,
  };
  const it = gen[Symbol.asyncIterator]();
  for (;;) {
    const step = await runWithResearchContextAsync(ctx, () => it.next());
    if (step.done) return;
    yield step.value;
  }
}

/** provider 內：已有平台結果則重用 */
export function reusePreparedResearch(): ResearchVerdict | null {
  if (!isPlatformResearchDone()) return null;
  return getPreparedVerdict() ?? null;
}
