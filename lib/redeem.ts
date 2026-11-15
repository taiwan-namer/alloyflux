import { db, newId } from "./db";

export function createRedeemCode(input: {
  points?: number;
  maxUses?: number;
  expiresAt?: number | null;
  note?: string;
  code?: string;
}): { code: string; points: number; maxUses: number } {
  const points = input.points ?? 1000;
  const maxUses = input.maxUses ?? 1;
  const code =
    input.code?.trim().toUpperCase() ||
    `VIP199-${newId().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

  db()
    .prepare(
      `INSERT INTO redeem_codes (code, points, max_uses, used_count, expires_at, note, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(code, points, maxUses, input.expiresAt ?? null, input.note ?? null, Date.now());

  return { code, points, maxUses };
}

export function redeemCode(userId: string, rawCode: string): { points: number; balanceNote: string } {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw Object.assign(new Error("請輸入兌換碼"), { status: 400 });

  const d = db();
  d.exec("BEGIN");
  try {
    const row = d.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code) as
      | {
          code: string;
          points: number;
          max_uses: number;
          used_count: number;
          expires_at: number | null;
        }
      | undefined;

    if (!row) throw Object.assign(new Error("兌換碼無效"), { status: 404 });
    if (row.expires_at && Date.now() > row.expires_at) {
      throw Object.assign(new Error("兌換碼已過期"), { status: 410 });
    }
    if (row.used_count >= row.max_uses) {
      throw Object.assign(new Error("兌換碼已達使用上限"), { status: 409 });
    }

    const dup = d
      .prepare("SELECT 1 AS x FROM redeem_redemptions WHERE code = ? AND user_id = ?")
      .get(code, userId) as { x: number } | undefined;
    if (dup) throw Object.assign(new Error("你已兌換過此碼"), { status: 409 });

    const upd = d
      .prepare(
        `UPDATE redeem_codes SET used_count = used_count + 1
         WHERE code = ? AND used_count < max_uses`,
      )
      .run(code);
    if (upd.changes === 0) throw Object.assign(new Error("兌換碼已達使用上限"), { status: 409 });

    d.prepare(
      `INSERT INTO redeem_redemptions (id, code, user_id, points, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), code, userId, row.points, Date.now());

    // 入帳與兌換同一交易，避免「碼已核銷但餘額尚未寫入」的窗口
    d.prepare(
      "INSERT INTO ledger (id, user_id, type, amount_points, note, created_at) VALUES (?, ?, 'topup', ?, ?, ?)",
    ).run(newId(), userId, row.points, `兌換碼 ${code}`, Date.now());

    d.exec("COMMIT");
    return { points: row.points, balanceNote: `已入帳 ${row.points} 額度` };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function listRecentRedeemCodes(limit = 20) {
  return db()
    .prepare(
      `SELECT code, points, max_uses AS maxUses, used_count AS usedCount, expires_at AS expiresAt, note, created_at AS createdAt
       FROM redeem_codes ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}
