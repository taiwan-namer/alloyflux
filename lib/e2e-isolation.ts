/**
 * E2E 隔離 fail-closed helper。
 * 僅當 process.env.E2E_ISOLATION === "1" 時封鎖出站／DB；其餘模式完全 no-op。
 * 不得把空 DATABASE_URL、瀏覽器 mock、或旗標「存在但非 1」當成隔離成立。
 */

export const E2E_ISOLATION_FLAG = "E2E_ISOLATION";

export class E2EIsolationError extends Error {
  readonly surface: string;
  constructor(surface: string) {
    super(`E2E_ISOLATION blocked: ${surface}`);
    this.name = "E2EIsolationError";
    this.surface = surface;
  }
}

/** 嚴格等於 "1" 才啟用；其他值（含空、true、yes）皆視為未隔離。 */
export function isE2EIsolationActive(): boolean {
  return process.env.E2E_ISOLATION === "1";
}

/**
 * 出站／DB 入口第一行呼叫。
 * 隔離開啟 → throw；未開啟 → 立即 return（不改正常行為）。
 */
export function assertE2EOrPass(surface: string): void {
  if (!isE2EIsolationActive()) return;
  throw new E2EIsolationError(surface);
}
