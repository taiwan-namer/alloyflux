import { db } from "./db";

/**
 * 快取黏著以「平台使用者側」為準（對話／affinity），不是供給者 ChatGPT 帳號。
 * - preferred_source：同一對話盡量打同一供給來源，避免換帳把 Codex 後端黏著弄斷
 * - turn_state：仍須依供給來源分鍵（票根不能跨 ChatGPT 帳號重用）
 */
const TTL_MS = 60 * 60_000;
const memSource = new Map<string, { value: string; at: number }>();
const memTurn = new Map<string, { value: string; at: number }>();
let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  tableReady ??= db()
    .exec(
      `CREATE TABLE IF NOT EXISTS prompt_cache_sticky (
        sticky_key TEXT PRIMARY KEY,
        preferred_source_id TEXT,
        turn_state TEXT,
        updated_at BIGINT NOT NULL
      );`,
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

/** 使用者側黏著鍵：有對話／session affinity 用它；否則退回 user+model */
export function stickyKeyFor(userId: string, modelId: string, cacheAffinityId?: string): string {
  const a = cacheAffinityId?.trim();
  if (a) return `aff:${a}`;
  return `user:${userId}:${modelId}`;
}

export async function loadPreferredSource(stickyKey: string): Promise<string | null> {
  const now = Date.now();
  const hit = memSource.get(stickyKey);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    await ensureTable();
    const row = (await db()
      .prepare(`SELECT preferred_source_id, updated_at FROM prompt_cache_sticky WHERE sticky_key = ?`)
      .get(stickyKey)) as { preferred_source_id: string | null; updated_at: number | string } | undefined;
    if (!row?.preferred_source_id || now - Number(row.updated_at) >= TTL_MS) return null;
    memSource.set(stickyKey, { value: row.preferred_source_id, at: Number(row.updated_at) });
    return row.preferred_source_id;
  } catch {
    return null;
  }
}

export async function savePreferredSource(stickyKey: string, sourceId: string): Promise<void> {
  const id = sourceId.trim();
  if (!id) return;
  const at = Date.now();
  memSource.set(stickyKey, { value: id, at });
  try {
    await ensureTable();
    await db()
      .prepare(
        `INSERT INTO prompt_cache_sticky (sticky_key, preferred_source_id, turn_state, updated_at)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT (sticky_key) DO UPDATE SET
           preferred_source_id = excluded.preferred_source_id,
           updated_at = excluded.updated_at`,
      )
      .run(stickyKey, id, at);
  } catch {
    /* 黏著失敗只影響命中率 */
  }
}

function turnMemKey(cacheKey: string, sourceId: string): string {
  return `${cacheKey}::${sourceId}`;
}

export async function loadCodexTurnState(cacheKey: string, sourceId: string): Promise<string | null> {
  const mk = turnMemKey(cacheKey, sourceId);
  const now = Date.now();
  const hit = memTurn.get(mk);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    await ensureTable();
    const row = (await db()
      .prepare(`SELECT turn_state, updated_at FROM prompt_cache_sticky WHERE sticky_key = ?`)
      .get(mk)) as { turn_state: string | null; updated_at: number | string } | undefined;
    if (!row?.turn_state || now - Number(row.updated_at) >= TTL_MS) return null;
    memTurn.set(mk, { value: row.turn_state, at: Number(row.updated_at) });
    return row.turn_state;
  } catch {
    return null;
  }
}

export async function saveCodexTurnState(
  cacheKey: string,
  sourceId: string,
  turnState: string,
): Promise<void> {
  const value = turnState.trim();
  if (!value || value.length > 4096) return;
  const mk = turnMemKey(cacheKey, sourceId);
  const at = Date.now();
  memTurn.set(mk, { value, at });
  try {
    await ensureTable();
    await db()
      .prepare(
        `INSERT INTO prompt_cache_sticky (sticky_key, preferred_source_id, turn_state, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT (sticky_key) DO UPDATE SET
           turn_state = excluded.turn_state,
           updated_at = excluded.updated_at`,
      )
      .run(mk, value, at);
  } catch {
    /* ignore */
  }
}

/** 把尚在候選池的偏好來源排到最前；其餘順序不變 */
export function preferSourceFirst<T extends { source: { id: string } }>(
  candidates: T[],
  preferredSourceId: string | null | undefined,
): T[] {
  if (!preferredSourceId) return candidates;
  const i = candidates.findIndex((c) => c.source.id === preferredSourceId);
  if (i <= 0) return candidates;
  return [candidates[i]!, ...candidates.slice(0, i), ...candidates.slice(i + 1)];
}

/** 既有對話尚無 sticky 紀錄時，用上一則助理訊息的供給來源暖機 */
export async function loadLastSourceForAffinity(cacheAffinityId: string): Promise<string | null> {
  const id = cacheAffinityId.trim();
  if (!id) return null;
  try {
    const row = (await db()
      .prepare(
        `SELECT source_id FROM messages
         WHERE conversation_id = ? AND role = 'assistant' AND source_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id)) as { source_id: string } | undefined;
    return row?.source_id ?? null;
  } catch {
    return null;
  }
}
