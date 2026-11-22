import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import { listDispatchByStatus, type DispatchStatus } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

const STATUSES: DispatchStatus[] = ["pending", "dispatched", "done", "rejected"];

/** Cursor 取已確認的指令：GET /api/strategy/dispatch?status=dispatched[&sessionId=][&workspaceId=] */
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
  const items = await listDispatchByStatus(auth.user.id, raw as DispatchStatus, {
    sessionId: url.searchParams.get("sessionId") || undefined,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    limit: Number(url.searchParams.get("limit") || "50"),
  });
  return Response.json({ items });
}
