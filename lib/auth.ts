import { db, newId } from "./db";
import { hashPassword, hintOf, hmacSign, hmacVerify, randomToken, verifyPassword } from "./crypto";
import { topUp } from "./store";

export const SESSION_COOKIE = "aup_session";

export type UserRole = "buyer" | "supplier";

export interface User {
  id: string;
  email: string;
  name: string;
  apiKey: string;
  apiKeyHint: string;
  role: UserRole;
  createdAt: number;
  isAdmin: boolean;
  isSupplier: boolean;
  isBuyer: boolean;
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  api_key: string;
  api_key_hint: string;
  role: string | null;
  created_at: number;
};

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.trim().toLowerCase());
}

function normalizeRole(role: string | null | undefined): UserRole {
  return role === "supplier" ? "supplier" : "buyer";
}

function rowToUser(r: UserRow): User {
  const role = normalizeRole(r.role);
  const isAdmin = isAdminEmail(r.email);
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    apiKey: r.api_key,
    apiKeyHint: r.api_key_hint,
    role,
    createdAt: Number(r.created_at),
    isAdmin,
    isSupplier: role === "supplier" || isAdmin,
    isBuyer: true,
  };
}

export function generateLiveApiKey(): string {
  return `sk_live_${randomToken(24)}`;
}

function initialFreePoints(): number {
  const n = Number(process.env.INITIAL_FREE_POINTS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function findUserById(id: string): Promise<User | null> {
  const row = (await db().prepare("SELECT * FROM users WHERE id = ?").get(id)) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string | null }) | null> {
  const row = (await db()
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
    .get(email.trim())) as UserRow | undefined;
  if (!row) return null;
  return { ...rowToUser(row), passwordHash: row.password_hash };
}

export async function findUserByApiKey(apiKey: string): Promise<User | null> {
  if (!apiKey?.startsWith("sk_")) return null;
  // 優先：可多把管理的 user_api_keys
  const viaKeys = (await db()
    .prepare(
      `SELECT u.* FROM user_api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.api_key = ?`,
    )
    .get(apiKey)) as UserRow | undefined;
  if (viaKeys) return rowToUser(viaKeys);
  // 相容：尚未遷移的舊版單一 users.api_key
  const row = (await db().prepare("SELECT * FROM users WHERE api_key = ?").get(apiKey)) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export async function createUser(input: {
  email: string;
  name?: string;
  password?: string;
  role?: UserRole;
}): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Email 格式不正確"), { status: 400 });
  }
  if (await findUserByEmail(email)) {
    throw Object.assign(new Error("此 Email 已註冊"), { status: 409 });
  }
  const role: UserRole = input.role === "supplier" ? "supplier" : "buyer";
  const id = newId();
  const apiKey = generateLiveApiKey();
  const name = input.name?.trim() || email.split("@")[0];
  const passwordHash = input.password ? hashPassword(input.password) : null;
  if (input.password && input.password.length < 6) {
    throw Object.assign(new Error("密碼至少 6 碼"), { status: 400 });
  }

  const now = Date.now();
  await db()
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, api_key, api_key_hint, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, email, name, passwordHash, apiKey, hintOf(apiKey), role, now);

  // 同步寫入可多把管理的金鑰表（註冊預設一把）
  try {
    await db()
      .prepare(
        `INSERT OR IGNORE INTO user_api_keys (id, user_id, label, api_key, key_hint, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), id, "預設金鑰", apiKey, hintOf(apiKey), now);
  } catch {
    // 表尚未建立時略過；open()/migrate 會補
  }

  // 試用點只給買家；供給者主線是綁訂閱
  if (role === "buyer") {
    const free = initialFreePoints();
    if (free > 0) await topUp(id, free, "新註冊試用點數");
  }

  return (await findUserById(id))!;
}

export async function upsertGoogleUser(input: { email: string; name?: string; role?: UserRole }): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(email);
  if (existing) {
    if (input.name?.trim()) {
      await db().prepare("UPDATE users SET name = ? WHERE id = ?").run(input.name.trim(), existing.id);
    }
    if (input.role === "supplier" && existing.role !== "supplier") {
      await db().prepare("UPDATE users SET role = 'supplier' WHERE id = ?").run(existing.id);
    }
    return (await findUserById(existing.id))!;
  }
  return createUser({ email, name: input.name, role: input.role ?? "buyer" });
}

export async function authenticateEmailPassword(email: string, password: string): Promise<User> {
  const u = await findUserByEmail(email);
  if (!u || !u.passwordHash) {
    throw Object.assign(new Error("帳號或密碼錯誤"), { status: 401 });
  }
  if (!verifyPassword(password, u.passwordHash)) {
    throw Object.assign(new Error("帳號或密碼錯誤"), { status: 401 });
  }
  return (await findUserById(u.id))!;
}

function sessionDays(): number {
  const n = Number(process.env.SESSION_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function issueSessionToken(userId: string): string {
  const exp = Date.now() + sessionDays() * 86_400_000;
  const payload = `${userId}.${exp}`;
  return `${Buffer.from(payload).toString("base64url")}.${hmacSign(payload)}`;
}

export function parseSessionToken(token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  let payload: string;
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!hmacVerify(payload, sig)) return null;
  const [userId, expStr] = payload.split(".");
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || Date.now() > exp) return null;
  return userId;
}

export function sessionCookieHeader(token: string): string {
  const maxAge = sessionDays() * 86_400;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function getSessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const userId = parseSessionToken(token);
  if (!userId) return null;
  return findUserById(userId);
}

export async function requireUser(req: Request): Promise<User> {
  const u = await getSessionUser(req);
  if (!u) throw Object.assign(new Error("請先登入"), { status: 401 });
  return u;
}

export async function requireAdmin(req: Request): Promise<User> {
  const u = await requireUser(req);
  if (!u.isAdmin) throw Object.assign(new Error("需要管理員權限"), { status: 403 });
  return u;
}

/** 供給者後台（綁訂閱）：supplier 或 admin */
export async function requireSupplier(req: Request): Promise<User> {
  const u = await requireUser(req);
  if (!u.isSupplier) throw Object.assign(new Error("需要供給者權限"), { status: 403 });
  return u;
}

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    apiKey: u.apiKey,
    role: u.role,
    isAdmin: u.isAdmin,
    isSupplier: u.isSupplier,
    isBuyer: u.isBuyer,
  };
}

export function homePathFor(u: User): string {
  if (u.isAdmin) return "/admin";
  if (u.role === "supplier") return "/vendor";
  return "/";
}

export function jsonError(e: unknown): Response {
  const status = typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 500;
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status: status || 500 });
}

export function buyerGoogleConfigured(): boolean {
  return Boolean(process.env.BUYER_GOOGLE_CLIENT_ID?.trim() && process.env.BUYER_GOOGLE_CLIENT_SECRET?.trim());
}

export function buyerGoogleRedirectUri(): string {
  return (
    process.env.BUYER_GOOGLE_REDIRECT_URI?.trim() ||
    "http://127.0.0.1:3000/api/auth/google/callback"
  );
}
