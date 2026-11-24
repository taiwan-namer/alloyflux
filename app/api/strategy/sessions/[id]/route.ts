import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor, authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  applySessionPauseAction,
  getStrategySession,
  listRunsForSession,
  listSessionDispatch,
  listSessionMessages,
  listSessionReports,
  PAUSE_ACTIONS,
  readDossier,
  STRATEGY_LIMITS,
  STRATEGY_SESSION_STATUSES,
  templateIdExists,
  updateStrategySession,
  validateSessionModels,
  type PauseAction,
  type StrategySessionStatus,
} from "@/lib/strategy-loop";

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
  const messages = withMessages ? await listSessionMessages(auth.user.id, id, 40) : [];
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
    session,
    dossier: readDossier(session.meta),
    messages,
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
  };

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
