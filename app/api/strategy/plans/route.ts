import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import {
  createStrategyPlan,
  listStrategyPlans,
  type StrategyPlanStatus,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") as StrategyPlanStatus | null;
  const limit = Number(url.searchParams.get("limit") || "20");
  const plans = await listStrategyPlans(auth.user.id, {
    status: status || undefined,
    limit,
  });
  return Response.json({ plans });
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    hypotheses?: unknown[];
    changeRequests?: unknown[];
    acceptance?: unknown[];
    rawAnalysis?: string;
    roundIndex?: number;
    status?: StrategyPlanStatus;
  };
  if (!body.runId) {
    return Response.json({ error: "runId required" }, { status: 400 });
  }

  const created = await createStrategyPlan({
    userId: auth.user.id,
    runId: body.runId,
    hypotheses: body.hypotheses,
    changeRequests: body.changeRequests,
    acceptance: body.acceptance,
    rawAnalysis: body.rawAnalysis,
    roundIndex: body.roundIndex,
    status: body.status,
  });
  return Response.json({ plan: { id: created.id } });
}
