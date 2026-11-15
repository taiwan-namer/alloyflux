/**
 * oauth_sub 單執行緒繁忙鎖（Concurrency = 1）。
 * 非阻塞：拿不到鎖立即回 false，路由器應在 O(1) 內改抽下一個貨源。
 * api_key 不走此鎖。
 */

type LockEntry = { heldAt: number };

const globalForLocks = globalThis as unknown as {
  __oauthSourceLocks?: Map<string, LockEntry>;
};

const locks = (globalForLocks.__oauthSourceLocks ??= new Map());

/** 鎖僵屍保護：極端情況下未釋放超過此時長視為可搶 */
const STALE_MS = 5 * 60_000;

export function isSourceBusy(sourceId: string): boolean {
  const e = locks.get(sourceId);
  if (!e) return false;
  if (Date.now() - e.heldAt > STALE_MS) {
    locks.delete(sourceId);
    return false;
  }
  return true;
}

/** 非阻塞取得鎖；成功回 true */
export function tryAcquireSourceLock(sourceId: string): boolean {
  if (isSourceBusy(sourceId)) return false;
  locks.set(sourceId, { heldAt: Date.now() });
  return true;
}

export function releaseSourceLock(sourceId: string): void {
  locks.delete(sourceId);
}

export function oauthInFlightCount(): number {
  // 順便清僵屍
  const now = Date.now();
  for (const [id, e] of locks) {
    if (now - e.heldAt > STALE_MS) locks.delete(id);
  }
  return locks.size;
}
