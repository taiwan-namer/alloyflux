import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import {
  getStrategyPlan,
  updateStrategyPlanStatus,
  type StrategyPlanStatus,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

const ALLOWED: StrategyPlanStatus[] = [
  "pending_code",
  "coding",
  "needs_review",
  "accepted",
  "rejected",
  "blocked",
];

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const plan = await getStrategyPlan(auth.user.id, id);
  if (!plan) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ plan });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { status?: StrategyPlanStatus };
  if (!body.status || !ALLOWED.includes(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }
  const ok = await updateStrategyPlanStatus(auth.user.id, id, body.status);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  const plan = await getStrategyPlan(auth.user.id, id);
  return Response.json({ plan });
}
