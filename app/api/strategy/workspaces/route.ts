import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import {
  createStrategyWorkspace,
  listStrategyWorkspacesBrief,
  listWorkspaceSessionsBriefMany,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const trash = new URL(req.url).searchParams.get("trash") === "1";
  // #8：側欄投影＋一次撈齊房間（無 1+N）
  const workspaces = await listStrategyWorkspacesBrief(auth.user.id, { trash });
  const roomsByWs = await listWorkspaceSessionsBriefMany(
    auth.user.id,
    workspaces.map((ws) => ws.id),
  );
  const withRooms = workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    memory: ws.memory,
    rooms: (roomsByWs.get(ws.id) ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      topic: s.topic,
      status: s.status,
      autoDispatch: s.autoDispatch,
      updatedAt: s.updatedAt,
    })),
  }));
  return Response.json({ workspaces: withRooms });
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { name?: string; templateId?: string };
  if (!body.name?.trim()) return Response.json({ error: "name required" }, { status: 400 });
  const created = await createStrategyWorkspace({
    userId: auth.user.id,
    name: body.name,
    templateId: body.templateId,
  });
  return Response.json({ workspace: { id: created.id } });
}
