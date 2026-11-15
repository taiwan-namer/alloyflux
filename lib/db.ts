import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 11;

const globalForDb = globalThis as unknown as {
  __db?: DatabaseSync;
  __dbSchemaVersion?: number;
};

function tableSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? "";
}

function ensureColumns(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(sources)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("auth_type")) {
    db.exec("ALTER TABLE sources ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'api_key'");
  }
  if (!cols.includes("share_limit_pct")) {
    db.exec("ALTER TABLE sources ADD COLUMN share_limit_pct REAL NOT NULL DEFAULT 80");
  }
  if (!cols.includes("quota_json")) {
    db.exec("ALTER TABLE sources ADD COLUMN quota_json TEXT");
  }
  if (!cols.includes("quota_updated_at")) {
    db.exec("ALTER TABLE sources ADD COLUMN quota_updated_at INTEGER");
  }

  const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  for (const [name, type] of [
    ["quota_label", "TEXT"],
    ["quota_used_pct", "REAL"],
    ["quota_before_pct", "REAL"],
    ["quota_after_pct", "REAL"],
    ["upstream_model_version", "TEXT"],
    ["job_id", "TEXT"],
  ] as const) {
    if (!msgCols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }

  // users.role：buyer | supplier（admin 仍由 ADMIN_EMAILS 判定）
  try {
    const userCols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    if (userCols.length && !userCols.includes("role")) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'buyer'");
    }
  } catch {
    // users 表可能尚未建立
  }

  // 舊版 sources CHECK 重建
  const sql = tableSql(db, "sources");
  const needsRebuild =
    /provider\s+IN\s*\(/i.test(sql) || (!/auth_type/i.test(sql) && cols.includes("auth_type"));
  if (needsRebuild) {
    db.exec(`
      BEGIN;
      CREATE TABLE sources_v3 (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('supplier', 'platform')),
        provider TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'api_key',
        encrypted_key TEXT NOT NULL,
        key_hint TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        monthly_cap_points REAL,
        share_limit_pct REAL NOT NULL DEFAULT 80,
        quota_json TEXT,
        quota_updated_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sources_v3 (
        id, label, kind, provider, auth_type, encrypted_key, key_hint,
        priority, monthly_cap_points, share_limit_pct, quota_json, quota_updated_at,
        enabled, created_at
      )
      SELECT
        id, label, kind, provider,
        COALESCE(auth_type, 'api_key'),
        encrypted_key, key_hint, priority, monthly_cap_points,
        COALESCE(share_limit_pct, 80),
        quota_json, quota_updated_at, enabled, created_at
      FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_v3 RENAME TO sources;
      COMMIT;
    `);
  }

  migrateSupplierNodesV7(db);
  migrateLedgerV7(db);
  migrateUserApiKeysV11(db);
}

/** 舊版 OAuth-relay supplier_nodes → 新 Node Agent schema（open() 開頭已先 rename） */
function migrateSupplierNodesV7(db: DatabaseSync): void {
  const sql = tableSql(db, "supplier_nodes");
  if (sql && !/account_id/i.test(sql)) {
    db.exec(`
      DROP TABLE IF EXISTS supplier_nodes_legacy;
      ALTER TABLE supplier_nodes RENAME TO supplier_nodes_legacy;
    `);
  }
}

function migrateLedgerV7(db: DatabaseSync): void {
  const sql = tableSql(db, "ledger");
  if (!sql || /supplier_earn/i.test(sql)) return;
  db.exec(`
    BEGIN;
    CREATE TABLE ledger_v7 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('topup', 'usage', 'source_usage', 'supplier_earn')),
      amount_points REAL NOT NULL,
      ref_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO ledger_v7 SELECT id, user_id, type, amount_points, ref_id, note, created_at FROM ledger;
    DROP TABLE ledger;
    ALTER TABLE ledger_v7 RENAME TO ledger;
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_usage_ref
      ON ledger(type, ref_id) WHERE type = 'usage' AND ref_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_earn_ref
      ON ledger(type, ref_id) WHERE type = 'supplier_earn' AND ref_id IS NOT NULL;
    COMMIT;
  `);
}

