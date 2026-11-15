import { createHash } from "node:crypto";
import { db, newId } from "./db";
import {
  activeJobCount,
  bumpJobsToday,
  credentialHashOf,
  getNode,
  listOnlineNodesForModel,
  signJobPayload,
  type SupplierNode,
} from "./node-registry";
import { settleJobIdempotent } from "./supplier-settlement";

export const MAX_MESSAGES_BYTES = 200_000;
export const JOB_TIMEOUT_MS = 120_000;
export const POLL_WAIT_MS = 25_000;
export const MAX_FAILOVER_ATTEMPTS = 3;

export type JobStatus =
  | "queued"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  images?: Array<{ mimeType: string; data: string }>;
};

export type JobStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "usage";
      usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; upstreamModelId?: string };
    };

export interface InferenceJob {
  id: string;
  userId: string;
  modelId: string;
  providerKey: string;
  upstreamModel: string;
  messages: ChatMessage[];
  /** 原生 system 通道附加脈絡（不進 messages） */
  extraSystemContext?: string;
  /** 外部 API 客戶端 system／developer（優先於平台網頁版 prompt） */
  customSystemPrompt?: string;
  status: JobStatus;
  assignedNodeId: string | null;
  resultText: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  platformCostPoints: number | null;
  chargedPoints: number | null;
  supplierRewardPoints: number | null;
  settlementStatus: "pending" | "settled" | "skipped";
  errorMessage: string | null;
  attemptCount: number;
  createdAt: number;
  timeoutAt: number;
  payloadSha256: string;
  signature: string | null;
}

type LiveJob = {
  events: JobStreamEvent[];
  ended: boolean;
  failed?: { status: number; message: string };
  waiters: Array<() => void>;
};

const globalForJobs = globalThis as unknown as {
  __inferenceLive?: Map<string, LiveJob>;
  __nodeAssignQueues?: Map<string, string[]>;
};

const live = (globalForJobs.__inferenceLive ??= new Map());
const queues = (globalForJobs.__nodeAssignQueues ??= new Map());

