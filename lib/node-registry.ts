import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db, newId } from "./db";

export const NODE_ONLINE_MS = 45_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export type AuthSourceType = "official_api" | "local_model" | "allowed_third_party" | "mock";
export type NodeStatus = "active" | "paused" | "revoked";

export interface NodeCapability {
  id: string;
  nodeId: string;
  authSourceType: AuthSourceType;
  providerKey: string;
  modelId: string;
  enabled: boolean;
}

export interface SupplierNode {
  id: string;
  accountId: string;
  accountName: string;
  label: string;
  credentialHint: string;
  status: NodeStatus;
  acceptingJobs: boolean;
  maxConcurrency: number;
  dailyJobLimit: number;
  jobsToday: number;
  lastSeenAt: number | null;
  online: boolean;
  createdAt: number;
  capabilities: NodeCapability[];
}

function hashCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDailyCounter(nodeId: string): Promise<void> {
  const row = (await db()
    .prepare("SELECT jobs_today_date FROM supplier_nodes WHERE id = ?")
    .get(nodeId)) as { jobs_today_date: string | null } | undefined;
  if (!row) return;
  const today = todayKey();
  if (row.jobs_today_date !== today) {
    await db()
      .prepare("UPDATE supplier_nodes SET jobs_today = 0, jobs_today_date = ? WHERE id = ?")
      .run(today, nodeId);
  }
}

async function loadCapabilities(nodeId: string): Promise<NodeCapability[]> {
  const rows = (await db()
    .prepare(
      `SELECT id, node_id, auth_source_type, provider_key, model_id, enabled
       FROM node_capabilities WHERE node_id = ?`,
    )
    .all(nodeId)) as {
    id: string;
    node_id: string;
    auth_source_type: AuthSourceType;
    provider_key: string;
    model_id: string;
    enabled: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    nodeId: r.node_id,
    authSourceType: r.auth_source_type,
    providerKey: r.provider_key,
    modelId: r.model_id,
    enabled: r.enabled === 1,
  }));
}

async function mapNode(row: {
  id: string;
  account_id: string;
  display_name: string;
  label: string;
  credential_hint: string;
  status: NodeStatus;
  accepting_jobs: number;
  max_concurrency: number;
  daily_job_limit: number;
  jobs_today: number;
  last_seen_at: number | null;
  created_at: number;
}): Promise<SupplierNode> {
  // BIGINT 欄位若被驅動回傳為字串，先轉 number，避免 online 判斷（typeof number）失效
  const lastSeenAt = row.last_seen_at == null ? null : Number(row.last_seen_at);
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.display_name,
    label: row.label,
    credentialHint: row.credential_hint,
    status: row.status,
    acceptingJobs: row.accepting_jobs === 1,
    maxConcurrency: row.max_concurrency,
    dailyJobLimit: row.daily_job_limit,
    jobsToday: row.jobs_today,
    lastSeenAt,
    online: typeof lastSeenAt === "number" && Date.now() - lastSeenAt < NODE_ONLINE_MS,
    createdAt: Number(row.created_at),
    capabilities: await loadCapabilities(row.id),
  };
}

const NODE_SELECT = `
  SELECT n.*, a.display_name
  FROM supplier_nodes n
  JOIN supplier_accounts a ON a.id = n.account_id
`;

export async function listNodes(): Promise<SupplierNode[]> {
  const rows = (await db().prepare(`${NODE_SELECT} ORDER BY n.created_at DESC`).all()) as Parameters<
    typeof mapNode
  >[0][];
  return Promise.all(rows.map((r) => mapNode(r)));
}

export async function getNode(id: string): Promise<SupplierNode | null> {
  const row = (await db().prepare(`${NODE_SELECT} WHERE n.id = ?`).get(id)) as
    | Parameters<typeof mapNode>[0]
    | undefined;
  return row ? mapNode(row) : null;
}

export async function authenticateNode(credential: string): Promise<SupplierNode | null> {
  if (!credential?.startsWith("na_")) return null;
  const row = (await db()
    .prepare(`${NODE_SELECT} WHERE n.credential_hash = ? AND n.status != 'revoked'`)
    .get(hashCredential(credential))) as Parameters<typeof mapNode>[0] | undefined;
  return row ? mapNode(row) : null;
}

export async function getOrCreateLocalSupplierAccount(displayName = "本機供給者"): Promise<string> {
  const existing = (await db().prepare("SELECT id FROM supplier_accounts ORDER BY created_at LIMIT 1").get()) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = newId();
  await db()
    .prepare("INSERT INTO supplier_accounts (id, display_name, created_at) VALUES (?, ?, ?)")
    .run(id, displayName, Date.now());
  return id;
}

export type RegisterCapabilityInput = {
  authSourceType: AuthSourceType;
  providerKey: string;
  modelId: string;
};

