/** 供給者最多可託管到已用 95%（至少留 5% 自用，避免滿載後無法靠對話刷新用量） */
export const MAX_SUPPLIER_SHARE_LIMIT_PCT = 95;
export const MIN_SUPPLIER_SHARE_LIMIT_PCT = 10;
export const DEFAULT_SUPPLIER_SHARE_LIMIT_PCT = 80;

export function clampShareLimitPct(
  n: number | null | undefined,
  fallback = DEFAULT_SUPPLIER_SHARE_LIMIT_PCT,
): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(
    MIN_SUPPLIER_SHARE_LIMIT_PCT,
    Math.min(MAX_SUPPLIER_SHARE_LIMIT_PCT, Math.round(v)),
  );
}
