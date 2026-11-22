import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import { createRetro, listRetros, listStrategyPlans, listStrategyRuns } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "10");
  return Response.json({ retros: await listRetros(auth.user.id, limit) });
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    windowHours?: number;
    summary?: Record<string, unknown>;
    nextHypotheses?: unknown[];
    auto?: boolean;
  };

  let summary = body.summary;
  let nextHypotheses = body.nextHypotheses;
  if (body.auto || !summary) {
    const runs = await listStrategyRuns(auth.user.id, 50);
    const plans = await listStrategyPlans(auth.user.id, { limit: 50 });
    const windowMs = (body.windowHours ?? 12) * 3600_000;
    const since = Date.now() - windowMs;
    const recentRuns = runs.filter((r) => r.createdAt >= since);
    const recentPlans = plans.filter((p) => p.createdAt >= since);
    const byStatus: Record<string, number> = {};
    for (const p of recentPlans) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    }
    summary = {
      windowHours: body.windowHours ?? 12,
      runs: recentRuns.length,
      plans: recentPlans.length,
      planStatus: byStatus,
      latestRunIds: recentRuns.slice(0, 5).map((r) => r.id),
      ...(body.summary || {}),
    };
    if (!nextHypotheses) {
      nextHypotheses = recentPlans
        .filter((p) => p.status === "accepted" || p.status === "rejected")
        .flatMap((p) => (Array.isArray(p.hypotheses) ? p.hypotheses : []))
        .slice(0, 5);
    }
  }

  const created = await createRetro({
    userId: auth.user.id,
    windowHours: body.windowHours ?? 12,
    summary,
    nextHypotheses,
  });
  return Response.json({ retro: { id: created.id, summary, nextHypotheses } });
}
