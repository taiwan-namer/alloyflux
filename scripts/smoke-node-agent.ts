/**
 * 離線冪等／註冊煙測（不需 Next dev）
 * npx tsx scripts/smoke-node-agent.ts
 */
import { registerNode, authenticateNode, touchHeartbeat, listOnlineNodesForModel } from "../lib/node-registry";
import { enqueueInferenceJob, completeJob, getJob, pushJobEvent } from "../lib/inference-jobs";
import { settleJobIdempotent, chargeBuyerForJobIdempotent } from "../lib/supplier-settlement";
import { newId } from "../lib/db";

async function main() {
  const { node, credential } = await registerNode({
    label: "smoke-node",
    capabilities: [{ authSourceType: "mock", providerKey: "mock", modelId: "node-mock" }],
  });
  console.log("registered", node.id, credential.slice(0, 10) + "…");

  const authed = await authenticateNode(credential);
  if (!authed) throw new Error("auth failed");
  await touchHeartbeat(node.id, { acceptingJobs: true, activeJobs: 0 });

  if (!(await listOnlineNodesForModel("mock", "node-mock")).length) throw new Error("not online");

  const job = await enqueueInferenceJob({
    userId: "local-user",
    modelId: "node-mock",
    providerKey: "mock",
    upstreamModel: "node-mock",
    messages: [{ role: "user", content: "hello smoke" }],
  });
  console.log("job", job.id, job.status, job.assignedNodeId);

  await pushJobEvent(job.id, node.id, { type: "text", text: "ok" });
  await completeJob(job.id, node.id, {
    usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 },
    platformCostPoints: 0.01,
    chargedPoints: 0.011,
    supplierRewardPoints: 0.0088,
  });

  const a = await settleJobIdempotent(job.id);
  const b = await settleJobIdempotent(job.id);
  console.log("settle", a, b);
  if (!a.settled || !b.already) throw new Error("idempotent settle failed");

  const msgId = newId();
  await chargeBuyerForJobIdempotent({
    userId: "local-user",
    jobId: job.id,
    chargedPoints: 0.011,
    messageId: msgId,
  });
  await chargeBuyerForJobIdempotent({
    userId: "local-user",
    jobId: job.id,
    chargedPoints: 0.011,
    messageId: newId(),
  });

  const done = await getJob(job.id);
  console.log("final", done?.status, done?.settlementStatus);
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
