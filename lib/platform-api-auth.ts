import { findUserByApiKey, findUserByEmail, getSessionUser, isAdminEmail, type User } from "./auth";

/**
 * v1 API Key 驗證：
 * 1) users.api_key（sk_live_…）→ 該買家
 * 2) PLATFORM_API_KEYS 白名單 → 對應 ADMIN_EMAILS 第一位管理員（後門測試）
 */
export async function authenticatePlatformApiKey(req: Request): Promise<{ user: User; keyHint: string } | null> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const raw = m?.[1]?.trim() || "";
  if (!raw.startsWith("sk_")) return null;

  const byUser = await findUserByApiKey(raw);
  if (byUser) return { user: byUser, keyHint: byUser.apiKeyHint };

  const allow = (process.env.PLATFORM_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.includes(raw)) return null;

  const adminEmail = (process.env.ADMIN_EMAILS || "").split(",")[0]?.trim();
  if (adminEmail && isAdminEmail(adminEmail)) {
    const admin = await findUserByEmail(adminEmail);
    if (admin) return { user: admin, keyHint: `…${raw.slice(-4)}` };
  }
  // 後門金鑰但尚無管理員帳號：拒絕（避免誤扣到幽靈 user）
  return null;
}

/**
 * 策略會議室讀取用：API Key 或網頁登入 session 皆可。
 * 寫入／發訊息仍請用 authenticatePlatformApiKey，避免網頁誤觸干擾 Cursor 流程。
 */
export async function authenticateStrategyReader(req: Request): Promise<{ user: User } | null> {
  const byKey = await authenticatePlatformApiKey(req);
  if (byKey) return { user: byKey.user };
  const session = await getSessionUser(req);
  if (session) return { user: session };
  return null;
}
