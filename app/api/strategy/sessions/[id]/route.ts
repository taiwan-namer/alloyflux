import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey, authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  getStrategySession,
  listRunsForSession,
  listSessionMessages,
  listSessionReports,
  readDossier,
  STRATEGY_LIMITS,
  STRATEGY_SESSION_STATUSES,
  updateStrategySession,
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
  return Response.json({
    session,
    dossier: readDossier(session.meta),
    messages,
    runs,
    reports,
    limits: STRATEGY_LIMITS,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    status?: StrategySessionStatus;
    pendingInstructions?: unknown[];
    meta?: Record<string, unknown>;
    model?: string;
  };
  if (body.status && !STRATEGY_SESSION_STATUSES.includes(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }
  const ok = await updateStrategySession(auth.user.id, id, body);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  const session = await getStrategySession(auth.user.id, id);
  return Response.json({ session });
}
