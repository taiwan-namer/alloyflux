import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import {
  clampDispatchWaitMs,
  DISPATCH_POLL_WAIT_MS,
  waitForDispatchedItems,
} from "@/lib/strategy-dispatch-wait";
import { listDispatchByStatus, type DispatchStatus } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";
/** 長輪詢上限；與 /api/agent/poll 對齊 */
export const maxDuration = 60;

const STATUSES: DispatchStatus[] = ["pending", "dispatched", "done", "rejected"];

/**
 * Cursor 取指令：
 * - 立即：GET /api/strategy/dispatch?status=dispatched
 * - 長輪詢（建議）：GET /api/strategy/dispatch?status=dispatched&waitMs=25000
 *   有新 dispatched 立刻回；否則等到 waitMs（上限 55s）後回空列表。
 *   Cursor 常駐迴圈打此 API，即可取代「每五分鐘盲爬」。
 */
export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const raw = url.searchParams.get("status") || "dispatched";
  if (!STATUSES.includes(raw as DispatchStatus)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }
  const status = raw as DispatchStatus;
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const workspaceId = url.searchParams.get("workspaceId") || undefined;
  const limit = Number(url.searchParams.get("limit") || "50");
  const waitMs = clampDispatchWaitMs(url.searchParams.get("waitMs"));

  const items =
    waitMs > 0
      ? await waitForDispatchedItems(auth.user.id, status, {
          sessionId,
          workspaceId,
          limit,
          waitMs,
          signal: req.signal,
        })
      : await listDispatchByStatus(auth.user.id, status, { sessionId, workspaceId, limit });

  return Response.json({
    items,
    waitedMs: waitMs,
    /** 給 Cursor 腳本的建議：空列表時隔多久再連；有指令時應立刻處理後再 wait */
    nextWaitMs: items.length ? 0 : waitMs > 0 ? waitMs : DISPATCH_POLL_WAIT_MS,
  });
}
