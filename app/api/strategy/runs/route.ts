import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import { createStrategyRun, listStrategyRuns } from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "20");
  const runs = await listStrategyRuns(auth.user.id, limit);
  return Response.json({ runs });
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    profileId?: string;
    strategyVersion?: string;
    gitCommit?: string;
    summary?: Record<string, unknown>;
    reviewExcerpt?: string;
    metrics?: Record<string, unknown>;
    sessionId?: string;
  };

  const run = await createStrategyRun({
    userId: auth.user.id,
    profileId: body.profileId,
    strategyVersion: body.strategyVersion,
    gitCommit: body.gitCommit,
    summary: body.summary,
    reviewExcerpt: body.reviewExcerpt,
    metrics: body.metrics,
    sessionId: body.sessionId,
  });
  return Response.json({ run });
}
