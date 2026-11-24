import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticateStrategyActor, authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  createStrategySession,
  listStrategySessions,
  templateIdExists,
  validateSessionModels,
  type StrategySessionStatus,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyReader(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "20");
  return Response.json({ sessions: await listStrategySessions(auth.user.id, limit) });
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const fromWeb = auth.via === "session";

  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      profileId?: string;
      strategyVersion?: string;
      model?: string;
      meta?: Record<string, unknown>;
      status?: StrategySessionStatus;
      workspaceId?: string;
      topic?: string;
      autoDispatch?: boolean;
      templateId?: string;
      models?: unknown;
    };
    if (!body.name?.trim()) {
      return Response.json({ error: "name required" }, { status: 400 });
    }
    if (body.templateId != null && body.templateId !== "" && !(await templateIdExists(body.templateId))) {
      return Response.json({ error: "unknown templateId" }, { status: 400 });
    }
    let models;
    if (body.models !== undefined) {
      const v = validateSessionModels(body.models);
      if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
      models = v.models;
    }
    const created = await createStrategySession({
      userId: auth.user.id,
      name: body.name,
      profileId: body.profileId,
      strategyVersion: body.strategyVersion,
      model: body.model,
      meta: fromWeb ? undefined : body.meta,
      status: fromWeb ? "discovery" : body.status,
      workspaceId: body.workspaceId,
      topic: body.topic,
      autoDispatch: typeof body.autoDispatch === "boolean" ? body.autoDispatch : !fromWeb,
      templateId: body.templateId,
      models,
    });
    return Response.json({ session: { id: created.id } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: msg === "workspace not found" ? 404 : 500 });
  }
}