/** 註冊節點；credential 只回傳一次 */
export async function registerNode(input: {
  label?: string;
  accountName?: string;
  maxConcurrency?: number;
  dailyJobLimit?: number;
  capabilities: RegisterCapabilityInput[];
}): Promise<{ node: SupplierNode; credential: string }> {
  if (!input.capabilities?.length) {
    throw Object.assign(new Error("至少需要一項能力（capability）"), { status: 400 });
  }
  for (const c of input.capabilities) {
    if (c.authSourceType === "mock") continue;
    if (!["official_api", "local_model", "allowed_third_party", "mock"].includes(c.authSourceType)) {
      throw Object.assign(new Error(`不支援的授權來源：${c.authSourceType}`), { status: 400 });
    }
    // 禁止把個人訂閱 OAuth 標成節點能力
    if (/oauth|antigravity|codex|subscription/i.test(`${c.providerKey}:${c.modelId}`)) {
      throw Object.assign(new Error("個人訂閱 OAuth 不得註冊為節點能力"), { status: 400 });
    }
  }

  const accountId = await getOrCreateLocalSupplierAccount(input.accountName ?? "本機供給者");
  const id = newId();
  const credential = `na_${randomBytes(24).toString("base64url")}`;
  const now = Date.now();
  const label = input.label?.trim() || `Node ${id.slice(0, 8)}`;

  await db().transaction(async (d) => {
    await d
      .prepare(
        `INSERT INTO supplier_nodes (
        id, account_id, label, credential_hash, credential_hint, status, accepting_jobs,
        max_concurrency, daily_job_limit, jobs_today, jobs_today_date, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, 0, ?, NULL, ?)`,
      )
      .run(
        id,
        accountId,
        label,
        hashCredential(credential),
        `…${credential.slice(-6)}`,
        input.maxConcurrency ?? 2,
        input.dailyJobLimit ?? 500,
        todayKey(),
        now,
      );
    const ins = d.prepare(
      `INSERT INTO node_capabilities (id, node_id, auth_source_type, provider_key, model_id, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    for (const c of input.capabilities) {
      await ins.run(newId(), id, c.authSourceType, c.providerKey, c.modelId);
    }
  });

  return { node: (await getNode(id))!, credential };
}

export async function revokeNode(nodeId: string): Promise<void> {
  await db()
    .prepare("UPDATE supplier_nodes SET status = 'revoked', accepting_jobs = 0, revoked_at = ? WHERE id = ?")
    .run(Date.now(), nodeId);
}

export async function setNodeAccepting(nodeId: string, accepting: boolean): Promise<void> {
  await db()
    .prepare("UPDATE supplier_nodes SET accepting_jobs = ?, status = CASE WHEN status = 'revoked' THEN status ELSE ? END WHERE id = ?")
    .run(accepting ? 1 : 0, accepting ? "active" : "paused", nodeId);
}

export async function touchHeartbeat(
  nodeId: string,
  meta: { activeJobs?: number; acceptingJobs?: boolean; meta?: Record<string, unknown> },
): Promise<void> {
  await ensureDailyCounter(nodeId);
  const now = Date.now();
  const accepting = meta.acceptingJobs === false ? 0 : 1;
  await db()
    .prepare(
      `UPDATE supplier_nodes SET last_seen_at = ?, accepting_jobs = CASE WHEN status = 'revoked' THEN 0 ELSE ? END,
       status = CASE WHEN status = 'revoked' THEN 'revoked' WHEN ? = 0 THEN 'paused' ELSE 'active' END
       WHERE id = ?`,
    )
    .run(now, accepting, accepting, nodeId);
  await db()
    .prepare(
      `INSERT INTO node_heartbeats (id, node_id, at, active_jobs, accepting_jobs, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      nodeId,
      now,
      meta.activeJobs ?? 0,
      accepting,
      meta.meta ? JSON.stringify(meta.meta).slice(0, 2000) : null,
    );
  // 只保留最近 200 筆心跳
  await db()
    .prepare(
      `DELETE FROM node_heartbeats WHERE node_id = ? AND id NOT IN (
         SELECT id FROM node_heartbeats WHERE node_id = ? ORDER BY at DESC LIMIT 200
       )`,
    )
    .run(nodeId, nodeId);
}

export async function bumpJobsToday(nodeId: string): Promise<void> {
  await ensureDailyCounter(nodeId);
  await db().prepare("UPDATE supplier_nodes SET jobs_today = jobs_today + 1 WHERE id = ?").run(nodeId);
}

export async function activeJobCount(nodeId: string): Promise<number> {
  const row = (await db()
    .prepare(
      `SELECT COUNT(*) AS c FROM inference_jobs
       WHERE assigned_node_id = ? AND status IN ('assigned', 'running')`,
    )
    .get(nodeId)) as { c: number | string };
  // COUNT(*) 在 Postgres 為 bigint，統一轉 number
  return Number(row.c);
}

export async function listOnlineNodesForModel(providerKey: string, modelId: string): Promise<SupplierNode[]> {
  const out: SupplierNode[] = [];
  for (const n of await listNodes()) {
    if (!n.online || n.status !== "active" || !n.acceptingJobs) continue;
    await ensureDailyCounter(n.id);
    const fresh = (await getNode(n.id))!;
    if (fresh.jobsToday >= fresh.dailyJobLimit) continue;
    if ((await activeJobCount(n.id)) >= fresh.maxConcurrency) continue;
    if (
      fresh.capabilities.some(
        (c) => c.enabled && c.providerKey === providerKey && (c.modelId === modelId || c.modelId === "*"),
      )
    ) {
      out.push(n);
    }
  }
  return out;
}

/** 任務簽章：HMAC-SHA256(credentialHash, payload) — 平台用 hash 簽；節點用 credential 驗證時改用同一約定 */
export function signJobPayload(credentialOrHash: string, payload: string): string {
  return createHmac("sha256", credentialOrHash).update(payload).digest("hex");
}

export function verifyJobSignature(credential: string, payload: string, signature: string): boolean {
  const expected = signJobPayload(hashCredential(credential), payload);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function credentialHashOf(credential: string): string {
  return hashCredential(credential);
}
