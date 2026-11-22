import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import {
  buildWorkspaceBrief,
  getStrategyWorkspace,
  listWorkspaceSessions,
  softDeleteStrategyWorkspace,
  updateStrategyWorkspace,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const workspace = await getStrategyWorkspace(auth.user.id, id);
  if (!workspace) return Response.json({ error: "Not found" }, { status: 404 });
  const rooms = await listWorkspaceSessions(auth.user.id, id);
  const { text: brief } = await buildWorkspaceBrief(auth.user.id, id);
  return Response.json({ workspace, rooms, brief });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    memoryNotes?: string;
    restore?: boolean;
  };
  const ok = await updateStrategyWorkspace(auth.user.id, id, {
    name: typeof body.name === "string" ? body.name : undefined,
    memoryNotes: typeof body.memoryNotes === "string" ? body.memoryNotes : undefined,
    restore: body.restore === true,
  });
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ workspace: await getStrategyWorkspace(auth.user.id, id) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = await softDeleteStrategyWorkspace(auth.user.id, id);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
