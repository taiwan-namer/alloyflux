import { hintOf, randomToken } from "./crypto";
import { db, newId } from "./db";
import { chargeBuyerForJobIdempotent } from "./supplier-settlement";

/** @deprecated 多租戶後僅供 smoke／遷移參考；業務路徑請用 Session user.id */
export const LOCAL_USER = "local-user";

export interface Conversation {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  sourceId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  officialCostPoints: number | null;
  chargedPoints: number | null;
  createdAt: number;
}

export function listConversations(userId: string): Conversation[] {
  return db()
    .prepare("SELECT id, title, model, updated_at AS updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as unknown as Conversation[];
}

export function getConversation(userId: string, id: string): Conversation | undefined {
  return db()
    .prepare("SELECT id, title, model, updated_at AS updatedAt FROM conversations WHERE user_id = ? AND id = ?")
    .get(userId, id) as unknown as Conversation | undefined;
}

export function createConversation(userId: string, title: string, model: string): string {
  const id = newId();
  const now = Date.now();
  db()
    .prepare("INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, title, model, now, now);
  return id;
}

export function deleteConversation(userId: string, id: string): void {
  db().prepare("DELETE FROM conversations WHERE user_id = ? AND id = ?").run(userId, id);
}

export function listMessages(conversationId: string): StoredMessage[] {
  return db()
    .prepare(
      `SELECT id, role, content, model, source_id AS sourceId, input_tokens AS inputTokens, output_tokens AS outputTokens,
              official_cost_points AS officialCostPoints, charged_points AS chargedPoints, created_at AS createdAt
       FROM messages WHERE conversation_id = ? ORDER BY created_at`,
    )
    .all(conversationId) as unknown as StoredMessage[];
}

export function addUserMessage(conversationId: string, content: string, model: string): void {
  const now = Date.now();
  db()
    .prepare("INSERT INTO messages (id, conversation_id, role, content, model, created_at) VALUES (?, ?, 'user', ?, ?, ?)")
    .run(newId(), conversationId, content, model, now);
  db().prepare("UPDATE conversations SET updated_at = ?, model = ? WHERE id = ?").run(now, model, conversationId);
}

/** Saves the answer and books the charge to the buyer and the usage to the source in one transaction. */
export function settleAssistantMessage(input: {
  userId: string;
  conversationId: string;
  content: string;
  model: string;
  sourceId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  officialCostPoints: number;
  chargedPoints: number;
  quotaLabel?: string;
  quotaUsedPct?: number;
  quotaBeforePct?: number;
  quotaAfterPct?: number;
  upstreamModelVersion?: string;
  /** Node Agent job：買家扣點以 settlement_key 冪等 */
  jobId?: string;
}): void {
  const d = db();
  const now = Date.now();
  const messageId = newId();
  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, model, source_id, input_tokens, cached_input_tokens, output_tokens,
                             official_cost_points, charged_points, quota_label, quota_used_pct, quota_before_pct, quota_after_pct,
                             upstream_model_version, job_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      input.conversationId,
      input.content,
      input.model,
      input.sourceId,
      input.inputTokens,
      input.cachedInputTokens,
      input.outputTokens,
      input.officialCostPoints,
      input.chargedPoints,
      input.quotaLabel ?? null,
      input.quotaUsedPct ?? null,
      input.quotaBeforePct ?? null,
      input.quotaAfterPct ?? null,
      input.upstreamModelVersion ?? null,
      input.jobId ?? null,
      now,
    );
    if (input.jobId) {
      // 冪等扣點（UNIQUE settlement_key）
      chargeBuyerForJobIdempotent({
        userId: input.userId,
        jobId: input.jobId,
        chargedPoints: input.chargedPoints,
        messageId,
      });
    } else {
      d.prepare(
        "INSERT INTO ledger (id, user_id, type, amount_points, ref_id, created_at) VALUES (?, ?, 'usage', ?, ?, ?)",
      ).run(newId(), input.userId, -input.chargedPoints, messageId, now);
      d.prepare(
        "INSERT INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at) VALUES (?, ?, 'source_usage', ?, ?, ?, ?)",
      ).run(newId(), input.userId, input.officialCostPoints, input.sourceId, messageId, now);
    }
    d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, input.conversationId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function balance(userId: string): number {
  const row = db()
    .prepare("SELECT COALESCE(SUM(amount_points), 0) AS b FROM ledger WHERE user_id = ? AND type IN ('topup', 'usage')")
    .get(userId) as { b: number };
  return row.b;
}

/**
 * 高水位分母（免改 Schema）：最後一次 topup 入帳後的累計餘額，
 * 與目前 balance 取較大，最低保底 1000。
 * 供前端「可用額度 / quotaCap」進度條使用。
 */
export function quotaCapFromLedger(userId: string): number {
  const rows = db()
    .prepare(
      `SELECT type, amount_points AS amount, created_at AS createdAt
       FROM ledger
       WHERE user_id = ? AND type IN ('topup', 'usage')
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(userId) as { type: string; amount: number; createdAt: number }[];

  let running = 0;
  let afterLastTopup: number | null = null;
  for (const r of rows) {
    running += r.amount;
    if (r.type === "topup") afterLastTopup = running;
  }
  const current = rows.length ? running : 0;
  const peak = afterLastTopup ?? current;
  return Math.max(1000, peak, current);
}

export function topUp(userId: string, points: number, note: string): void {
  db()
    .prepare("INSERT INTO ledger (id, user_id, type, amount_points, note, created_at) VALUES (?, ?, 'topup', ?, ?, ?)")
    .run(newId(), userId, points, note, Date.now());
}

export interface SupplierUsageRow {
  createdAt: number;
  model: string | null;
  upstreamModelVersion: string | null;
  quotaLabel: string | null;
  quotaUsedPct: number | null;
  quotaBeforePct: number | null;
  quotaAfterPct: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chargedPoints: number | null;
}

/** 供給者看的帳：平台每一則對話實際吃掉他 Google 額度多少 %，以及本週累計 */
export function supplierUsage(sourceId: string, sinceMs: number): {
  totalUsedPct: number;
  messages: number;
  chargedPoints: number;
  rows: SupplierUsageRow[];
} {
  const rows = db()
    .prepare(
      `SELECT created_at AS createdAt, model, upstream_model_version AS upstreamModelVersion, quota_label AS quotaLabel,
              quota_used_pct AS quotaUsedPct, quota_before_pct AS quotaBeforePct, quota_after_pct AS quotaAfterPct,
              input_tokens AS inputTokens, output_tokens AS outputTokens, charged_points AS chargedPoints
       FROM messages WHERE role = 'assistant' AND source_id = ? AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sourceId, sinceMs) as unknown as SupplierUsageRow[];
  return {
    totalUsedPct: Math.round(rows.reduce((s, r) => s + (r.quotaUsedPct ?? 0), 0) * 1000) / 1000,
    messages: rows.length,
    chargedPoints: Math.round(rows.reduce((s, r) => s + (r.chargedPoints ?? 0), 0) * 100) / 100,
    rows,
  };
}

export function usageSummary(userId: string): { messages: number; chargedPoints: number; officialPoints: number } {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS messages, COALESCE(SUM(m.charged_points), 0) AS chargedPoints, COALESCE(SUM(m.official_cost_points), 0) AS officialPoints
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.role = 'assistant'`,
    )
    .get(userId) as { messages: number; chargedPoints: number; officialPoints: number };
  return row;
}

/** 注入 system 的總字元硬上限（約等於短背景，避免佔滿上下文） */
export const MAX_MEMORY_CHARS = 800;
const USER_MEMORY_CAP = 15;
const CROSS_CHAT_LIMIT = 6;
const FACT_MIN_LEN = 6;
const FACT_MAX_LEN = 120;

const SENSITIVE_RE =
  /sk[_-]|password|密碼|驗證碼|token|bearer|api[_-]?key|secret|私钥|私鑰|access[_-]?key/i;

/** 輕量敏感詞過濾：命中則不納入記憶／跨對話脈絡 */
export function looksSensitive(text: string): boolean {
  return SENSITIVE_RE.test(text);
}

const MEMORY_EXTRACT_RES: RegExp[] = [
  /我是[^。！？\n]{2,80}/,
  /我的職業[是為][^。！？\n]{2,80}/,
  /我做[的]?[是為][^。！？\n]{2,80}/,
  /我的專案[是為叫名稱]?[^。！？\n]{2,80}/,
  /請用[^。！？\n]{1,40}(?:語氣|語言|回覆|回答)/,
  /記住[：:\s]?[^。！？\n]{2,80}/,
  /請記住[^。！？\n]{2,80}/,
];

function normalizeFact(raw: string): string | null {
  const fact = raw.replace(/\s+/g, " ").trim().slice(0, FACT_MAX_LEN);
  if (fact.length < FACT_MIN_LEN || fact.length > FACT_MAX_LEN) return null;
  if (looksSensitive(fact)) return null;
  return fact;
}

function pruneUserMemories(userId: string): void {
  // SQLite：用 OFFSET 淘汰超過上限的最舊列（依 updated_at DESC 保留前 N）
  db()
    .prepare(
      `DELETE FROM user_memories
       WHERE id IN (
         SELECT id FROM user_memories
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .run(userId, USER_MEMORY_CAP);
}

/** 寫入／去重更新一條長期事實；每人最多保留最近 USER_MEMORY_CAP 條 */
export function upsertUserMemory(userId: string, fact: string): void {
  const normalized = normalizeFact(fact);
  if (!normalized) return;
  const now = Date.now();
  const existing = db()
    .prepare("SELECT id FROM user_memories WHERE user_id = ? AND fact = ?")
    .get(userId, normalized) as { id: string } | undefined;
  if (existing) {
    db().prepare("UPDATE user_memories SET updated_at = ? WHERE id = ?").run(now, existing.id);
  } else {
    db()
      .prepare("INSERT INTO user_memories (id, user_id, fact, updated_at) VALUES (?, ?, ?, ?)")
      .run(newId(), userId, normalized, now);
  }
  pruneUserMemories(userId);
}

export function listUserMemories(userId: string, limit = USER_MEMORY_CAP): string[] {
  const rows = db()
    .prepare(
      `SELECT fact FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as { fact: string }[];
  return rows.map((r) => r.fact).filter((f) => !looksSensitive(f));
}

/**
 * 零成本規則擷取：從本輪 user 訊息抽出自述背景／偏好，寫入 user_memories。
 * 不呼叫任何模型。
 */
export function maybeRememberFromUserMessage(userId: string, content: string): void {
  const text = content?.trim();
  if (!text || looksSensitive(text)) return;
  const seen = new Set<string>();
  for (const re of MEMORY_EXTRACT_RES) {
    const m = text.match(re);
    if (!m?.[0]) continue;
    const fact = normalizeFact(m[0]);
    if (!fact || seen.has(fact)) continue;
    seen.add(fact);
    upsertUserMemory(userId, fact);
  }
}

/** 其他對話視窗最近 N 則 user 訊息摘要（截斷至 120 字；敏感內容跳過） */
export function getRecentCrossConversationContext(
  userId: string,
  currentConversationId: string,
  limit = CROSS_CHAT_LIMIT,
): string[] {
  const rows = db()
    .prepare(
      `SELECT m.content AS content
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ?
         AND m.conversation_id != ?
         AND m.role = 'user'
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(userId, currentConversationId, Math.max(limit * 3, limit)) as { content: string }[];

  const out: string[] = [];
  for (const row of rows) {
    const snippet = row.content?.replace(/\s+/g, " ").trim().slice(0, FACT_MAX_LEN);
    if (!snippet || snippet.length < 2) continue;
    if (looksSensitive(snippet)) continue;
    out.push(snippet);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 合併長期事實 + 跨對話近期提問，字元硬上限 MAX_MEMORY_CHARS。
 * 回傳空字串表示無需注入。
 */
export function buildUserMemoryContext(userId: string, conversationId: string): string {
  const memories = listUserMemories(userId);
  const cross = getRecentCrossConversationContext(userId, conversationId);
  if (!memories.length && !cross.length) return "";

  const parts: string[] = [];
  if (memories.length) {
    parts.push("長期背景：");
    for (const f of memories) parts.push(`- ${f}`);
  }
  if (cross.length) {
    if (parts.length) parts.push("");
    parts.push("其他對話近期提問：");
    for (const s of cross) parts.push(`- ${s}`);
  }

  let text = parts.join("\n").trim();
  if (text.length > MAX_MEMORY_CHARS) {
    text = text.slice(0, MAX_MEMORY_CHARS - 1).trimEnd() + "…";
  }
  return text;
}

export const MAX_USER_API_KEYS = 10;

export interface UserApiKeyPublic {
  id: string;
  label: string;
  keyHint: string;
  createdAt: number;
}

export function listUserApiKeys(userId: string): UserApiKeyPublic[] {
  return db()
    .prepare(
      `SELECT id, label, key_hint AS keyHint, created_at AS createdAt
       FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as unknown as UserApiKeyPublic[];
}

/** 新增一把金鑰；完整 apiKey 只在建立當下回傳一次 */
export function createUserApiKey(userId: string, label?: string): UserApiKeyPublic & { apiKey: string } {
  const count = (
    db().prepare("SELECT COUNT(*) AS n FROM user_api_keys WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  if (count >= MAX_USER_API_KEYS) {
    throw Object.assign(new Error(`每位使用者最多 ${MAX_USER_API_KEYS} 把 API Key`), { status: 400 });
  }
  const user = db().prepare("SELECT id FROM users WHERE id = ?").get(userId) as { id: string } | undefined;
  if (!user) throw Object.assign(new Error("找不到使用者"), { status: 404 });

  const id = newId();
  const apiKey = `sk_live_${randomToken(24)}`;
  const keyHint = hintOf(apiKey);
  const now = Date.now();
  const safeLabel = (label?.trim() || `金鑰 ${count + 1}`).slice(0, 40);
  db()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, label, api_key, key_hint, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, safeLabel, apiKey, keyHint, now);

  // 同步舊欄位：若 users.api_key 已空或仍是預設，維持一筆可查的相容值
  db()
    .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
    .run(apiKey, keyHint, userId);

  return { id, label: safeLabel, keyHint, createdAt: now, apiKey };
}

/** 刪除指定金鑰（立即失效）；不可刪他人金鑰 */
export function deleteUserApiKey(userId: string, keyId: string): boolean {
  const row = db()
    .prepare("SELECT id, api_key FROM user_api_keys WHERE id = ? AND user_id = ?")
    .get(keyId, userId) as { id: string; api_key: string } | undefined;
  if (!row) return false;

  db().prepare("DELETE FROM user_api_keys WHERE id = ? AND user_id = ?").run(keyId, userId);

  // 若刪掉的是 users.api_key 指向的那把，改指到剩餘最新一把或寫入撤銷占位
  const primary = db().prepare("SELECT api_key FROM users WHERE id = ?").get(userId) as
    | { api_key: string }
    | undefined;
  if (primary?.api_key === row.api_key) {
    const next = db()
      .prepare(
        `SELECT api_key, key_hint FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId) as { api_key: string; key_hint: string } | undefined;
    if (next) {
      db()
        .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
        .run(next.api_key, next.key_hint, userId);
    } else {
      // 不以 sk_ 開頭，避免被 findUserByApiKey 誤當成有效金鑰
      const placeholder = `revoked_${randomToken(20)}`;
      db()
        .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
        .run(placeholder, "已全部撤銷", userId);
    }
  }
  return true;
}
