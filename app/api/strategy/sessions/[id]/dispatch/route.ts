import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import { decideDispatchItems, getStrategySession, listSessionDispatch } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await getStrategySession(auth.user.id, id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ items: await listSessionDispatch(auth.user.id, id, 100) });
}

/** body: { action: "dispatch" | "reject", ids: string[] } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await getStrategySession(auth.user.id, id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; ids?: unknown };
  if (body.action !== "dispatch" && body.action !== "reject") {
    return Response.json({ error: "action must be dispatch or reject" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
  const changed = await decideDispatchItems(auth.user.id, id, ids, body.action);
  return Response.json({ changed, items: await listSessionDispatch(auth.user.id, id, 100) });
}
