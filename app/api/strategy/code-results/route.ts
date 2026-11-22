import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import { createCodeResult, getStrategyPlan } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    planId?: string;
    summary?: string;
    filesChanged?: string[];
    checksOk?: boolean;
    notes?: string;
  };
  if (!body.planId) {
    return Response.json({ error: "planId required" }, { status: 400 });
  }
  const plan = await getStrategyPlan(auth.user.id, body.planId);
  if (!plan) return Response.json({ error: "Plan not found" }, { status: 404 });

  const created = await createCodeResult({
    userId: auth.user.id,
    planId: body.planId,
    summary: body.summary,
    filesChanged: body.filesChanged,
    checksOk: body.checksOk,
    notes: body.notes,
  });
  const updated = await getStrategyPlan(auth.user.id, body.planId);
  return Response.json({ result: { id: created.id }, plan: updated });
}
