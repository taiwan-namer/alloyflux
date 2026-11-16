-- AlloyFlux / ai-usage-platform — Supabase (Postgres) schema
-- 在 Supabase SQL Editor 整份執行一次即可。

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
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
  official_cost_points DOUBLE PRECISION,
  charged_points DOUBLE PRECISION,
  quota_label TEXT,
  quota_used_pct DOUBLE PRECISION,
  quota_before_pct DOUBLE PRECISION,
  quota_after_pct DOUBLE PRECISION,
  upstream_model_version TEXT,
  job_id TEXT,
  created_at BIGINT NOT NULL
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
  monthly_cap_points DOUBLE PRECISION,
  share_limit_pct DOUBLE PRECISION NOT NULL DEFAULT 80,
  quota_json TEXT,
  quota_updated_at BIGINT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  -- 綁定此貨源的平台使用者（供給者／管理員）；派發仍用全部 enabled 貨源
  owner_user_id TEXT,
  -- 夥伴移除採軟刪：停派並從控制台隱藏，用量／分潤歷史仍可對帳
  removed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources(owner_user_id);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup', 'usage', 'source_usage', 'supplier_earn')),
  amount_points DOUBLE PRECISION NOT NULL,
  ref_id TEXT,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_usage_ref
  ON ledger(type, ref_id) WHERE type = 'usage' AND ref_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_earn_ref
  ON ledger(type, ref_id) WHERE type = 'supplier_earn' AND ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at BIGINT NOT NULL
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
  last_seen_at BIGINT,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
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
  at BIGINT NOT NULL,
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
  platform_cost_points DOUBLE PRECISION,
  charged_points DOUBLE PRECISION,
  supplier_reward_points DOUBLE PRECISION,
  settlement_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (settlement_status IN ('pending', 'settled', 'skipped')),
  settlement_key TEXT UNIQUE,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  assigned_at BIGINT,
  started_at BIGINT,
  completed_at BIGINT,
  timeout_at BIGINT NOT NULL,
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
  started_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id);

CREATE TABLE IF NOT EXISTS supplier_earnings (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  reward_points DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_account ON supplier_earnings(account_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_settlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  period_start BIGINT NOT NULL,
  period_end BIGINT NOT NULL,
  total_points DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'paid')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  api_key TEXT NOT NULL UNIQUE,
  api_key_hint TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'supplier')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  points DOUBLE PRECISION NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,
  note TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_redemptions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES redeem_codes(code),
  user_id TEXT NOT NULL REFERENCES users(id),
  points DOUBLE PRECISION NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_redeem_user ON redeem_redemptions(user_id, created_at);

CREATE TABLE IF NOT EXISTS user_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, updated_at);

-- 本串對話狀態筆記（不跟 8 輪視窗丟棄；每輪注入上游）
CREATE TABLE IF NOT EXISTS conversation_states (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  goal TEXT NOT NULL DEFAULT '',
  hard_constraints TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  covered_through_created_at BIGINT NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_states_updated
  ON conversation_states(updated_at);

-- 較早對話歷史摘要塊（整則批次吸收後落庫；注入時只帶最近幾塊）
CREATE TABLE IF NOT EXISTS conversation_history_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_created_at BIGINT NOT NULL,
  to_created_at BIGINT NOT NULL,
  from_message_id TEXT,
  to_message_id TEXT,
  summary_text TEXT NOT NULL,
  token_est INTEGER NOT NULL DEFAULT 0,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_history_summaries_conv
  ON conversation_history_summaries(conversation_id, to_created_at DESC);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id, created_at);
