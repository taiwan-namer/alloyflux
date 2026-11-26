import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  getSessionSyncMeta,
  getStrategySession,
  listRunsForSessionBrief,
  listSessionDispatch,
  listSessionMessagesAfter,
  listSessionMessagesPage,
  listSessionReports,
  readDossier,
  STRATEGY_LIMITS,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

const SYNC_AFTER_MAX = 50;

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

  // 畫面只要最近幾則。客戶端 count 若已是總數、且這輪只多了幾則，多帶一則重疊以免中間被跳過；開房時 count 仍是視窗長度，不要因此把歷史撈回來。
  const rawPage = Number(url.searchParams.get("limit") || "5");
  const requested = Number.isFinite(rawPage) ? Math.min(Math.max(Math.floor(rawPage), 1), 8) : 5;
  const grown =
    clientCount != null && clientCount > 0 ? Math.max(0, meta.messageCount - clientCount) : 0;
  const pageLimit =
    grown > 0 && grown <= 8 ? Math.min(8, Math.max(requested, grown + 1)) : requested;
  // 客戶端帶本機最新一則游標：補齊游標之後的全部新訊息，避免閒置回來新增太多時中間缺一段
  const after = url.searchParams.get("after");
  const [page, gapFill, runs, reportRows, dispatch] = await Promise.all([
    listSessionMessagesPage(auth.user.id, id, {
      limit: pageLimit,
      skipTotal: true,
    }),
    after ? listSessionMessagesAfter(auth.user.id, id, after, SYNC_AFTER_MAX) : null,
    listRunsForSessionBrief(auth.user.id, id, 10),
    listSessionReports(auth.user.id, id, 30, { includeContent: false }),
    listSessionDispatch(auth.user.id, id, 50),
  ]);
  let messages = page.messages;
  if (gapFill?.messages.length) {
    const byId = new Map(gapFill.messages.map((m) => [m.id, m]));
    for (const m of page.messages) byId.set(m.id, m);
    messages = [...byId.values()].sort((a, b) =>
      a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
  // 新增量超過補齊上限：中間仍會缺，要客戶端整房重載
  const gap = Boolean(gapFill?.truncated);
  const reports = reportRows.map((r) => ({
    id: r.id,
    requestId: r.requestId,
    kind: r.kind,
    title: r.title,
    chars: r.chars,
    createdAt: r.createdAt,
  }));

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
    messages,
    gap,
    runs,
    reports,
    dispatch,
    limits: STRATEGY_LIMITS,
  });
}
