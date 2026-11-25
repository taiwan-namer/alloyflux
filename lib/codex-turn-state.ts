import { db } from "./db";

/**
 * ChatGPT Codex 回應標頭 `x-codex-turn-state` 是後端黏著路由用的票根：
 * 下一輪原樣帶回，請求才會落到持有 prompt cache 的同一批機器。
 * Vercel 每個請求可能跑在不同實例，所以除了記憶體也寫進 DB。
 */
const TTL_MS = 60 * 60_000;
const memory = new Map<string, { value: string; at: number }>();
let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  tableReady ??= db()
    .exec(
      `CREATE TABLE IF NOT EXISTS codex_turn_states (
        cache_key TEXT PRIMARY KEY,
        turn_state TEXT NOT NULL,
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

export async function loadCodexTurnState(cacheKey: string): Promise<string | null> {
  const now = Date.now();
  const hit = memory.get(cacheKey);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    await ensureTable();
    const row = (await db()
      .prepare(`SELECT turn_state, updated_at FROM codex_turn_states WHERE cache_key = ?`)
      .get(cacheKey)) as { turn_state: string; updated_at: number | string } | undefined;
    if (!row || now - Number(row.updated_at) >= TTL_MS) return null;
    memory.set(cacheKey, { value: row.turn_state, at: Number(row.updated_at) });
    return row.turn_state;
  } catch {
    return null;
  }
}

export async function saveCodexTurnState(cacheKey: string, turnState: string): Promise<void> {
  const value = turnState.trim();
  if (!value || value.length > 4096) return;
  const at = Date.now();
  memory.set(cacheKey, { value, at });
  try {
    await ensureTable();
    await db()
      .prepare(
        `INSERT INTO codex_turn_states (cache_key, turn_state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET turn_state = excluded.turn_state, updated_at = excluded.updated_at`,
      )
      .run(cacheKey, value, at);
  } catch {
    /* 黏著失敗只影響快取命中率，不擋對話 */
  }
}
