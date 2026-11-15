import { authenticateNode, touchHeartbeat } from "@/lib/node-registry";
import {
  completeJob,
  failJob,
  getJob,
  markJobRunning,
  pushJobEvent,
  type JobStreamEvent,
} from "@/lib/inference-jobs";
import { chargePointsFromUsd, findModel } from "@/lib/models";
import { supplierRewardShare } from "@/lib/supplier-settlement";

export const dynamic = "force-dynamic";

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

/**
 * 節點回報：event（串流）／complete／fail
 * 平台依 usage 計算點數並冪等結算。
 */
export async function POST(req: Request) {
  const node = await authenticateNode(bearer(req));
  if (!node) return Response.json({ error: "節點憑證無效" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: "event" | "complete" | "fail" | "running";
    jobId?: string;
    event?: JobStreamEvent;
    usage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
    platformCostUsd?: number;
    error?: string;
    status?: number;
  };

  if (!body.jobId) return Response.json({ error: "缺少 jobId" }, { status: 400 });
  await touchHeartbeat(node.id, {});

  if (body.action === "running") {
    return Response.json({ ok: await markJobRunning(body.jobId, node.id) });
  }

  if (body.action === "event") {
    if (!body.event) return Response.json({ error: "缺少 event" }, { status: 400 });
    // 拒絕任意 URL／shell 類 payload
    if (body.event.type === "text" && body.event.text.length > 100_000) {
      return Response.json({ error: "text 過大" }, { status: 413 });
    }
    return Response.json({ ok: await pushJobEvent(body.jobId, node.id, body.event) });
  }

  if (body.action === "fail") {
    return Response.json({
      ok: await failJob(body.jobId, node.id, body.error || "node failed", body.status ?? 500),
    });
  }

  if (body.action === "complete") {
    const usage = {
      inputTokens: body.usage?.inputTokens ?? 0,
      cachedInputTokens: body.usage?.cachedInputTokens ?? 0,
      outputTokens: body.usage?.outputTokens ?? 0,
    };
    const costUsd =
      typeof body.platformCostUsd === "number"
        ? body.platformCostUsd
        : (usage.inputTokens * 0.1 + usage.outputTokens * 0.4) / 1_000_000;
    const job = await getJob(body.jobId);
    const jobModel = job ? findModel(job.modelId) : undefined;
    const bill = chargePointsFromUsd(costUsd, jobModel?.tier, jobModel?.effort);
    const supplierRewardPoints =
      Math.round(bill.chargedPoints * supplierRewardShare() * 10000) / 10000;
    return Response.json({
      ok: await completeJob(body.jobId, node.id, {
        usage,
        platformCostPoints: bill.officialCostPoints,
        chargedPoints: bill.chargedPoints,
        supplierRewardPoints,
      }),
    });
  }

  return Response.json({ error: "未知 action" }, { status: 400 });
}
