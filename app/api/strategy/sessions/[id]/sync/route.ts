import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  getSessionSyncMeta,
  getStrategySession,
  listRunsForSession,
  listSessionDispatch,
  listSessionMessagesPage,
  listSessionReports,
  readDossier,
  STRATEGY_LIMITS,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

/** 輕量增量同步：GET /api/strategy/sessions/[id]/sync?since=<ms>&count=<n> */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const rawSince = url.searchParams.get("since");
  const since = rawSince == null || rawSince === "" ? 0 : Number(rawSince);
  if (!Number.isFinite(since) || since < 0) {
    return Response.json({ error: "since must be a non-negative number" }, { status: 400 });
  }
  const rawCount = url.searchParams.get("count");
  const clientCount =
    rawCount == null || rawCount === "" ? null : Number(rawCount);
  if (clientCount != null && (!Number.isFinite(clientCount) || clientCount < 0)) {
    return Response.json({ error: "count must be a non-negative number" }, { status: 400 });
  }

  const meta = await getSessionSyncMeta(auth.user.id, id);
  if (!meta) return Response.json({ error: "Not found" }, { status: 404 });

  const watermarkAdvanced = !(since > 0 && meta.maxUpdatedAt <= since);
  const countChanged = clientCount != null && clientCount !== meta.messageCount;
  const changed = watermarkAdvanced || countChanged;

  if (!changed) {
    return Response.json({
      changed: false,
      updatedAt: meta.maxUpdatedAt,
      sessionUpdatedAt: meta.sessionUpdatedAt,
      workspaceUpdatedAt: meta.workspaceUpdatedAt,
      messageCount: meta.messageCount,
    });
  }

  const session = await getStrategySession(auth.user.id, id);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });

  // 輕量：只回最新一頁，前端 merge 保留已載入的更早訊息
  const page = await listSessionMessagesPage(auth.user.id, id, {
    limit: STRATEGY_LIMITS.messagesPageSize,
  });
  const runs = await listRunsForSession(auth.user.id, id, 10);
  const reports = (await listSessionReports(auth.user.id, id, 30)).map((r) => ({
    id: r.id,
    requestId: r.requestId,
    kind: r.kind,
    title: r.title,
    chars: r.chars,
    createdAt: r.createdAt,
  }));
  const dispatch = await listSessionDispatch(auth.user.id, id, 50);

  return Response.json({
    changed: true,
    updatedAt: meta.maxUpdatedAt,
    sessionUpdatedAt: meta.sessionUpdatedAt,
    workspaceUpdatedAt: meta.workspaceUpdatedAt,
    messageCount: meta.messageCount,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    messageTotal: page.total,
    workspaceMemoryNotes: meta.workspaceMemoryNotes,
    session,
    dossier: readDossier(session.meta),
    messages: page.messages,
    runs,
    reports,
    dispatch,
    limits: STRATEGY_LIMITS,
  });
}
