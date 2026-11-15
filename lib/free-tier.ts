import { createHash } from "node:crypto";
import { readCookie } from "./auth";
import { hmacSign, hmacVerify, randomToken } from "./crypto";
import { db } from "./db";
import { MODELS, type ModelInfo } from "./models";

export const GUEST_COOKIE = "aup_guest";

export function freeDailyMessageLimit(): number {
  const n = Number(process.env.FREE_DAILY_MESSAGES ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** 台灣時間（UTC+8）當日 00:00 的 Unix ms */
export function taipeiDayStartMs(now = Date.now()): number {
  const tzOffsetMs = 8 * 3_600_000;
  const shifted = now + tzOffsetMs;
  const dayMs = 86_400_000;
  return Math.floor(shifted / dayMs) * dayMs - tzOffsetMs;
}

export function clientIpHash(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  const raw = xff || realIp || "local";
  return createHash("sha256").update(`ip:${raw}`).digest("hex").slice(0, 16);
}

export function parseGuestCookie(token: string | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const guestId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^guest_[a-zA-Z0-9_-]{8,48}$/.test(guestId)) return null;
  if (!hmacVerify(guestId, sig)) return null;
  return guestId;
}

export function issueGuestCookieValue(guestId: string): string {
  return `${guestId}.${hmacSign(guestId)}`;
}

export function guestCookieHeader(value: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GUEST_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 86_400}${secure}`;
}

export function getOrCreateGuestIdentity(req: Request): {
  guestUserId: string;
  ipBucketId: string;
  setCookieHeader: string | null;
} {
  const existing = parseGuestCookie(readCookie(req, GUEST_COOKIE));
  const ipBucketId = `guest_ip_${clientIpHash(req)}`;
  if (existing) {
    return { guestUserId: existing, ipBucketId, setCookieHeader: null };
  }
  const guestUserId = `guest_${randomToken(12)}`;
  const signed = issueGuestCookieValue(guestUserId);
  return {
    guestUserId,
    ipBucketId,
    setCookieHeader: guestCookieHeader(signed),
  };
}

export function isFreeTierModel(model: ModelInfo): boolean {
  return Boolean(model.freeTier);
}

export function freeTierModelIds(): string[] {
  return MODELS.filter((m) => m.freeTier).map((m) => m.id);
}

/**
 * 統計免費層今日已用則數：
 * - 已登入未付費會員：統計該 userId 今日由免費層（charged_points = 0）產生的回覆數
 * - 未登入訪客：取「該 guest cookie 對話回覆數」與「同 IP 訪客今日回覆數」較大值（防清 Cookie 刷量）
 */
export async function getFreeDailyStatus(input: {
  userId: string;
  isGuest: boolean;
  ipBucketId?: string;
}): Promise<{ used: number; limit: number; remaining: number; resetAtMs: number }> {
  const limit = freeDailyMessageLimit();
  const since = taipeiDayStartMs();
  const resetAtMs = since + 86_400_000;

  const selfRow = (await db()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ?
         AND m.role = 'assistant'
         AND COALESCE(m.charged_points, 0) = 0
         AND m.created_at >= ?`,
    )
    .get(input.userId, since)) as { n: number | string } | undefined;
  let used = Number(selfRow?.n ?? 0);

  if (input.isGuest && input.ipBucketId) {
    const ipRow = (await db()
      .prepare(
        `SELECT COUNT(*) AS n
         FROM ledger
         WHERE user_id = ?
           AND type = 'source_usage'
           AND created_at >= ?`,
      )
      .get(input.ipBucketId, since)) as { n: number | string } | undefined;
    used = Math.max(used, Number(ipRow?.n ?? 0));
  }

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAtMs,
  };
}
