import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor, authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  applySessionPauseAction,
  getStrategySession,
  listRunsForSessionBrief,
  listSessionDispatch,
  listSessionMessagesPage,
  listSessionReports,
  PAUSE_ACTIONS,
  readDossier,
  softDeleteStrategySession,
  STRATEGY_LIMITS,
  STRATEGY_SESSION_STATUSES,
  templateIdExists,
  updateStrategySession,
  validateSessionModels,
  readRoomMode,
  type PauseAction,
  type StrategySessionStatus,
} from "@/lib/strategy-loop";
import { readLedger, renderLedgerForHuman, validateLedgerInput } from "@/lib/strategy-ledger";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const session = await getStrategySession(auth.user.id, id);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  const url = new URL(req.url);
  const withMessages = url.searchParams.get("messages") !== "0";
  const before = url.searchParams.get("before");
  const rawLimit = url.searchParams.get("limit");
  const pageMode = before != null || rawLimit != null;
  const lite = url.searchParams.get("lite") === "1";

  const limit =
    rawLimit == null || !Number.isFinite(Number(rawLimit))
      ? STRATEGY_LIMITS.messagesPageSize
      : Number(rawLimit);

  // #8：訊息／runs／reports／dispatch 平行查；lite 跳過 COUNT 與報告內文、runs 大 JSON
  const [page, runs, reportRows, dispatch] = await Promise.all([
    withMessages
      ? listSessionMessagesPage(auth.user.id, id, {
          limit,
          before: pageMode ? before : null,
          skipTotal: lite,
        })
      : Promise.resolve({
          messages: [] as Awaited<ReturnType<typeof listSessionMessagesPage>>["messages"],
          hasMore: false,
          nextCursor: null as string | null,
          total: 0,
        }),
    listRunsForSessionBrief(auth.user.id, id, lite ? 5 : 10),
    listSessionReports(auth.user.id, id, lite ? 20 : 30, { includeContent: false }),
    listSessionDispatch(auth.user.id, id, lite ? 30 : 50),
  ]);

  const reports = reportRows.map((r) => ({
    id: r.id,
    requestId: r.requestId,
    kind: r.kind,
    title: r.title,
    chars: r.chars,
    createdAt: r.createdAt,
  }));
  const ledger = readLedger(session.meta);
  return Response.json({
    session,
    dossier: readDossier(session.meta),
    ledger,
    ledgerText: renderLedgerForHuman(ledger),
    mode: readRoomMode(session.meta),
    messages: page.messages,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    messageTotal: page.total,
    runs,
    reports,
    dispatch,
    limits: STRATEGY_LIMITS,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    status?: StrategySessionStatus;
    pendingInstructions?: unknown[];
    meta?: Record<string, unknown>;
    model?: string;
    name?: string;
    topic?: string;
    autoDispatch?: boolean;
    pauseAction?: string;
    pauseState?: unknown;
    models?: unknown;
    templateId?: string;
    ledger?: unknown;
    mode?: string;
  };

  if (body.mode !== undefined) {
    if (body.mode !== "lean" && body.mode !== "classic") {
      return Response.json({ error: "mode 只能是 lean 或 classic" }, { status: 400 });
    }
    const cur = await getStrategySession(auth.user.id, id);
    if (!cur) return Response.json({ error: "Not found" }, { status: 404 });
    const ok = await updateStrategySession(auth.user.id, id, { meta: { ...cur.meta, mode: body.mode } });
    if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ session: await getStrategySession(auth.user.id, id), mode: body.mode });
  }

  if (body.ledger !== undefined) {
    const checked = validateLedgerInput(body.ledger);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const cur = await getStrategySession(auth.user.id, id);
    if (!cur) return Response.json({ error: "Not found" }, { status: 404 });
    const ok = await updateStrategySession(auth.user.id, id, {
      meta: { ...cur.meta, ledger: checked.ledger },
    });
    if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
    const session = await getStrategySession(auth.user.id, id);
    return Response.json({
      session,
      ledger: checked.ledger,
      ledgerText: renderLedgerForHuman(checked.ledger),
    });
  }

  if (body.pauseState !== undefined) {
    return Response.json(
      { error: "Direct pauseState writes are forbidden; use pauseAction instead" },
      { status: 400 },
    );
  }

  if (body.pauseAction !== undefined) {
    if (!PAUSE_ACTIONS.includes(body.pauseAction as PauseAction)) {
      return Response.json(
        { error: "pauseAction must be graceful_pause | force_pause | resume" },
        { status: 400 },
      );
    }
    const pauseResult = await applySessionPauseAction(
      auth.user.id,
      id,
      body.pauseAction as PauseAction,
    );
    if (!pauseResult) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ session: pauseResult.session, pauseResult });
  }

  if (body.status && !STRATEGY_SESSION_STATUSES.includes(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  let modelsPatch: ReturnType<typeof validateSessionModels> | undefined;
  if (body.models !== undefined) {
    modelsPatch = validateSessionModels(body.models);
    if (!modelsPatch.ok) return Response.json({ error: modelsPatch.error }, { status: 400 });
  }
  if (body.templateId !== undefined && body.templateId !== "" && !(await templateIdExists(body.templateId))) {
    return Response.json({ error: "unknown templateId" }, { status: 400 });
  }

  const patch =
    auth.via === "api_key"
      ? {
          status: body.status,
          pendingInstructions: body.pendingInstructions,
          meta: body.meta,
          model: body.model,
          name: body.name,
          topic: body.topic,
          autoDispatch: body.autoDispatch,
          models: modelsPatch?.ok ? modelsPatch.models : undefined,
          templateId: typeof body.templateId === "string" ? body.templateId : undefined,
        }
      : {
          name: typeof body.name === "string" ? body.name : undefined,
          topic: typeof body.topic === "string" ? body.topic : undefined,
          autoDispatch: typeof body.autoDispatch === "boolean" ? body.autoDispatch : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          models: modelsPatch?.ok ? modelsPatch.models : undefined,
          templateId: typeof body.templateId === "string" ? body.templateId : undefined,
        };
  const ok = await updateStrategySession(auth.user.id, id, patch);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  const session = await getStrategySession(auth.user.id, id);
  return Response.json({ session });
}

/** 軟刪會議室：側欄消失；訊息仍留庫（與對話垃圾桶同概念，暫無還原 UI） */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = await softDeleteStrategySession(auth.user.id, id);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
