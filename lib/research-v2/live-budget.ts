/**
 * Live E2E 成本帽（P0-5）
 * 測試 A／B 分開計數；failover／retry 不得繞過上限。
 * 若無法取得實際金額，以請求次數＋Token 估算＋停止條件為準。
 */

export type LiveTestMode = "A_product_path" | "B_fixed_evidence";

export type LiveBudgetCounters = {
  mode: LiveTestMode;
  fullAnswers: number;
  searchCalls: number;
  flashCalls: number;
  groundingToolCalls: number;
  extraModelCalls: number;
  estimatedTokens: number;
  stoppedReason?: string;
};

export type LiveBudgetConfig = {
  maxFullAnswersPerMode: number;
  maxSearchCallsPerMode: number;
  maxFlashCallsPerMode: number;
  maxExtraModelCallsPerMode: number;
  maxEstimatedTokensPerMode: number;
};

export const DEFAULT_LIVE_BUDGET: LiveBudgetConfig = {
  maxFullAnswersPerMode: 9, // 3 模型 × 3 題
  maxSearchCallsPerMode: 12,
  maxFlashCallsPerMode: 12,
  maxExtraModelCallsPerMode: 18,
  maxEstimatedTokensPerMode: 250_000,
};

export function createLiveBudget(mode: LiveTestMode): LiveBudgetCounters {
  return {
    mode,
    fullAnswers: 0,
    searchCalls: 0,
    flashCalls: 0,
    groundingToolCalls: 0,
    extraModelCalls: 0,
    estimatedTokens: 0,
  };
}

export type BudgetCheck =
  | { allow: true }
  | { allow: false; reason: string };

export function checkLiveBudget(
  c: LiveBudgetCounters,
  cfg: LiveBudgetConfig = DEFAULT_LIVE_BUDGET,
  next?: Partial<Pick<LiveBudgetCounters, "fullAnswers" | "searchCalls" | "flashCalls" | "extraModelCalls" | "estimatedTokens">>,
): BudgetCheck {
  if (c.stoppedReason) return { allow: false, reason: c.stoppedReason };

  const full = c.fullAnswers + (next?.fullAnswers ?? 0);
  const search = c.searchCalls + (next?.searchCalls ?? 0);
  const flash = c.flashCalls + (next?.flashCalls ?? 0);
  const extra = c.extraModelCalls + (next?.extraModelCalls ?? 0);
  const tokens = c.estimatedTokens + (next?.estimatedTokens ?? 0);

  if (full > cfg.maxFullAnswersPerMode) {
    return { allow: false, reason: `full_answers_cap:${cfg.maxFullAnswersPerMode}` };
  }
  if (search > cfg.maxSearchCallsPerMode) {
    return { allow: false, reason: `search_calls_cap:${cfg.maxSearchCallsPerMode}` };
  }
  if (flash > cfg.maxFlashCallsPerMode) {
    return { allow: false, reason: `flash_calls_cap:${cfg.maxFlashCallsPerMode}` };
  }
  if (extra > cfg.maxExtraModelCallsPerMode) {
    return { allow: false, reason: `extra_model_calls_cap:${cfg.maxExtraModelCallsPerMode}` };
  }
  if (tokens > cfg.maxEstimatedTokensPerMode) {
    return { allow: false, reason: `estimated_tokens_cap:${cfg.maxEstimatedTokensPerMode}` };
  }
  return { allow: true };
}

/** 記一筆；超限則標記 stoppedReason 並回傳 false */
export function recordLiveUsage(
  c: LiveBudgetCounters,
  delta: Partial<
    Pick<
      LiveBudgetCounters,
      "fullAnswers" | "searchCalls" | "flashCalls" | "groundingToolCalls" | "extraModelCalls" | "estimatedTokens"
    >
  >,
  cfg: LiveBudgetConfig = DEFAULT_LIVE_BUDGET,
): boolean {
  const check = checkLiveBudget(c, cfg, {
    fullAnswers: delta.fullAnswers ?? 0,
    searchCalls: delta.searchCalls ?? 0,
    flashCalls: delta.flashCalls ?? 0,
    extraModelCalls: delta.extraModelCalls ?? 0,
    estimatedTokens: delta.estimatedTokens ?? 0,
  });
  if (!check.allow) {
    c.stoppedReason = check.reason;
    return false;
  }
  c.fullAnswers += delta.fullAnswers ?? 0;
  c.searchCalls += delta.searchCalls ?? 0;
  c.flashCalls += delta.flashCalls ?? 0;
  c.groundingToolCalls += delta.groundingToolCalls ?? 0;
  c.extraModelCalls += delta.extraModelCalls ?? 0;
  c.estimatedTokens += delta.estimatedTokens ?? 0;
  return true;
}

/** A＋B 合計上限報告（各 9 次回答 → 最多 18） */
export function combinedAnswerCap(cfg: LiveBudgetConfig = DEFAULT_LIVE_BUDGET): number {
  return cfg.maxFullAnswersPerMode * 2;
}

export function isLiveE2EEnabled(): boolean {
  return process.env.RESEARCH_LIVE_E2E === "1";
}
