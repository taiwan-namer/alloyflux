/**
 * Token 預算工具（估算，非官方 tokenizer）
 *
 * 實際 Token：需上游 usage（目前 Flash grounding 路徑未記錄）
 * 估算 Token：CJK ≈ 1.5 字／tok → tok≈字/1.5；拉丁 ≈ 4 字／tok
 */

export const DEFAULT_INJECTION_MAX_TOKENS = 3000;

/** 可由 RESEARCH_INJECTION_MAX_TOKENS 覆寫 */
export function injectionMaxTokens(): number {
  const n = Number(process.env.RESEARCH_INJECTION_MAX_TOKENS ?? DEFAULT_INJECTION_MAX_TOKENS);
  if (!Number.isFinite(n) || n < 400) return DEFAULT_INJECTION_MAX_TOKENS;
  return Math.floor(n);
}

export function estimateTokensApprox(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * 字元硬上限（給舊介面相容）：以「全 CJK」最壞情況反推，
 * 3000 tok × 1.5 ≈ 4500 字；×1.6 約 4800。
 */
export function charsBudgetForTokens(maxTokens: number): number {
  return Math.max(800, Math.ceil(maxTokens * 1.6));
}

export type InjectionBudgetReport = {
  maxTokens: number;
  estimatedTokens: number;
  charLength: number;
  charHardCap: number;
  truncated: boolean;
  eventsIncluded: number;
  eventsOmitted: number;
  method: "estimated_heuristic_not_tokenizer";
};
