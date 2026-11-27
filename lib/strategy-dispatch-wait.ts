/**
 * Cursor 取指令長輪詢：有新的 dispatched 立刻回，不必盲等五分鐘。
 * 同實例用 in-memory wake；跨實例靠短間隔 DB 輪詢兜底（與 /api/agent/poll 同模式）。
 */
import { listDispatchByStatus, type DispatchStatus } from "./strategy-loop";

export const DISPATCH_POLL_WAIT_MS = 25_000;
export const DISPATCH_POLL_WAIT_MAX_MS = 55_000;
const DB_POLL_MS = 500;

type Waiter = () => void;

const globalForDispatchWait = globalThis as unknown as {
  __strategyDispatchWaiters?: Map<string, Set<Waiter>>;
};
const waiters = (globalForDispatchWait.__strategyDispatchWaiters ??= new Map<string, Set<Waiter>>());

function subscribe(userId: string, fn: Waiter): () => void {
  let set = waiters.get(userId);
  if (!set) {
    set = new Set();
    waiters.set(userId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) waiters.delete(userId);
  };
}

/** 新指令寫入／手動派送後呼叫，叫醒同實例上的長輪詢 */
export function wakeDispatchWaiters(userId: string): void {
  const set = waiters.get(userId);
  if (!set?.size) return;
  for (const w of [...set]) w();
  set.clear();
  waiters.delete(userId);
}

export function clampDispatchWaitMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(Math.floor(n), 0), DISPATCH_POLL_WAIT_MAX_MS);
}

export type DispatchWaitOpts = {
  sessionId?: string;
  workspaceId?: string;
  limit?: number;
  /** 0＝立即查一次；>0 則等到有指令或逾時 */
  waitMs?: number;
  signal?: AbortSignal;
};

export async function waitForDispatchedItems(
  userId: string,
  status: DispatchStatus = "dispatched",
  opts: DispatchWaitOpts = {},
) {
  const waitMs = clampDispatchWaitMs(opts.waitMs ?? 0);
  const listOpts = {
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    limit: opts.limit,
  };

  let items = await listDispatchByStatus(userId, status, listOpts);
  if (items.length > 0 || waitMs <= 0) return items;

  // 長輪詢只對「等已派送指令」有意義；pending 仍可立即查
  if (status !== "dispatched") return items;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolve();
      };
      const unsub = subscribe(userId, done);
      const timer = setTimeout(done, Math.min(DB_POLL_MS, remaining));
      if (opts.signal) {
        if (opts.signal.aborted) {
          done();
          return;
        }
        opts.signal.addEventListener("abort", done, { once: true });
      }
    });

    items = await listDispatchByStatus(userId, status, listOpts);
    if (items.length > 0) return items;
  }

  return items;
}
