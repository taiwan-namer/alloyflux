import { cloudDbProxy } from "@/lib/cloud-api";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import {
  attachRunToSession,
  createStrategyRun,
  getStrategySession,
  listRunsForSession,
  updateStrategySession,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";

/**
 * 把既有 run 掛到會議室，或直接上傳一份新 run 並掛上。
 * Body: { runId } 或 { profileId, summary, reviewExcerpt, metrics, ... }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: sessionId } = await ctx.params;
  const session = await getStrategySession(auth.user.id, sessionId);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    profileId?: string;
    strategyVersion?: string;
    gitCommit?: string;
    summary?: Record<string, unknown>;
    reviewExcerpt?: string;
    metrics?: Record<string, unknown>;
  };

  let runId = body.runId?.trim() || "";
  if (runId) {
    const ok = await attachRunToSession(auth.user.id, sessionId, runId);
    if (!ok) return Response.json({ error: "run not found" }, { status: 404 });
  } else {
    const created = await createStrategyRun({
      userId: auth.user.id,
      profileId: body.profileId || session.profileId,
      strategyVersion: body.strategyVersion || session.strategyVersion,
      gitCommit: body.gitCommit,
      summary: body.summary,
      reviewExcerpt: body.reviewExcerpt,
      metrics: body.metrics,
      sessionId,
    });
    runId = created.id;
  }

  if (session.status === "collecting") {
    await updateStrategySession(auth.user.id, sessionId, { status: "reviewing" });
  }

  const runs = await listRunsForSession(auth.user.id, sessionId, 10);
  const updated = await getStrategySession(auth.user.id, sessionId);
  return Response.json({ runId, session: updated, runs });
}