function payloadCanonical(
  messages: ChatMessage[],
  modelId: string,
  upstreamModel: string,
  extraSystemContext?: string,
  customSystemPrompt?: string,
): string {
  return JSON.stringify({
    modelId,
    upstreamModel,
    messages,
    extraSystemContext: extraSystemContext?.trim() || undefined,
    customSystemPrompt: customSystemPrompt?.trim() || undefined,
  });
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** messages_json：舊格式為陣列；新格式為 { messages, extraSystemContext?, customSystemPrompt? } */
function parseJobMessagesJson(raw: string): {
  messages: ChatMessage[];
  extraSystemContext?: string;
  customSystemPrompt?: string;
} {
  const parsed = JSON.parse(raw) as
    | ChatMessage[]
    | { messages?: ChatMessage[]; extraSystemContext?: string; customSystemPrompt?: string };
  if (Array.isArray(parsed)) return { messages: parsed };
  return {
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    extraSystemContext: parsed.extraSystemContext?.trim() || undefined,
    customSystemPrompt: parsed.customSystemPrompt?.trim() || undefined,
  };
}

function serializeJobMessagesJson(
  messages: ChatMessage[],
  extraSystemContext?: string,
  customSystemPrompt?: string,
): string {
  const ctx = extraSystemContext?.trim();
  const custom = customSystemPrompt?.trim();
  if (ctx || custom) {
    return JSON.stringify({
      messages,
      extraSystemContext: ctx || undefined,
      customSystemPrompt: custom || undefined,
    });
  }
  return JSON.stringify(messages);
}

function rowToJob(r: Record<string, unknown>): InferenceJob {
  const parsed = parseJobMessagesJson(r.messages_json as string);
  return {
    id: r.id as string,
    userId: r.user_id as string,
    modelId: r.model_id as string,
    providerKey: r.provider_key as string,
    upstreamModel: r.upstream_model as string,
    messages: parsed.messages,
    extraSystemContext: parsed.extraSystemContext,
    customSystemPrompt: parsed.customSystemPrompt,
    status: r.status as JobStatus,
    assignedNodeId: (r.assigned_node_id as string) ?? null,
    resultText: (r.result_text as string) ?? "",
    inputTokens: (r.input_tokens as number) ?? null,
    cachedInputTokens: (r.cached_input_tokens as number) ?? null,
    outputTokens: (r.output_tokens as number) ?? null,
    platformCostPoints: (r.platform_cost_points as number) ?? null,
    chargedPoints: (r.charged_points as number) ?? null,
    supplierRewardPoints: (r.supplier_reward_points as number) ?? null,
    settlementStatus: r.settlement_status as InferenceJob["settlementStatus"],
    errorMessage: (r.error_message as string) ?? null,
    attemptCount: r.attempt_count as number,
    createdAt: r.created_at as number,
    timeoutAt: r.timeout_at as number,
    payloadSha256: r.payload_sha256 as string,
    signature: (r.signature as string) ?? null,
  };
}

export function getJob(id: string): InferenceJob | null {
  const row = db().prepare("SELECT * FROM inference_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

function enqueueForNode(nodeId: string, jobId: string): void {
  const q = queues.get(nodeId) ?? [];
  q.push(jobId);
  queues.set(nodeId, q);
}

function pickNode(providerKey: string, upstreamModel: string): SupplierNode | null {
  const nodes = listOnlineNodesForModel(providerKey, upstreamModel);
  if (!nodes.length) return null;
  // 負載最低優先
  return nodes.sort((a, b) => activeJobCount(a.id) - activeJobCount(b.id))[0];
}

function assignJobToNode(jobId: string, node: SupplierNode, payload: string): void {
  const credHash = db()
    .prepare("SELECT credential_hash FROM supplier_nodes WHERE id = ?")
    .get(node.id) as { credential_hash: string };
  const signature = signJobPayload(credHash.credential_hash, payload);
  const now = Date.now();
  db()
    .prepare(
      `UPDATE inference_jobs SET status = 'assigned', assigned_node_id = ?, assigned_at = ?,
       attempt_count = attempt_count + 1, signature = ?, timeout_at = ? WHERE id = ?`,
    )
    .run(node.id, now, signature, now + JOB_TIMEOUT_MS, jobId);
  db()
    .prepare(
      `INSERT INTO job_attempts (id, job_id, node_id, status, started_at) VALUES (?, ?, ?, 'assigned', ?)`,
    )
    .run(newId(), jobId, node.id, now);
  bumpJobsToday(node.id);
  enqueueForNode(node.id, jobId);
  if (!live.has(jobId)) {
    live.set(jobId, { events: [], ended: false, waiters: [] });
  }
}

export function enqueueInferenceJob(input: {
  userId: string;
  modelId: string;
  providerKey: string;
  upstreamModel: string;
  messages: ChatMessage[];
  extraSystemContext?: string;
  customSystemPrompt?: string;
}): InferenceJob {
  const ctx = input.extraSystemContext?.trim() || undefined;
  const custom = input.customSystemPrompt?.trim() || undefined;
  const payload = payloadCanonical(input.messages, input.modelId, input.upstreamModel, ctx, custom);
  if (Buffer.byteLength(payload, "utf8") > MAX_MESSAGES_BYTES) {
    throw Object.assign(new Error("訊息過大"), { status: 413 });
  }
  const id = newId();
  const now = Date.now();
  const hash = sha256(payload);
  db()
    .prepare(
      `INSERT INTO inference_jobs (
        id, user_id, model_id, provider_key, upstream_model, messages_json, status,
        settlement_status, settlement_key, attempt_count, created_at, timeout_at, payload_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'pending', ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.modelId,
      input.providerKey,
      input.upstreamModel,
      serializeJobMessagesJson(input.messages, ctx, custom),
      `settle:${id}`,
      now,
      now + JOB_TIMEOUT_MS,
      hash,
    );

  live.set(id, { events: [], ended: false, waiters: [] });

  const node = pickNode(input.providerKey, input.upstreamModel);
  if (node) assignJobToNode(id, node, payload);
  return getJob(id)!;
}

export function cancelJob(jobId: string, reason = "cancelled"): boolean {
  const job = getJob(jobId);
  if (!job || ["completed", "failed", "cancelled", "timeout"].includes(job.status)) return false;
  db()
    .prepare(
      `UPDATE inference_jobs SET status = 'cancelled', error_message = ?, completed_at = ?, settlement_status = 'skipped' WHERE id = ?`,
    )
    .run(reason, Date.now(), jobId);
  failLive(jobId, 499, reason);
  return true;
}

function failLive(jobId: string, status: number, message: string): void {
  const l = live.get(jobId);
  if (!l || l.ended) return;
  l.ended = true;
  l.failed = { status, message };
  for (const w of l.waiters.splice(0)) w();
}

function wake(jobId: string): void {
  const l = live.get(jobId);
  if (!l) return;
  for (const w of l.waiters.splice(0)) w();
}

/** 逾時／斷線：標記失敗或重新入隊 */
export function sweepStaleJobs(): void {
  const now = Date.now();
  const stale = db()
    .prepare(
      `SELECT * FROM inference_jobs WHERE status IN ('queued', 'assigned', 'running') AND timeout_at < ?`,
    )
    .all(now) as Record<string, unknown>[];

  for (const row of stale) {
    const job = rowToJob(row);
    if (job.attemptCount < MAX_FAILOVER_ATTEMPTS && job.status !== "queued") {
      // 重新排隊給其他節點
      db()
        .prepare(
          `UPDATE inference_jobs SET status = 'queued', assigned_node_id = NULL, signature = NULL,
           error_message = ?, timeout_at = ? WHERE id = ?`,
        )
        .run(`attempt timeout → failover`, now + JOB_TIMEOUT_MS, job.id);
      db()
        .prepare(
          `UPDATE job_attempts SET status = 'timeout', error_message = 'timeout', finished_at = ? WHERE job_id = ? AND finished_at IS NULL`,
        )
        .run(now, job.id);
      const node = pickNode(job.providerKey, job.upstreamModel);
      if (node) {
        const payload = payloadCanonical(
          job.messages,
          job.modelId,
          job.upstreamModel,
          job.extraSystemContext,
          job.customSystemPrompt,
        );
        assignJobToNode(job.id, node, payload);
      } else {
        db()
          .prepare(
            `UPDATE inference_jobs SET status = 'timeout', completed_at = ?, error_message = ?, settlement_status = 'skipped' WHERE id = ?`,
          )
          .run(now, "無可用節點可 failover", job.id);
        failLive(job.id, 504, "任務逾時且無可用節點");
      }
    } else if (job.status === "queued") {
      const node = pickNode(job.providerKey, job.upstreamModel);
      if (node) {
        const payload = payloadCanonical(
          job.messages,
          job.modelId,
          job.upstreamModel,
          job.extraSystemContext,
          job.customSystemPrompt,
        );
        assignJobToNode(job.id, node, payload);
      } else {
        db()
          .prepare(
            `UPDATE inference_jobs SET status = 'timeout', completed_at = ?, error_message = ?, settlement_status = 'skipped' WHERE id = ?`,
          )
          .run(now, "排隊逾時", job.id);
        failLive(job.id, 504, "排隊逾時");
      }
    } else {
      db()
        .prepare(
          `UPDATE inference_jobs SET status = 'timeout', completed_at = ?, error_message = ?, settlement_status = 'skipped' WHERE id = ?`,
        )
        .run(now, "任務逾時", job.id);
      failLive(job.id, 504, "任務逾時");
    }
  }
}

export async function pollJobForNode(nodeId: string, waitMs = POLL_WAIT_MS): Promise<{
  job: InferenceJob;
  signature: string;
} | null> {
  sweepStaleJobs();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const q = queues.get(nodeId) ?? [];
    const jobId = q.shift();
    if (jobId) {
      queues.set(nodeId, q);
      const job = getJob(jobId);
      if (job && job.assignedNodeId === nodeId && (job.status === "assigned" || job.status === "running")) {
        return { job, signature: job.signature ?? "" };
      }
      continue;
    }
    // 也掃 DB 裡已 assigned 但佇列遺失的任務（進程重啟）
    const orphan = db()
      .prepare(
        `SELECT id FROM inference_jobs WHERE assigned_node_id = ? AND status = 'assigned' ORDER BY assigned_at LIMIT 1`,
      )
      .get(nodeId) as { id: string } | undefined;
    if (orphan) {
      const job = getJob(orphan.id)!;
      return { job, signature: job.signature ?? "" };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export function markJobRunning(jobId: string, nodeId: string): boolean {
  const job = getJob(jobId);
  if (!job || job.assignedNodeId !== nodeId) return false;
  if (job.status !== "assigned" && job.status !== "running") return false;
  db()
    .prepare(`UPDATE inference_jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`)
    .run(Date.now(), jobId);
  return true;
}

export function pushJobEvent(jobId: string, nodeId: string, event: JobStreamEvent): boolean {
  const job = getJob(jobId);
  if (!job || job.assignedNodeId !== nodeId) return false;
  if (["completed", "failed", "cancelled", "timeout"].includes(job.status)) return false;
  markJobRunning(jobId, nodeId);
  const l = live.get(jobId) ?? { events: [], ended: false, waiters: [] };
  live.set(jobId, l);
  l.events.push(event);
  if (event.type === "text") {
    db()
      .prepare(`UPDATE inference_jobs SET result_text = COALESCE(result_text, '') || ? WHERE id = ?`)
      .run(event.text, jobId);
  }
  wake(jobId);
  return true;
}

export function completeJob(
  jobId: string,
  nodeId: string,
  result: {
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    platformCostPoints: number;
    chargedPoints: number;
    supplierRewardPoints: number;
  },
): boolean {
  const job = getJob(jobId);
  if (!job || job.assignedNodeId !== nodeId) return false;
  if (["completed", "failed", "cancelled", "timeout"].includes(job.status)) return true; // 冪等

  const now = Date.now();
  db()
    .prepare(
      `UPDATE inference_jobs SET status = 'completed', completed_at = ?,
       input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
       platform_cost_points = ?, charged_points = ?, supplier_reward_points = ?
       WHERE id = ? AND status NOT IN ('completed','failed','cancelled','timeout')`,
    )
    .run(
      now,
      result.usage.inputTokens,
      result.usage.cachedInputTokens,
      result.usage.outputTokens,
      result.platformCostPoints,
      result.chargedPoints,
      result.supplierRewardPoints,
      jobId,
    );
  db()
    .prepare(
      `UPDATE job_attempts SET status = 'completed', finished_at = ? WHERE job_id = ? AND node_id = ? AND finished_at IS NULL`,
    )
    .run(now, jobId, nodeId);

  settleJobIdempotent(jobId);

  const l = live.get(jobId) ?? { events: [], ended: false, waiters: [] };
  live.set(jobId, l);
  l.ended = true;
  wake(jobId);
  return true;
}

export function failJob(jobId: string, nodeId: string, message: string, status = 500): boolean {
  const job = getJob(jobId);
  if (!job || job.assignedNodeId !== nodeId) return false;
  if (["completed", "failed", "cancelled", "timeout"].includes(job.status)) return true;

  const now = Date.now();
  db()
    .prepare(
      `UPDATE job_attempts SET status = 'failed', error_message = ?, finished_at = ? WHERE job_id = ? AND node_id = ? AND finished_at IS NULL`,
    )
    .run(message, now, jobId, nodeId);

  if (job.attemptCount < MAX_FAILOVER_ATTEMPTS) {
    db()
      .prepare(
        `UPDATE inference_jobs SET status = 'queued', assigned_node_id = NULL, signature = NULL,
         error_message = ?, timeout_at = ? WHERE id = ?`,
      )
      .run(message, now + JOB_TIMEOUT_MS, jobId);
    const node = pickNode(job.providerKey, job.upstreamModel);
    if (node && node.id !== nodeId) {
      const payload = payloadCanonical(
        job.messages,
        job.modelId,
        job.upstreamModel,
        job.extraSystemContext,
        job.customSystemPrompt,
      );
      assignJobToNode(jobId, node, payload);
      return true;
    }
  }

  db()
    .prepare(
      `UPDATE inference_jobs SET status = 'failed', completed_at = ?, error_message = ?, settlement_status = 'skipped' WHERE id = ?`,
    )
    .run(now, message, jobId);
  failLive(jobId, status, message);
  return true;
}

/** 買家端串流等待節點結果 */
export async function* streamJobResult(
  jobId: string,
  signal?: AbortSignal,
): AsyncGenerator<JobStreamEvent> {
  const onAbort = () => cancelJob(jobId, "client aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  let idx = 0;
  try {
    while (true) {
      sweepStaleJobs();
      const l = live.get(jobId);
      const job = getJob(jobId);
      if (!job) throw Object.assign(new Error("job not found"), { status: 404 });

      if (l) {
        while (idx < l.events.length) yield l.events[idx++];
        if (l.ended) {
          if (l.failed) throw Object.assign(new Error(l.failed.message), { status: l.failed.status });
          break;
        }
      }

      if (["failed", "cancelled", "timeout"].includes(job.status)) {
        throw Object.assign(new Error(job.errorMessage || job.status), { status: 502 });
      }
      if (job.status === "completed") break;

      await new Promise<void>((r) => {
        const timer = setTimeout(r, 2000);
        const liveJob = live.get(jobId);
        if (liveJob) {
          liveJob.waiters.push(() => {
            clearTimeout(timer);
            r();
          });
        }
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // 延遲清理 live buffer
    setTimeout(() => live.delete(jobId), 60_000);
  }
}

export function jobPublicForNode(job: InferenceJob) {
  return {
    id: job.id,
    modelId: job.modelId,
    providerKey: job.providerKey,
    upstreamModel: job.upstreamModel,
    messages: job.messages,
    extraSystemContext: job.extraSystemContext,
    customSystemPrompt: job.customSystemPrompt,
    payloadSha256: job.payloadSha256,
    timeoutAt: job.timeoutAt,
  };
}

/** 測試用：驗證 credential 簽章（節點端） */
export { credentialHashOf, signJobPayload };
