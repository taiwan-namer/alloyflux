import { db, newId, type Db } from "./db";
import { getNode } from "./node-registry";

/**
 * 冪等結算供給者收益（不在此扣買家點數，避免與 settleAssistantMessage 重複）。
 * UNIQUE(job_id) on supplier_earnings 保證同一 Job 只發一次報酬。
 */
export async function settleJobIdempotent(jobId: string): Promise<{ settled: boolean; already: boolean }> {
  const job = (await db().prepare("SELECT * FROM inference_jobs WHERE id = ?").get(jobId)) as
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

  const node = job.assigned_node_id ? await getNode(job.assigned_node_id) : null;
  const reward = job.supplier_reward_points ?? 0;
  const now = Date.now();

  return db().transaction(async (d) => {
    const flipped = await d
      .prepare(
        `UPDATE inference_jobs SET settlement_status = 'settled' WHERE id = ? AND settlement_status = 'pending'`,
      )
      .run(jobId);
    if (flipped.changes === 0) {
      return { settled: true, already: true };
    }

    if (node && reward > 0) {
      await d
        .prepare(
          `INSERT OR IGNORE INTO supplier_earnings (id, job_id, account_id, node_id, reward_points, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(newId(), jobId, node.accountId, node.id, reward, now);
      await d
        .prepare(
          `INSERT OR IGNORE INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at)
         VALUES (?, ?, 'supplier_earn', ?, ?, ?, ?)`,
        )
        .run(newId(), node.accountId, reward, job.settlement_key, `job:${jobId}`, now);
    }

    return { settled: true, already: false };
  });
}

/**
 * 買家扣點冪等：以 job settlement_key 為 ref，同一 job 不重複扣。
 * 在交易內呼叫時請傳入該交易的 `client`，以免另開連線讀不到未提交資料。
 */
export async function chargeBuyerForJobIdempotent(
  input: {
    userId: string;
    jobId: string;
    chargedPoints: number;
    messageId: string;
  },
  client?: Db,
): Promise<void> {
  const d = client ?? db();
  const job = (await d.prepare("SELECT settlement_key FROM inference_jobs WHERE id = ?").get(input.jobId)) as
    | { settlement_key: string }
    | undefined;
  if (!job) return;
  const exists = (await d
    .prepare(`SELECT 1 AS x FROM ledger WHERE type = 'usage' AND ref_id = ?`)
    .get(job.settlement_key)) as { x: number } | undefined;
  if (exists) return;
  // INSERT OR IGNORE：避免交易內 UNIQUE 失敗污染整段交易
  await d
    .prepare(
      `INSERT OR IGNORE INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at)
       VALUES (?, ?, 'usage', ?, ?, ?, ?)`,
    )
    .run(newId(), input.userId, -input.chargedPoints, job.settlement_key, `msg:${input.messageId}`, Date.now());
}

export async function listEarnings(accountId?: string): Promise<Record<string, unknown>[]> {
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
