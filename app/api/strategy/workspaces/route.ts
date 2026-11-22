import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import {
  createStrategyWorkspace,
  listStrategyWorkspaces,
  listWorkspaceSessions,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const trash = new URL(req.url).searchParams.get("trash") === "1";
  const workspaces = await listStrategyWorkspaces(auth.user.id, { trash });
  const withRooms = await Promise.all(
    workspaces.map(async (ws) => ({
      ...ws,
      rooms: (await listWorkspaceSessions(auth.user.id, ws.id)).map((s) => ({
        id: s.id,
        name: s.name,
        topic: s.topic,
        status: s.status,
        summary: s.summary,
        summaryUpdatedAt: s.summaryUpdatedAt,
        autoDispatch: s.autoDispatch,
        updatedAt: s.updatedAt,
      })),
    })),
  );
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
