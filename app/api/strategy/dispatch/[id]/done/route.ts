import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import { markDispatchDone } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

/** Cursor 回報完成：body { note?: string } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const ok = await markDispatchDone(auth.user.id, id, typeof body.note === "string" ? body.note : "");
  if (!ok) return Response.json({ error: "Not found or not dispatched" }, { status: 404 });
  return Response.json({ ok: true });
}
