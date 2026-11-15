import { db, newId } from "./db";
import { getNode } from "./node-registry";

/**
 * 冪等結算供給者收益（不在此扣買家點數，避免與 settleAssistantMessage 重複）。
 * UNIQUE(job_id) on supplier_earnings 保證同一 Job 只發一次報酬。
 */
export function settleJobIdempotent(jobId: string): { settled: boolean; already: boolean } {
  const job = db().prepare("SELECT * FROM inference_jobs WHERE id = ?").get(jobId) as
    | {
        id: string;
        status: string;
        settlement_status: string;
        settlement_key: string;
        supplier_reward_points: number | null;
        assigned_node_id: string | null;
      }
    | undefined;

  if (!job || job.status !== "completed") return { settled: false, already: false };
  if (job.settlement_status === "settled") return { settled: true, already: true };

  const node = job.assigned_node_id ? getNode(job.assigned_node_id) : null;
  const reward = job.supplier_reward_points ?? 0;
  const now = Date.now();

  const d = db();
  d.exec("BEGIN");
  try {
    const flipped = d
      .prepare(
        `UPDATE inference_jobs SET settlement_status = 'settled' WHERE id = ? AND settlement_status = 'pending'`,
      )
      .run(jobId);
    if (flipped.changes === 0) {
      d.exec("COMMIT");
      return { settled: true, already: true };
    }

    if (node && reward > 0) {
      d.prepare(
        `INSERT OR IGNORE INTO supplier_earnings (id, job_id, account_id, node_id, reward_points, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(newId(), jobId, node.accountId, node.id, reward, now);
      d.prepare(
        `INSERT OR IGNORE INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at)
         VALUES (?, ?, 'supplier_earn', ?, ?, ?, ?)`,
      ).run(newId(), node.accountId, reward, job.settlement_key, `job:${jobId}`, now);
    }

    d.exec("COMMIT");
    return { settled: true, already: false };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** 買家扣點冪等：以 job settlement_key 為 ref，同一 job 不重複扣 */
export function chargeBuyerForJobIdempotent(input: {
  userId: string;
  jobId: string;
  chargedPoints: number;
  messageId: string;
}): void {
  const job = db().prepare("SELECT settlement_key FROM inference_jobs WHERE id = ?").get(input.jobId) as
    | { settlement_key: string }
    | undefined;
  if (!job) return;
  const exists = db()
    .prepare(`SELECT 1 AS x FROM ledger WHERE type = 'usage' AND ref_id = ?`)
    .get(job.settlement_key) as { x: number } | undefined;
  if (exists) return;
  // INSERT OR IGNORE：避免交易內 UNIQUE 失敗污染整段 BEGIN
  db()
    .prepare(
      `INSERT OR IGNORE INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at)
       VALUES (?, ?, 'usage', ?, ?, ?, ?)`,
    )
    .run(newId(), input.userId, -input.chargedPoints, job.settlement_key, `msg:${input.messageId}`, Date.now());
}

export function listEarnings(accountId?: string) {
  if (accountId) {
    return db()
      .prepare(`SELECT * FROM supplier_earnings WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`)
      .all(accountId);
  }
  return db().prepare(`SELECT * FROM supplier_earnings ORDER BY created_at DESC LIMIT 200`).all();
}

export function supplierRewardShare(): number {
  return Number(process.env.SUPPLIER_REWARD_SHARE ?? 0.8);
}