/** 將舊版單一 users.api_key 遷移到可多把管理的 user_api_keys */
function migrateUserApiKeysV11(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id, created_at);
  `);

  const users = db
    .prepare("SELECT id, api_key, api_key_hint, created_at FROM users WHERE api_key IS NOT NULL AND api_key != ''")
    .all() as { id: string; api_key: string; api_key_hint: string; created_at: number }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO user_api_keys (id, user_id, label, api_key, key_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const exists = db.prepare("SELECT 1 AS ok FROM user_api_keys WHERE api_key = ?");
  for (const u of users) {
    if (!u.api_key.startsWith("sk_")) continue;
    if (exists.get(u.api_key)) continue;
    insert.run(
      crypto.randomUUID(),
      u.id,
      "預設金鑰",
      u.api_key,
      u.api_key_hint || `…${u.api_key.slice(-4)}`,
      u.created_at || Date.now(),
    );
  }
}

function open(): DatabaseSync {
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "app.db"));
  db.exec(`PRAGMA journal_mode = WAL;`);

  // 先處理舊版 OAuth-relay supplier_nodes（無 account_id），避免後續 INDEX 失敗
  try {
    const sql = tableSql(db, "supplier_nodes");
    if (sql && !/account_id/i.test(sql)) {
      db.exec(`
        DROP TABLE IF EXISTS supplier_nodes_legacy;
        ALTER TABLE supplier_nodes RENAME TO supplier_nodes_legacy;
      `);
    }
  } catch {
    // ignore
  }

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT,
      source_id TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      official_cost_points REAL,
      charged_points REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('supplier', 'platform')),
      provider TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'api_key',
      encrypted_key TEXT NOT NULL,
      key_hint TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      monthly_cap_points REAL,
      share_limit_pct REAL NOT NULL DEFAULT 80,
      quota_json TEXT,
      quota_updated_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('topup', 'usage', 'source_usage', 'supplier_earn')),
      amount_points REAL NOT NULL,
      ref_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_usage_ref
      ON ledger(type, ref_id) WHERE type = 'usage' AND ref_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_earn_ref
      ON ledger(type, ref_id) WHERE type = 'supplier_earn' AND ref_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS supplier_accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_nodes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES supplier_accounts(id),
      label TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      credential_hint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      accepting_jobs INTEGER NOT NULL DEFAULT 1,
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      daily_job_limit INTEGER NOT NULL DEFAULT 500,
      jobs_today INTEGER NOT NULL DEFAULT 0,
      jobs_today_date TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_nodes_account ON supplier_nodes(account_id);

    CREATE TABLE IF NOT EXISTS node_capabilities (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES supplier_nodes(id) ON DELETE CASCADE,
      auth_source_type TEXT NOT NULL CHECK (
        auth_source_type IN ('official_api', 'local_model', 'allowed_third_party', 'mock')
      ),
      provider_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE (node_id, provider_key, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_node_caps_node ON node_capabilities(node_id);

    CREATE TABLE IF NOT EXISTS node_heartbeats (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES supplier_nodes(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      active_jobs INTEGER NOT NULL DEFAULT 0,
      accepting_jobs INTEGER NOT NULL DEFAULT 1,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_node_hb_node ON node_heartbeats(node_id, at);

    CREATE TABLE IF NOT EXISTS inference_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'assigned', 'running', 'completed', 'failed', 'cancelled', 'timeout')
      ),
      assigned_node_id TEXT,
      result_text TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      platform_cost_points REAL,
      charged_points REAL,
      supplier_reward_points REAL,
      settlement_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (settlement_status IN ('pending', 'settled', 'skipped')),
      settlement_key TEXT UNIQUE,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      assigned_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      timeout_at INTEGER NOT NULL,
      payload_sha256 TEXT NOT NULL,
      signature TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON inference_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_node ON inference_jobs(assigned_node_id, status);

    CREATE TABLE IF NOT EXISTS job_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES inference_jobs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id);

    CREATE TABLE IF NOT EXISTS supplier_earnings (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      reward_points REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_earnings_account ON supplier_earnings(account_id, created_at);

    CREATE TABLE IF NOT EXISTS supplier_settlements (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      total_points REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'paid')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT,
      api_key TEXT NOT NULL UNIQUE,
      api_key_hint TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'supplier')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      points REAL NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_redemptions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES redeem_codes(code),
      user_id TEXT NOT NULL REFERENCES users(id),
      points REAL NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (code, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_user ON redeem_redemptions(user_id, created_at);

    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id, created_at);
  `);

  ensureColumns(db);
  return db;
}

export function db(): DatabaseSync {
  if (!globalForDb.__db || globalForDb.__dbSchemaVersion !== SCHEMA_VERSION) {
    try {
      globalForDb.__db?.close();
    } catch {
      // ignore
    }
    globalForDb.__db = open();
    globalForDb.__dbSchemaVersion = SCHEMA_VERSION;
  } else {
    ensureColumns(globalForDb.__db);
  }
  return globalForDb.__db;
}

export function newId(): string {
  return crypto.randomUUID();
}
