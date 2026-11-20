import {
  getConversationState,
  mergeStateNote,
  upsertConversationState,
  type StateEntry,
} from "./conversation-state";
import { hintOf, randomToken } from "./crypto";
import { db, newId, type Db } from "./db";
import {
  extractStyleDirectives,
  formatStyleOverrideBlock,
  isSessionStyleConstraintText,
  resolveStyleConflicts,
  toSessionStyleConstraintText,
  USER_STYLE_CAP,
} from "./persona-style";
import { chargeBuyerForJobIdempotent } from "./supplier-settlement";

/** @deprecated 多租戶後僅供 smoke／遷移參考；業務路徑請用 Session user.id */
export const LOCAL_USER = "local-user";

export interface Conversation {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  /** 軟刪除時間；有值表示在垃圾桶 */
  deletedAt?: number | null;
}

let conversationsSchemaReady = false;

/** 確保 conversations.deleted_at 存在（舊庫升級；可重跑） */
export async function ensureConversationsSchema(): Promise<void> {
  if (conversationsSchemaReady) return;
  try {
    await db().exec(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
    await db().exec(
      `CREATE INDEX IF NOT EXISTS idx_conversations_user_active
       ON conversations(user_id, updated_at DESC)
       WHERE deleted_at IS NULL`,
    );
    await db().exec(
      `CREATE INDEX IF NOT EXISTS idx_conversations_user_trash
       ON conversations(user_id, deleted_at DESC)
       WHERE deleted_at IS NOT NULL`,
    );
    conversationsSchemaReady = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|relation/i.test(msg)) {
      console.warn("[conversations] table missing; skip schema ensure");
      return;
    }
    conversationsSchemaReady = true;
  }
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

export async function listConversations(userId: string): Promise<Conversation[]> {
  await ensureConversationsSchema();
  return (await db()
    .prepare(
      `SELECT id, title, model, updated_at AS "updatedAt"
       FROM conversations
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all(userId)) as unknown as Conversation[];
}

/** 垃圾桶內的已軟刪除對話 */
export async function listTrashedConversations(userId: string): Promise<Conversation[]> {
  await ensureConversationsSchema();
  return (await db()
    .prepare(
      `SELECT id, title, model, updated_at AS "updatedAt", deleted_at AS "deletedAt"
       FROM conversations
       WHERE user_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all(userId)) as unknown as Conversation[];
}

export async function getConversation(userId: string, id: string): Promise<Conversation | undefined> {
  await ensureConversationsSchema();
  return (await db()
    .prepare(
      `SELECT id, title, model, updated_at AS "updatedAt", deleted_at AS "deletedAt"
       FROM conversations
       WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .get(userId, id)) as unknown as Conversation | undefined;
}

export async function createConversation(userId: string, title: string, model: string): Promise<string> {
  await ensureConversationsSchema();
  const id = newId();
  const now = Date.now();
  await db()
    .prepare("INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, title, model, now, now);
  return id;
}

export async function renameConversation(userId: string, id: string, title: string): Promise<boolean> {
  await ensureConversationsSchema();
  const trimmed = title.trim().slice(0, 80);
  if (!trimmed) return false;
  const result = await db()
    .prepare(
      `UPDATE conversations SET title = ?, updated_at = ?
       WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .run(trimmed, Date.now(), userId, id);
  return result.changes > 0;
}

/** 移入垃圾桶：訊息與對話狀態保留，但不再注入跨對話記憶 */
export async function softDeleteConversation(userId: string, id: string): Promise<boolean> {
  await ensureConversationsSchema();
  const result = await db()
    .prepare(
      `UPDATE conversations SET deleted_at = ?
       WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .run(Date.now(), userId, id);
  return result.changes > 0;
}

/** 從垃圾桶還原：對話記憶一併回來 */
export async function restoreConversation(userId: string, id: string): Promise<boolean> {
  await ensureConversationsSchema();
  const result = await db()
    .prepare(
      `UPDATE conversations SET deleted_at = NULL, updated_at = ?
       WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL`,
    )
    .run(Date.now(), userId, id);
  return result.changes > 0;
}

/** 永久刪除（含訊息／對話狀態 CASCADE） */
export async function deleteConversation(userId: string, id: string): Promise<void> {
  await ensureConversationsSchema();
  await db().prepare("DELETE FROM conversations WHERE user_id = ? AND id = ?").run(userId, id);
}

/** 清空垃圾桶 */
export async function purgeTrashedConversations(userId: string): Promise<number> {
  await ensureConversationsSchema();
  const result = await db()
    .prepare("DELETE FROM conversations WHERE user_id = ? AND deleted_at IS NOT NULL")
    .run(userId);
  return result.changes;
}

export async function listMessages(conversationId: string): Promise<StoredMessage[]> {
  return (await db()
    .prepare(
      `SELECT id, role, content, model, source_id AS "sourceId", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              official_cost_points AS "officialCostPoints", charged_points AS "chargedPoints", created_at AS "createdAt"
       FROM messages WHERE conversation_id = ? ORDER BY created_at, id`,
    )
    .all(conversationId)) as unknown as StoredMessage[];
}

export type MessagesPage = {
  messages: StoredMessage[];
  hasMore: boolean;
};

/**
 * 由新到舊取一頁後再排回時間正序，供聊天 UI 懶載入。
 * before*：載入比此游標更舊的訊息。
 */
export async function listMessagesPage(
  conversationId: string,
  opts?: { limit?: number; beforeCreatedAt?: number; beforeId?: string },
): Promise<MessagesPage> {
  const limit = Math.max(1, Math.min(50, Math.floor(opts?.limit ?? 5)));
  const beforeCreatedAt = opts?.beforeCreatedAt;
  const beforeId = opts?.beforeId?.trim();
  const take = limit + 1;

  const select = `SELECT id, role, content, model, source_id AS "sourceId", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              official_cost_points AS "officialCostPoints", charged_points AS "chargedPoints", created_at AS "createdAt"
       FROM messages WHERE conversation_id = ?`;

  let rows: StoredMessage[];
  if (
    typeof beforeCreatedAt === "number" &&
    Number.isFinite(beforeCreatedAt) &&
    beforeId
  ) {
    rows = (await db()
      .prepare(
        `${select}
         AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, beforeCreatedAt, beforeCreatedAt, beforeId, take)) as unknown as StoredMessage[];
  } else {
    rows = (await db()
      .prepare(
        `${select}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, take)) as unknown as StoredMessage[];
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse(); // 畫面仍由舊→新
  return { messages: page, hasMore };
}

export async function addUserMessage(conversationId: string, content: string, model: string): Promise<string> {
  const id = newId();
  const now = Date.now();
  await db()
    .prepare("INSERT INTO messages (id, conversation_id, role, content, model, created_at) VALUES (?, ?, 'user', ?, ?, ?)")
    .run(id, conversationId, content, model, now);
  await db().prepare("UPDATE conversations SET updated_at = ?, model = ? WHERE id = ?").run(now, model, conversationId);
  return id;
}

/** 停止／中止時回滾尚未 settle 的 user 訊息，避免下一輪重複餵進模型 */
export async function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  await db()
    .prepare("DELETE FROM messages WHERE id = ? AND conversation_id = ?")
    .run(messageId, conversationId);
}

/** Saves the answer and books the charge to the buyer and the usage to the source in one transaction. */
export async function settleAssistantMessage(input: {
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
  /** 免費層對話：不扣買家額度，但記錄上游水庫等值消耗與訪客 IP 防刷桶 */
  freeMode?: boolean;
  ipBucketId?: string;
}): Promise<void> {
  const now = Date.now();
  const messageId = newId();
  const effectiveCharged = input.freeMode ? 0 : input.chargedPoints;
  await db().transaction(async (d) => {
    await d
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, source_id, input_tokens, cached_input_tokens, output_tokens,
                             official_cost_points, charged_points, quota_label, quota_used_pct, quota_before_pct, quota_after_pct,
                             upstream_model_version, job_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        input.conversationId,
        input.content,
        input.model,
        input.sourceId,
        input.inputTokens,
        input.cachedInputTokens,
        input.outputTokens,
        input.officialCostPoints,
        effectiveCharged,
        input.quotaLabel ?? null,
        input.quotaUsedPct ?? null,
        input.quotaBeforePct ?? null,
        input.quotaAfterPct ?? null,
        input.upstreamModelVersion ?? null,
        input.jobId ?? null,
        now,
      );
    if (input.freeMode) {
      await d
        .prepare(
          "INSERT INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at) VALUES (?, ?, 'source_usage', ?, ?, ?, ?)",
        )
        .run(newId(), input.ipBucketId || input.userId, input.officialCostPoints, input.sourceId, `free:${messageId}`, now);
    } else if (input.jobId) {
      // 冪等扣點（UNIQUE settlement_key）；沿用同一交易連線，避免開第二條連線
      await chargeBuyerForJobIdempotent(
        {
          userId: input.userId,
          jobId: input.jobId,
          chargedPoints: effectiveCharged,
          messageId,
        },
        d,
      );
    } else {
      await d
        .prepare(
          "INSERT INTO ledger (id, user_id, type, amount_points, ref_id, created_at) VALUES (?, ?, 'usage', ?, ?, ?)",
        )
        .run(newId(), input.userId, -effectiveCharged, messageId, now);
      await d
        .prepare(
          "INSERT INTO ledger (id, user_id, type, amount_points, ref_id, note, created_at) VALUES (?, ?, 'source_usage', ?, ?, ?, ?)",
        )
        .run(newId(), input.userId, input.officialCostPoints, input.sourceId, messageId, now);
    }
    await d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, input.conversationId);
  });
}

export async function balance(userId: string): Promise<number> {
  const row = (await db()
    .prepare("SELECT COALESCE(SUM(amount_points), 0) AS b FROM ledger WHERE user_id = ? AND type IN ('topup', 'usage')")
    .get(userId)) as { b: number };
  return Number(row.b);
}

/**
 * 高水位分母（免改 Schema）：最後一次 topup 入帳後的累計餘額，
 * 與目前 balance 取較大，最低保底 1000。
 * 供前端「可用額度 / quotaCap」進度條使用。
 */
export async function quotaCapFromLedger(userId: string): Promise<number> {
  const rows = (await db()
    .prepare(
      `SELECT type, amount_points AS amount, created_at AS "createdAt"
       FROM ledger
       WHERE user_id = ? AND type IN ('topup', 'usage')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId)) as { type: string; amount: number; createdAt: number }[];

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

export async function topUp(userId: string, points: number, note: string, client?: Db): Promise<void> {
  await (client ?? db())
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
export async function supplierUsage(sourceId: string, sinceMs: number): Promise<{
  totalUsedPct: number;
  messages: number;
  chargedPoints: number;
  rows: SupplierUsageRow[];
}> {
  const rows = (await db()
    .prepare(
      `SELECT created_at AS "createdAt", model, upstream_model_version AS "upstreamModelVersion", quota_label AS "quotaLabel",
              quota_used_pct AS "quotaUsedPct", quota_before_pct AS "quotaBeforePct", quota_after_pct AS "quotaAfterPct",
              input_tokens AS "inputTokens", output_tokens AS "outputTokens", charged_points AS "chargedPoints"
       FROM messages WHERE role = 'assistant' AND source_id = ? AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sourceId, sinceMs)) as unknown as SupplierUsageRow[];
  return {
    totalUsedPct: Math.round(rows.reduce((s, r) => s + (r.quotaUsedPct ?? 0), 0) * 1000) / 1000,
    messages: rows.length,
    chargedPoints: Math.round(rows.reduce((s, r) => s + (r.chargedPoints ?? 0), 0) * 100) / 100,
    rows,
  };
}

export async function usageSummary(
  userId: string,
): Promise<{ messages: number; chargedPoints: number; officialPoints: number }> {
  const row = (await db()
    .prepare(
      `SELECT COUNT(*) AS messages, COALESCE(SUM(m.charged_points), 0) AS "chargedPoints", COALESCE(SUM(m.official_cost_points), 0) AS "officialPoints"
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.role = 'assistant'`,
    )
    .get(userId)) as { messages: number | string; chargedPoints: number; officialPoints: number };
  // COUNT(*) 在 Postgres 為 bigint（postgres.js 預設回字串），統一轉為 number
  return {
    messages: Number(row.messages),
    chargedPoints: Number(row.chargedPoints),
    officialPoints: Number(row.officialPoints),
  };
}

/** 注入 system 的事實背景字元硬上限（與 style 額度分離） */
export const MAX_MEMORY_CHARS = 800;
const USER_MEMORY_CAP = 15;
const CROSS_CHAT_LIMIT = 6;
const FACT_MIN_LEN = 6;
const FACT_MAX_LEN = 120;

export type MemoryCategory = "fact" | "style";

export type UserMemoryRow = {
  id: string;
  fact: string;
  category: MemoryCategory;
  updatedAt: number;
};

const SENSITIVE_RE =
  /sk[_-]|password|密碼|驗證碼|token|bearer|api[_-]?key|secret|私钥|私鑰|access[_-]?key/i;

/** 輕量敏感詞過濾：命中則不納入記憶／跨對話脈絡 */
export function looksSensitive(text: string): boolean {
  return SENSITIVE_RE.test(text);
}

/** 事實擷取（語氣改由 persona-style；此處不再把「請用…語氣」當 fact） */
const MEMORY_EXTRACT_RES: RegExp[] = [
  /我是[^。！？\n]{2,80}/,
  /我的職業[是為][^。！？\n]{2,80}/,
  /我做[的]?[是為][^。！？\n]{2,80}/,
  /我的專案[是為叫名稱]?[^。！？\n]{2,80}/,
];

function normalizeFact(raw: string): string | null {
  const fact = raw.replace(/\s+/g, " ").trim().slice(0, FACT_MAX_LEN);
  if (fact.length < FACT_MIN_LEN || fact.length > FACT_MAX_LEN) return null;
  if (looksSensitive(fact)) return null;
  return fact;
}

function normalizeCategory(raw: string | null | undefined): MemoryCategory {
  return raw === "style" ? "style" : "fact";
}

let memoriesSchemaReady = false;

/** 確保 user_memories.category 存在（舊庫升級；可重跑） */
export async function ensureUserMemoriesSchema(): Promise<void> {
  if (memoriesSchemaReady) return;
  try {
    await db().exec(
      `ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'fact'`,
    );
    await db().exec(
      `CREATE INDEX IF NOT EXISTS idx_user_memories_user_cat ON user_memories(user_id, category, updated_at DESC)`,
    );
    memoriesSchemaReady = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|relation/i.test(msg)) {
      console.warn("[user_memories] table missing; skip schema ensure");
      return;
    }
    // 欄位已存在等可忽略
    memoriesSchemaReady = true;
  }
}

async function pruneUserMemories(userId: string, category: MemoryCategory): Promise<void> {
  const cap = category === "style" ? USER_STYLE_CAP : USER_MEMORY_CAP;
  await db()
    .prepare(
      `DELETE FROM user_memories
       WHERE id IN (
         SELECT id FROM user_memories
         WHERE user_id = ? AND category = ?
         ORDER BY updated_at DESC
         OFFSET ?
       )`,
    )
    .run(userId, category, cap);
}

/** 寫入／去重更新一條長期記憶；style 會覆蓋同主題舊條目 */
export async function upsertUserMemory(
  userId: string,
  fact: string,
  category: MemoryCategory = "fact",
): Promise<UserMemoryRow | null> {
  await ensureUserMemoriesSchema();
  const normalized = normalizeFact(fact);
  if (!normalized) return null;
  const cat = normalizeCategory(category);
  const now = Date.now();

  if (cat === "style") {
    const existingStyles = await listUserMemoryRows(userId, "style", USER_STYLE_CAP);
    const { superseded } = resolveStyleConflicts(
      existingStyles.map((r) => r.fact),
      normalized,
    );
    for (const old of superseded) {
      const row = existingStyles.find((r) => r.fact === old);
      if (row) {
        await db().prepare("DELETE FROM user_memories WHERE id = ? AND user_id = ?").run(row.id, userId);
      }
    }
  }

  const existing = (await db()
    .prepare("SELECT id FROM user_memories WHERE user_id = ? AND fact = ? AND category = ?")
    .get(userId, normalized, cat)) as { id: string } | undefined;
  let id: string;
  if (existing) {
    id = existing.id;
    await db()
      .prepare("UPDATE user_memories SET updated_at = ?, category = ? WHERE id = ?")
      .run(now, cat, id);
  } else {
    id = newId();
    await db()
      .prepare("INSERT INTO user_memories (id, user_id, fact, category, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, normalized, cat, now);
  }
  await pruneUserMemories(userId, cat);
  return { id, fact: normalized, category: cat, updatedAt: now };
}

export async function listUserMemoryRows(
  userId: string,
  category?: MemoryCategory,
  limit = USER_MEMORY_CAP,
): Promise<UserMemoryRow[]> {
  await ensureUserMemoriesSchema();
  const cap = category === "style" ? Math.min(limit, USER_STYLE_CAP) : limit;
  const rows = category
    ? ((await db()
        .prepare(
          `SELECT id, fact, category, updated_at AS "updatedAt"
           FROM user_memories
           WHERE user_id = ? AND category = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(userId, category, cap)) as {
        id: string;
        fact: string;
        category: string;
        updatedAt: number;
      }[])
    : ((await db()
        .prepare(
          `SELECT id, fact, category, updated_at AS "updatedAt"
           FROM user_memories
           WHERE user_id = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(userId, cap)) as {
        id: string;
        fact: string;
        category: string;
        updatedAt: number;
      }[]);
  return rows
    .map((r) => ({
      id: r.id,
      fact: r.fact,
      category: normalizeCategory(r.category),
      updatedAt: Number(r.updatedAt) || 0,
    }))
    .filter((r) => !looksSensitive(r.fact));
}

export async function listUserMemories(userId: string, limit = USER_MEMORY_CAP): Promise<string[]> {
  const rows = await listUserMemoryRows(userId, "fact", limit);
  return rows.map((r) => r.fact);
}

export async function deleteUserMemory(userId: string, memoryId: string): Promise<boolean> {
  await ensureUserMemoriesSchema();
  const existing = (await db()
    .prepare("SELECT id FROM user_memories WHERE id = ? AND user_id = ?")
    .get(memoryId, userId)) as { id: string } | undefined;
  if (!existing) return false;
  await db().prepare("DELETE FROM user_memories WHERE id = ? AND user_id = ?").run(memoryId, userId);
  return true;
}

/**
 * 零成本規則擷取：自述背景 → fact；語氣偏好由 applyPersonaFromUserMessage 處理。
 */
export async function maybeRememberFromUserMessage(userId: string, content: string): Promise<void> {
  const text = content?.trim();
  if (!text || looksSensitive(text)) return;
  const seen = new Set<string>();
  for (const re of MEMORY_EXTRACT_RES) {
    const m = text.match(re);
    if (!m?.[0]) continue;
    const fact = normalizeFact(m[0]);
    if (!fact || seen.has(fact)) continue;
    seen.add(fact);
    await upsertUserMemory(userId, fact, "fact");
  }
}

function makeStyleConstraintEntry(text: string, sourceMessageId?: string): StateEntry {
  return {
    id: newId(),
    text: toSessionStyleConstraintText(text),
    provenance: "user",
    status: "confirmed",
    sourceMessageId,
    createdAt: Date.now(),
  };
}

/**
 * 對話中自動捕捉語氣：全局 → user_memories(style)；本串 → hardConstraints【語氣】。
 * 登入使用者同時擷取 fact；訪客僅寫本串語氣。
 */
export async function applyPersonaFromUserMessage(input: {
  userId: string | null;
  conversationId: string;
  content: string;
  sourceMessageId?: string;
}): Promise<void> {
  const text = input.content?.trim();
  if (!text || looksSensitive(text)) return;

  const directives = extractStyleDirectives(text);
  for (const d of directives) {
    if (d.scope === "global" && input.userId) {
      await upsertUserMemory(input.userId, d.text, "style");
    } else if (d.scope === "session" || (d.scope === "global" && !input.userId)) {
      const note =
        (await getConversationState(input.conversationId)) ??
        ({
          conversationId: input.conversationId,
          goal: "",
          hardConstraints: [],
          decisions: [],
          progress: [],
          openQuestions: [],
          sourceMessageIds: [],
          coveredThroughCreatedAt: 0,
          revision: 0,
          updatedAt: 0,
        } as const);
      const merged = mergeStateNote(
        { ...note, conversationId: input.conversationId },
        {
          hardConstraints: [makeStyleConstraintEntry(d.text, input.sourceMessageId)],
        },
      );
      await upsertConversationState(merged);
    }
  }

  if (input.userId) {
    await maybeRememberFromUserMessage(input.userId, text);
  }
}

/** 組裝最高優先級語氣覆蓋區塊（獨立字數額度；不進「非當前指令」） */
export async function buildStyleOverrideContext(
  userId: string | null,
  conversationId: string,
): Promise<string> {
  const note = await getConversationState(conversationId);
  const sessionStyles =
    note?.hardConstraints
      .filter((e) => e.status !== "superseded" && isSessionStyleConstraintText(e.text))
      .map((e) => e.text) ?? [];

  const globalStyles = userId
    ? (await listUserMemoryRows(userId, "style", USER_STYLE_CAP)).map((r) => r.fact)
    : [];

  return formatStyleOverrideBlock({ sessionStyles, globalStyles });
}

/** 其他對話視窗最近 N 則 user 訊息摘要（截斷至 120 字；敏感內容跳過） */
export async function getRecentCrossConversationContext(
  userId: string,
  currentConversationId: string,
  limit = CROSS_CHAT_LIMIT,
): Promise<string[]> {
  await ensureConversationsSchema();
  const rows = (await db()
    .prepare(
      `SELECT m.content AS content
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ?
         AND m.conversation_id != ?
         AND c.deleted_at IS NULL
         AND m.role = 'user'
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(userId, currentConversationId, Math.max(limit * 3, limit))) as { content: string }[];

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
 * 不含 style（style 走 buildStyleOverrideContext）。
 */
export async function buildUserMemoryContext(userId: string, conversationId: string): Promise<string> {
  const memories = await listUserMemories(userId);
  const cross = await getRecentCrossConversationContext(userId, conversationId);
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

export async function listUserApiKeys(userId: string): Promise<UserApiKeyPublic[]> {
  return (await db()
    .prepare(
      `SELECT id, label, key_hint AS "keyHint", created_at AS "createdAt"
       FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId)) as unknown as UserApiKeyPublic[];
}

/** 新增一把金鑰；完整 apiKey 只在建立當下回傳一次 */
export async function createUserApiKey(
  userId: string,
  label?: string,
): Promise<UserApiKeyPublic & { apiKey: string }> {
  const count = Number(
    (
      (await db().prepare("SELECT COUNT(*) AS n FROM user_api_keys WHERE user_id = ?").get(userId)) as {
        n: number | string;
      }
    ).n,
  );
  if (count >= MAX_USER_API_KEYS) {
    throw Object.assign(new Error(`每位使用者最多 ${MAX_USER_API_KEYS} 把 API Key`), { status: 400 });
  }
  const user = (await db().prepare("SELECT id FROM users WHERE id = ?").get(userId)) as { id: string } | undefined;
  if (!user) throw Object.assign(new Error("找不到使用者"), { status: 404 });

  const id = newId();
  const apiKey = `sk_live_${randomToken(24)}`;
  const keyHint = hintOf(apiKey);
  const now = Date.now();
  const safeLabel = (label?.trim() || `金鑰 ${count + 1}`).slice(0, 40);
  await db()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, label, api_key, key_hint, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, safeLabel, apiKey, keyHint, now);

  // 同步舊欄位：若 users.api_key 已空或仍是預設，維持一筆可查的相容值
  await db()
    .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
    .run(apiKey, keyHint, userId);

  return { id, label: safeLabel, keyHint, createdAt: now, apiKey };
}

/** 刪除指定金鑰（立即失效）；不可刪他人金鑰 */
export async function deleteUserApiKey(userId: string, keyId: string): Promise<boolean> {
  const row = (await db()
    .prepare("SELECT id, api_key FROM user_api_keys WHERE id = ? AND user_id = ?")
    .get(keyId, userId)) as { id: string; api_key: string } | undefined;
  if (!row) return false;

  await db().prepare("DELETE FROM user_api_keys WHERE id = ? AND user_id = ?").run(keyId, userId);

  // 若刪掉的是 users.api_key 指向的那把，改指到剩餘最新一把或寫入撤銷占位
  const primary = (await db().prepare("SELECT api_key FROM users WHERE id = ?").get(userId)) as
    | { api_key: string }
    | undefined;
  if (primary?.api_key === row.api_key) {
    const next = (await db()
      .prepare(
        `SELECT api_key, key_hint FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId)) as { api_key: string; key_hint: string } | undefined;
    if (next) {
      await db()
        .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
        .run(next.api_key, next.key_hint, userId);
    } else {
      // 不以 sk_ 開頭，避免被 findUserByApiKey 誤當成有效金鑰
      const placeholder = `revoked_${randomToken(20)}`;
      await db()
        .prepare("UPDATE users SET api_key = ?, api_key_hint = ? WHERE id = ?")
        .run(placeholder, "已全部撤銷", userId);
    }
  }
  return true;
}
