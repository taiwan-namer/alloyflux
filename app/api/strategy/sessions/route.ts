import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey, authenticateStrategyReader } from "@/lib/platform-api-auth";
import {
  createStrategySession,
  listStrategySessions,
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
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      profileId?: string;
      strategyVersion?: string;
      model?: string;
      meta?: Record<string, unknown>;
      status?: StrategySessionStatus;
    };
    if (!body.name?.trim()) {
      return Response.json({ error: "name required" }, { status: 400 });
    }
    const created = await createStrategySession({
      userId: auth.user.id,
      name: body.name,
      profileId: body.profileId,
      strategyVersion: body.strategyVersion,
      model: body.model,
      meta: body.meta,
      status: body.status,
    });
    return Response.json({ session: { id: created.id } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
