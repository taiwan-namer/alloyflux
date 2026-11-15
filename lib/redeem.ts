import { db, newId } from "./db";
import { topUp } from "./store";

/** 封測用無限儲值金鑰（Vercel env：TEST_TOPUP_KEY）；正式上線請刪除 */
export function testTopUpKey(): string {
  return process.env.TEST_TOPUP_KEY?.trim() || "";
}

export function testTopUpPoints(): number {
  const n = Number(process.env.TEST_TOPUP_POINTS ?? 10_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

export async function createRedeemCode(input: {
  points?: number;
  maxUses?: number;
  expiresAt?: number | null;
  note?: string;
  code?: string;
}): Promise<{ code: string; points: number; maxUses: number }> {
  const points = input.points ?? 1000;
  const maxUses = input.maxUses ?? 1;
  const code =
    input.code?.trim().toUpperCase() ||
    `VIP199-${newId().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

  await db()
    .prepare(
      `INSERT INTO redeem_codes (code, points, max_uses, used_count, expires_at, note, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(code, points, maxUses, input.expiresAt ?? null, input.note ?? null, Date.now());

  return { code, points, maxUses };
}

export async function redeemCode(
  userId: string,
  rawCode: string,
): Promise<{ points: number; balanceNote: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw Object.assign(new Error("請輸入兌換碼"), { status: 400 });

  // 封測金鑰：可重複兌換、不寫 redeem_codes（之後拔掉 TEST_TOPUP_KEY 即失效）
  const testKey = testTopUpKey().toUpperCase();
  if (testKey && code === testKey) {
    const points = testTopUpPoints();
    await topUp(userId, points, `封測自動儲值（${code.slice(0, 8)}…）`);
    return { points, balanceNote: `封測儲值已入帳 ${points} 額度` };
  }

  return db().transaction(async (d) => {
    const row = (await d.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code)) as
      | {
          code: string;
          points: number;
          max_uses: number;
          used_count: number;
          expires_at: number | null;
        }
      | undefined;

    if (!row) throw Object.assign(new Error("兌換碼無效"), { status: 404 });
    if (row.expires_at && Date.now() > Number(row.expires_at)) {
      throw Object.assign(new Error("兌換碼已過期"), { status: 410 });
    }
    if (row.used_count >= row.max_uses) {
      throw Object.assign(new Error("兌換碼已達使用上限"), { status: 409 });
    }

    const dup = (await d
      .prepare("SELECT 1 AS x FROM redeem_redemptions WHERE code = ? AND user_id = ?")
      .get(code, userId)) as { x: number } | undefined;
    if (dup) throw Object.assign(new Error("你已兌換過此碼"), { status: 409 });

    const upd = await d
      .prepare(
        `UPDATE redeem_codes SET used_count = used_count + 1
         WHERE code = ? AND used_count < max_uses`,
      )
      .run(code);
    if (upd.changes === 0) throw Object.assign(new Error("兌換碼已達使用上限"), { status: 409 });

    await d
      .prepare(`INSERT INTO redeem_redemptions (id, code, user_id, points, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(newId(), code, userId, row.points, Date.now());

    // 入帳與兌換同一交易，避免「碼已核銷但餘額尚未寫入」的窗口
    await d
      .prepare(
        "INSERT INTO ledger (id, user_id, type, amount_points, note, created_at) VALUES (?, ?, 'topup', ?, ?, ?)",
      )
      .run(newId(), userId, row.points, `兌換碼 ${code}`, Date.now());

    return { points: row.points, balanceNote: `已入帳 ${row.points} 額度` };
  });
}

export async function listRecentRedeemCodes(limit = 20): Promise<Record<string, unknown>[]> {
  return db()
    .prepare(
      `SELECT code, points, max_uses AS "maxUses", used_count AS "usedCount", expires_at AS "expiresAt", note, created_at AS "createdAt"
       FROM redeem_codes ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}
