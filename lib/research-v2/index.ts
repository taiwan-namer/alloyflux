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
export { planResearch, formatDateInTimeZone, plannerQueryFingerprint } from "./planner";
export { collectEventsFromHit, rankEventsWithDiversity } from "./collector";
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
import { isResearchPipelineV2Enabled, runResearchPipelineV2, type ChatTurn } from "./pipeline";
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
  if (shouldSkipLiveResearch(last) && !needsWebResearch(last)) return null;

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
