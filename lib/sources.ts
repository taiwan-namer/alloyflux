import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, newId } from "./db";
import { decrypt, encrypt, hintOf } from "./crypto";
import type { ModelInfo } from "./models";
import {
  daysUntilSubscriptionExpiry,
  fetchSubscriptionQuota,
  isSubscriptionExpiringSoon,
  quotaWindowForModel,
  refreshOAuthCredentials,
  type OAuthCredentials,
  type SubscriptionQuota,
} from "./oauth";

export type SourceKind = "supplier" | "platform";
export type SourceProvider = "gemini" | "openai" | "anthropic" | "xai" | "openrouter";
export type SourceAuthType = "oauth_sub" | "api_key";

export interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  provider: SourceProvider;
  authType: SourceAuthType;
  keyHint: string;
  priority: number;
  monthlyCapPoints: number | null;
  shareLimitPct: number;
  quota: SubscriptionQuota | null;
  quotaUpdatedAt: number | null;
  enabled: boolean;
  fromEnv: boolean;
  /** 綁定此貨源的平台使用者 id；派發路由不依此過濾 */
  ownerUserId: string | null;
  /** 夥伴「移除」採軟刪：保留列以便分潤／用量歷史不消失 */
  removedAt: number | null;
  /** OAuth Token 已遷到供給者節點本機 */
  delegatedToNode?: boolean;
}

export interface SourceStatus extends Source {
  usedThisMonthPoints: number;
  cooldownUntil: number | null;
  lastError: string | null;
}

interface Health {
  cooldownUntil: number;
  lastError: string;
}

const globalForHealth = globalThis as unknown as { __health?: Map<string, Health> };
const health = (globalForHealth.__health ??= new Map<string, Health>());

const ENV_SOURCES: { provider: SourceProvider; env: string; label: string; priority: number }[] = [
  { provider: "gemini", env: "GEMINI_API_KEY", label: "平台直連 Gemini", priority: 1000 },
  { provider: "openai", env: "OPENAI_API_KEY", label: "平台直連 OpenAI", priority: 1000 },
  { provider: "anthropic", env: "ANTHROPIC_API_KEY", label: "平台直連 Anthropic", priority: 1000 },
  { provider: "xai", env: "XAI_API_KEY", label: "平台直連 xAI Grok", priority: 1000 },
  { provider: "openrouter", env: "OPENROUTER_API_KEY", label: "平台備援 OpenRouter", priority: 2000 },
];

interface SourceRow {
  id: string;
  label: string;
  kind: SourceKind;
  provider: SourceProvider;
  auth_type: SourceAuthType;
  encrypted_key: string;
  key_hint: string;
  priority: number;
  monthly_cap_points: number | null;
  share_limit_pct: number;
  quota_json: string | null;
  quota_updated_at: number | null;
  enabled: number;
  owner_user_id?: string | null;
  removed_at?: number | null;
}

const globalForOwnerCol = globalThis as unknown as { __sourcesOwnerColReady?: boolean };

/** 補欄位＋依 OAuth email 認領尚無主人的舊貨源 */
async function ensureSourcesOwnerColumn(): Promise<void> {
  if (globalForOwnerCol.__sourcesOwnerColReady) return;
  await db().exec("ALTER TABLE sources ADD COLUMN IF NOT EXISTS owner_user_id TEXT");
  await db().exec("ALTER TABLE sources ADD COLUMN IF NOT EXISTS removed_at BIGINT");
  await db().exec("CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources(owner_user_id)");
  try {
    // 舊 oauth 列：key_hint 形如 `email@x.com (Plan)` → 對應 users.email 認領
    await db().exec(`
      UPDATE sources s
      SET owner_user_id = u.id
      FROM users u
      WHERE s.owner_user_id IS NULL
        AND s.auth_type = 'oauth_sub'
        AND LOWER(s.key_hint) LIKE LOWER(u.email) || ' (%'
    `);
  } catch {
    // users 表尚未就緒時略過認領
  }
  globalForOwnerCol.__sourcesOwnerColReady = true;
}

function rowToSource(r: SourceRow): Source {
  let quota: SubscriptionQuota | null = null;
  if (r.quota_json) {
    try {
      quota = JSON.parse(r.quota_json) as SubscriptionQuota;
    } catch {
      quota = null;
    }
  }
  let delegatedToNode = false;
  if (r.auth_type === "oauth_sub") {
    try {
      const creds = JSON.parse(decrypt(r.encrypted_key)) as OAuthCredentials;
      delegatedToNode = Boolean(creds.delegatedToNode);
    } catch {
      delegatedToNode = false;
    }
  }
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    provider: r.provider,
    authType: r.auth_type ?? "api_key",
    keyHint: r.key_hint,
    priority: r.priority,
    monthlyCapPoints: r.monthly_cap_points,
    shareLimitPct: r.share_limit_pct ?? 80,
    quota,
    quotaUpdatedAt: r.quota_updated_at,
    enabled: r.enabled === 1,
    fromEnv: false,
    ownerUserId: r.owner_user_id ?? null,
    removedAt: r.removed_at != null ? Number(r.removed_at) : null,
    delegatedToNode,
  };
}

function envSources(): (Source & { secret: string })[] {
  return ENV_SOURCES.flatMap((s) => {
    const apiKey = process.env[s.env]?.trim();
    if (!apiKey) return [];
    return [
      {
        id: `env-${s.provider}`,
        label: s.label,
        kind: "platform" as const,
        provider: s.provider,
        authType: "api_key" as const,
        keyHint: hintOf(apiKey),
        priority: s.priority,
        monthlyCapPoints: null,
        shareLimitPct: 100,
        quota: null,
        quotaUpdatedAt: null,
        enabled: true,
        fromEnv: true,
        ownerUserId: null,
        removedAt: null,
        secret: apiKey,
      },
    ];
  });
}

async function dbSources(opts?: { includeRemoved?: boolean }): Promise<(Source & { resolveSecret: () => string })[]> {
  await ensureSourcesOwnerColumn();
  const rows = (await db()
    .prepare(
      opts?.includeRemoved
        ? "SELECT * FROM sources ORDER BY priority, created_at"
        : "SELECT * FROM sources WHERE removed_at IS NULL ORDER BY priority, created_at",
    )
    .all()) as unknown as SourceRow[];
  return rows.map((r) => ({ ...rowToSource(r), resolveSecret: () => decrypt(r.encrypted_key) }));
}

function monthStart(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

async function usedThisMonth(sourceId: string): Promise<number> {
  const row = (await db()
    .prepare(
      "SELECT COALESCE(SUM(amount_points), 0) AS used FROM ledger WHERE type = 'source_usage' AND ref_id = ? AND created_at >= ?",
    )
    .get(sourceId, monthStart())) as { used: number };
  return Number(row.used);
}

export async function listSources(): Promise<SourceStatus[]> {
  const all: Source[] = [
    ...(await dbSources()).map(({ resolveSecret: _k, ...s }) => s),
    ...envSources().map(({ secret: _k, ...s }) => s),
  ];
  const now = Date.now();
  // 一次查出本月用量，避免 N+1 把 admin／sources API 拖慢甚至逾時
  const usageRows = (await db()
    .prepare(
      `SELECT ref_id AS id, COALESCE(SUM(amount_points), 0) AS used
       FROM ledger
       WHERE type = 'source_usage' AND created_at >= ? AND ref_id IS NOT NULL
       GROUP BY ref_id`,
    )
    .all(monthStart())) as { id: string; used: number }[];
  const usedMap = new Map(usageRows.map((r) => [String(r.id), Number(r.used)]));
  return all.map((s) => {
    const h = health.get(s.id);
    return {
      ...s,
      usedThisMonthPoints: usedMap.get(s.id) ?? 0,
      cooldownUntil: h && h.cooldownUntil > now ? h.cooldownUntil : null,
      lastError: h?.lastError ?? null,
    };
  });
}

/** 供給者後台：僅自己的貨源；管理員看全部（含 env）；預設不含已移除 */
export async function listSourcesForUser(
  user: {
    id: string;
    isAdmin: boolean;
  },
  opts?: { includeRemoved?: boolean },
): Promise<SourceStatus[]> {
  const all = opts?.includeRemoved
    ? await listSourcesIncludingRemoved()
    : await listSources();
  if (user.isAdmin) {
    return opts?.includeRemoved ? all : all.filter((s) => !s.removedAt);
  }
  return all.filter((s) => !s.fromEnv && s.ownerUserId === user.id && (opts?.includeRemoved || !s.removedAt));
}

/** 含已軟刪節點（分潤／用量歷史用） */
export async function listSourcesIncludingRemoved(): Promise<SourceStatus[]> {
  await ensureSourcesOwnerColumn();
  const rows = (await db()
    .prepare("SELECT * FROM sources ORDER BY priority, created_at")
    .all()) as unknown as SourceRow[];
  const now = Date.now();
  const usageRows = (await db()
    .prepare(
      `SELECT ref_id AS id, COALESCE(SUM(amount_points), 0) AS used
       FROM ledger
       WHERE type = 'source_usage' AND created_at >= ? AND ref_id IS NOT NULL
       GROUP BY ref_id`,
    )
    .all(monthStart())) as { id: string; used: number }[];
  const usedMap = new Map(usageRows.map((r) => [String(r.id), Number(r.used)]));
  return rows.map((r) => {
    const s = rowToSource(r);
    const h = health.get(s.id);
    return {
      ...s,
      usedThisMonthPoints: usedMap.get(s.id) ?? 0,
      cooldownUntil: h && h.cooldownUntil > now ? h.cooldownUntil : null,
      lastError: h?.lastError ?? null,
    };
  });
}

export async function assertSourceOwnedBy(
  sourceId: string,
  user: { id: string; isAdmin: boolean },
): Promise<void> {
  await ensureSourcesOwnerColumn();
  const row = (await db()
    .prepare("SELECT owner_user_id FROM sources WHERE id = ?")
    .get(sourceId)) as { owner_user_id: string | null } | undefined;
  if (!row) throw Object.assign(new Error("找不到貨源"), { status: 404 });
  if (user.isAdmin) return;
  if (row.owner_user_id !== user.id) {
    throw Object.assign(new Error("無權操作此貨源"), { status: 403 });
  }
}

export async function addSource(input: {
  label: string;
  kind: SourceKind;
  provider: SourceProvider;
  apiKey: string;
  priority?: number;
  monthlyCapPoints?: number | null;
  ownerUserId?: string | null;
}): Promise<string> {
  await ensureSourcesOwnerColumn();
  const apiKey = input.apiKey.trim();
  const id = newId();
  await db()
    .prepare(
      `INSERT INTO sources (id, label, kind, provider, auth_type, encrypted_key, key_hint, priority, monthly_cap_points, share_limit_pct, enabled, created_at, owner_user_id)
       VALUES (?, ?, ?, ?, 'api_key', ?, ?, ?, ?, 100, 1, ?, ?)`,
    )
    .run(
      id,
      input.label.trim() || `${input.provider} ${hintOf(apiKey)}`,
      input.kind,
      input.provider,
      encrypt(apiKey),
      hintOf(apiKey),
      input.priority ?? (input.kind === "supplier" ? 200 : 1000),
      input.monthlyCapPoints ?? null,
      Date.now(),
      input.ownerUserId ?? null,
    );
  return id;
}

export async function addOAuthSubscriptionSource(input: {
  label?: string;
  creds: OAuthCredentials;
  shareLimitPct?: number;
  priority?: number;
  ownerUserId?: string | null;
}): Promise<{ id: string; quota: SubscriptionQuota }> {
  await ensureSourcesOwnerColumn();
  const quota = await fetchSubscriptionQuota(input.creds);
  const now = Date.now();
  const displayHint = input.creds.email
    ? `${input.creds.email} (${quota.planType})`
    : `${input.creds.provider.toUpperCase()} (${quota.planType})`;
  const defaultLabel =
    input.label?.trim() ||
    (input.creds.provider === "gemini"
      ? `Gemini 訂閱 ${input.creds.email ?? ""}`.trim()
      : input.creds.provider === "xai"
        ? `Grok 訂閱 ${input.creds.email ?? ""}`.trim()
        : `ChatGPT 訂閱 ${input.creds.email ?? ""}`.trim());

  // 同平台＋同帳號 email 重綁：優先覆寫「同一主人」或「尚無主人」的列，不搶別人的。
  // 不可寫 `OR ? IS NULL`：Postgres 無法推斷 null 參數型別 → could not determine data type of parameter $N
  if (input.creds.email) {
    const emailPrefix = `${input.creds.email.toLowerCase()} (`;
    const ownerId = input.ownerUserId?.trim() || null;
    const existing = (
      ownerId
        ? ((await db()
            .prepare(
              `SELECT id, label, share_limit_pct, owner_user_id FROM sources
               WHERE auth_type = 'oauth_sub' AND provider = ? AND LOWER(key_hint) LIKE ?
                 AND (owner_user_id IS NULL OR owner_user_id = ?)
               ORDER BY
                 CASE WHEN owner_user_id = ? THEN 0 WHEN owner_user_id IS NULL THEN 1 ELSE 2 END,
                 created_at DESC
               LIMIT 1`,
            )
            .get(input.creds.provider, `${emailPrefix}%`, ownerId, ownerId)) as
            | { id: string; label: string; share_limit_pct: number | null; owner_user_id: string | null }
            | undefined)
        : ((await db()
            .prepare(
              `SELECT id, label, share_limit_pct, owner_user_id FROM sources
               WHERE auth_type = 'oauth_sub' AND provider = ? AND LOWER(key_hint) LIKE ?
                 AND owner_user_id IS NULL
               ORDER BY created_at DESC
               LIMIT 1`,
            )
            .get(input.creds.provider, `${emailPrefix}%`)) as
            | { id: string; label: string; share_limit_pct: number | null; owner_user_id: string | null }
            | undefined)
    );

    if (existing) {
      // 若已有主人且不是目前使用者，略過覆寫（理論上 WHERE 已擋；雙重保險）
      if (existing.owner_user_id && ownerId && existing.owner_user_id !== ownerId) {
        // fall through to insert
      } else {
        await db()
          .prepare(
            `UPDATE sources
             SET label = ?, encrypted_key = ?, key_hint = ?, share_limit_pct = ?,
                 quota_json = ?, quota_updated_at = ?, enabled = 1,
                 owner_user_id = COALESCE(CAST(? AS TEXT), owner_user_id)
             WHERE id = ?`,
          )
          .run(
            input.label?.trim() || existing.label || defaultLabel,
            encrypt(JSON.stringify(input.creds)),
            displayHint,
            input.shareLimitPct ?? existing.share_limit_pct ?? 80,
            JSON.stringify(quota),
            now,
            ownerId,
            existing.id,
          );
        health.delete(existing.id);
        return { id: existing.id, quota };
      }
    }
  }

  const id = newId();
  const ownerIdForInsert = input.ownerUserId?.trim() || null;
  await db()
    .prepare(
      `INSERT INTO sources (id, label, kind, provider, auth_type, encrypted_key, key_hint, priority, monthly_cap_points, share_limit_pct, quota_json, quota_updated_at, enabled, created_at, owner_user_id)
       VALUES (?, ?, 'supplier', ?, 'oauth_sub', ?, ?, ?, NULL, ?, ?, ?, 1, ?, CAST(? AS TEXT))`,
    )
    .run(
      id,
      defaultLabel,
      input.creds.provider,
      encrypt(JSON.stringify(input.creds)),
      displayHint,
      input.priority ?? 50,
      input.shareLimitPct ?? 80,
      JSON.stringify(quota),
      now,
      now,
      ownerIdForInsert,
    );
  health.delete(id);
  return { id, quota };
}

export async function saveUpdatedOAuthCreds(sourceId: string, creds: OAuthCredentials): Promise<void> {
  // 節點進程：只寫本機憑證檔，絕不把 Token 寫回平台
  if (process.env.SUPPLIER_NODE_MODE === "1") {
    const dir = path.join(process.cwd(), "data", "node-creds");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sourceId}.json`), JSON.stringify({ ...creds, delegatedToNode: false }, null, 2));
    return;
  }
  // 平台已委託：禁止把 Token 寫回 DB
  try {
    const row = (await db().prepare("SELECT encrypted_key FROM sources WHERE id = ?").get(sourceId)) as
      | { encrypted_key: string }
      | undefined;
    if (row) {
      const existing = JSON.parse(decrypt(row.encrypted_key)) as OAuthCredentials;
      if (existing.delegatedToNode) return;
    }
  } catch {
    // continue normal save
  }
  await db()
    .prepare("UPDATE sources SET encrypted_key = ? WHERE id = ?")
    .run(encrypt(JSON.stringify(creds)), sourceId);
  health.delete(sourceId);
}

export async function readOAuthCreds(sourceId: string): Promise<OAuthCredentials | null> {
  const row = (await db().prepare("SELECT encrypted_key, auth_type FROM sources WHERE id = ?").get(sourceId)) as
    | { encrypted_key: string; auth_type: string }
    | undefined;
  if (!row || row.auth_type !== "oauth_sub") return null;
  try {
    return JSON.parse(decrypt(row.encrypted_key)) as OAuthCredentials;
  } catch {
    return null;
  }
}

export async function isSourceDelegatedToNode(sourceId: string): Promise<boolean> {
  const creds = await readOAuthCreds(sourceId);
  return Boolean(creds?.delegatedToNode);
}

/** 節點領取憑證後，平台清除 Token，只留 metadata */
export async function claimOAuthCredsForNode(sourceId: string): Promise<OAuthCredentials | null> {
  const creds = await readOAuthCreds(sourceId);
  if (!creds || creds.delegatedToNode) return null;
  if (!creds.accessToken && !creds.refreshToken) return null;

  const stub: OAuthCredentials = {
    provider: creds.provider,
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    email: creds.email,
    accountId: creds.accountId,
    projectId: creds.projectId,
    planType: creds.planType,
    delegatedToNode: true,
  };
  // 直接寫 stub，避開 saveUpdatedOAuthCreds 的「已委託不寫回」防護
  await db()
    .prepare("UPDATE sources SET encrypted_key = ?, key_hint = ? WHERE id = ?")
    .run(
      encrypt(JSON.stringify(stub)),
      `${creds.email ?? creds.provider}（憑證在供給者節點）`,
      sourceId,
    );
  return creds;
}

export async function saveSourceQuota(sourceId: string, quota: SubscriptionQuota): Promise<void> {
  // 節點／本機 Live E2E：不寫回平台 DB
  if (process.env.SUPPLIER_NODE_MODE === "1") return;
  await db()
    .prepare("UPDATE sources SET quota_json = ?, quota_updated_at = ? WHERE id = ?")
    .run(JSON.stringify(quota), Date.now(), sourceId);
}

export async function syncSourceQuotaById(sourceId: string): Promise<SubscriptionQuota | null> {
  if (process.env.SUPPLIER_NODE_MODE === "1") return null;
  const row = (await db().prepare("SELECT * FROM sources WHERE id = ?").get(sourceId)) as unknown as
    | SourceRow
    | undefined;
  if (!row || row.auth_type !== "oauth_sub") return null;
  let creds = JSON.parse(decrypt(row.encrypted_key)) as OAuthCredentials;
  if (creds.delegatedToNode) {
    // Token 在節點；平台無法代查，保留上次 quota_json
    return row.quota_json ? (JSON.parse(row.quota_json) as SubscriptionQuota) : null;
  }
  try {
    if (creds.expiresAt && creds.expiresAt - Date.now() < 5 * 60_000 && creds.refreshToken) {
      creds = await refreshOAuthCredentials(creds);
      await saveUpdatedOAuthCreds(sourceId, creds);
    }
  } catch {
    // refresh 失敗先仍嘗試用現有 access token 查用量；兩邊都掛才標失效
  }
  const quota = await fetchSubscriptionQuota(creds);
  await saveSourceQuota(sourceId, quota);

  const expired =
    typeof quota.subscriptionExpiresAt === "string" &&
    Number.isFinite(Date.parse(quota.subscriptionExpiresAt)) &&
    Date.parse(quota.subscriptionExpiresAt) < Date.now() - 86_400_000; // 寬限 1 天，避免時區誤殺
  // 僅在「明確退訂」或「用量＋授權都失敗」時停用；unknown／單一端點 401 不砍
  const shouldDisable =
    quota.subscriptionStatus === "auth_failed" ||
    (quota.subscriptionActive === false && quota.subscriptionStatus === "inactive") ||
    expired;
  const healthy =
    quota.subscriptionStatus !== "auth_failed" &&
    quota.subscriptionActive !== false &&
    (quota.windows?.length ?? 0) > 0;

  if (shouldDisable && row.enabled) {
    await db().prepare("UPDATE sources SET enabled = 0 WHERE id = ?").run(sourceId);
  } else if (healthy && !row.enabled) {
    // 誤殺後若用量恢復正常，自動重新啟用
    await db().prepare("UPDATE sources SET enabled = 1 WHERE id = ?").run(sourceId);
  }
  return quota;
}

export async function syncAllSubscriptionQuotas(): Promise<void> {
  // 含已停用的訂閱節點：可藉成功同步自動恢復
  const rows = (await db()
    .prepare("SELECT id FROM sources WHERE auth_type = 'oauth_sub'")
    .all()) as { id: string }[];
  await Promise.allSettled(rows.map((r) => syncSourceQuotaById(r.id)));
}

export async function updateSource(
  id: string,
  patch: { enabled?: boolean; priority?: number; monthlyCapPoints?: number | null; shareLimitPct?: number },
): Promise<void> {
  if (patch.enabled !== undefined)
    await db().prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
  if (patch.priority !== undefined)
    await db().prepare("UPDATE sources SET priority = ? WHERE id = ?").run(patch.priority, id);
  if (patch.monthlyCapPoints !== undefined)
    await db().prepare("UPDATE sources SET monthly_cap_points = ? WHERE id = ?").run(patch.monthlyCapPoints, id);
  if (patch.shareLimitPct !== undefined)
    await db().prepare("UPDATE sources SET share_limit_pct = ? WHERE id = ?").run(patch.shareLimitPct, id);
}

/** 夥伴移除＝軟刪：停派並隱藏，保留列讓已產生分潤／用量對帳不歸零 */
export async function deleteSource(id: string): Promise<void> {
  await ensureSourcesOwnerColumn();
  const now = Date.now();
  await db()
    .prepare(`UPDATE sources SET enabled = 0, removed_at = ? WHERE id = ? AND removed_at IS NULL`)
    .run(now, id);
  health.delete(id);
}

export interface Candidate {
  source: Source;
  apiKey?: string;
  oauthCreds?: OAuthCredentials;
}

/**
 * 派發順序：
 * 1. 供給者 OAuth 訂閱帳號（優先使用且檢查已用 % 未超過供給者設定的 shareLimitPct）
 * 2. 供給者 API Key
 * 3. 平台直連 API Key
 * 4. OpenRouter 備援
 * 另：已知即將到期（≤7 天）的訂閱節點優先消化剩餘容量
 */
export async function candidatesFor(model: ModelInfo): Promise<Candidate[]> {
  const now = Date.now();
  const pool: { source: Source; resolveSecret: () => string }[] = [
    ...(await dbSources()).map(({ resolveSecret, ...source }) => ({ source, resolveSecret })),
    ...envSources().map(({ secret, ...source }) => ({ source, resolveSecret: () => secret })),
  ];

  // 先套用不需查 DB 的過濾，再只對有月上限的貨源查本月用量（async，不能放在 filter callback 內）
  const eligible = pool
    .filter(({ source: s }) => {
      if (!s.enabled) return false;
      if (model.category === "node-agent") return false;
      if (s.provider === "openrouter") return true;
      // 僅明確 auth_failed 才跳過；勿因 accounts/check 誤判 inactive 而整組不派發
      if (s.authType === "oauth_sub" && s.quota?.subscriptionStatus === "auth_failed") {
        return false;
      }
      // Antigravity 訂閱貨源可跑目錄內 Gemini／Claude／GPT-OSS（研究／備援；買家主線走 Node Agent）
      if (model.antigravityId && s.provider === "gemini" && s.authType === "oauth_sub") return true;
      // Grok 訂閱只走 xAI OAuth／xAI API（OpenRouter 已在上方放行）
      if (model.category === "grok") return s.provider === "xai";
      // 純 Antigravity 第三方模型：不要誤打到 Anthropic／OpenAI API Key（除非 OpenRouter）
      if (model.category === "antigravity-claude" || model.category === "antigravity-gpt") return false;
      return s.provider === model.provider;
    })
    .filter(({ source: s }) => (health.get(s.id)?.cooldownUntil ?? 0) <= now);

  const underCap = await Promise.all(
    eligible.map(async ({ source: s }) => {
      if (s.monthlyCapPoints === null) return true;
      return (await usedThisMonth(s.id)) < s.monthlyCapPoints;
    }),
  );

  return eligible
    .filter((_, i) => underCap[i])
    .filter(({ source: s }) => {
      if (s.authType === "oauth_sub" && s.quota) {
        // 依「使用者選的模型」對應配額窗熔斷（Argon／Gemini 總額／Claude·GPT 第三方）
        const w = quotaWindowForModel(s.quota, model.antigravityId ?? model.id);
        if (!w) return true;
        return w.usedPercent < s.shareLimitPct;
      }
      return true;
    })
    .sort((a, b) => {
      // 1. 供給者優先於平台
      if (a.source.kind !== b.source.kind) return a.source.kind === "supplier" ? -1 : 1;
      // 2. OAuth 訂閱帳號優先於 API Key
      if (a.source.authType !== b.source.authType) return a.source.authType === "oauth_sub" ? -1 : 1;
      // 3. 即將到期（≤7 天）優先；越近到期越前，把剩餘容量用掉
      const expA = isSubscriptionExpiringSoon(a.source.quota);
      const expB = isSubscriptionExpiringSoon(b.source.quota);
      if (expA !== expB) return expA ? -1 : 1;
      if (expA && expB) {
        const dA = daysUntilSubscriptionExpiry(a.source.quota) ?? 999;
        const dB = daysUntilSubscriptionExpiry(b.source.quota) ?? 999;
        if (dA !== dB) return dA - dB;
      }
      // 4. 優先序數字小的先
      if (a.source.priority !== b.source.priority) return a.source.priority - b.source.priority;
      // 5. 該模型剩餘額度較多的訂閱帳號優先
      const remA =
        (a.source.quota && quotaWindowForModel(a.source.quota, model.antigravityId ?? model.id)?.remainingPercent) ??
        a.source.quota?.primaryRemainingPercent ??
        50;
      const remB =
        (b.source.quota && quotaWindowForModel(b.source.quota, model.antigravityId ?? model.id)?.remainingPercent) ??
        b.source.quota?.primaryRemainingPercent ??
        50;
      return remB - remA;
    })
    .map(({ source, resolveSecret }) => {
      const raw = resolveSecret();
      if (source.authType === "oauth_sub") {
        const oauthCreds = JSON.parse(raw) as OAuthCredentials;
        return { source, oauthCreds };
      }
      return { source, apiKey: raw };
    })
    // 已清空 Token／委託節點後未回填的貨源不可派發，避免搶在有效訂閱前面秒失敗
    .filter((c) => {
      if (c.source.authType !== "oauth_sub") return true;
      if (c.oauthCreds?.delegatedToNode) return false;
      return Boolean(c.oauthCreds?.accessToken || c.oauthCreds?.refreshToken);
    });
}

/** 重新綁定／同步成功後清除冷卻，避免舊 401 把新 Token 鎖 5 分鐘 */
export function clearSourceCooldown(sourceId: string): void {
  health.delete(sourceId);
}

export function markFailure(sourceId: string, status: number, message: string): void {
  // 客戶端停止／中止不應把貨源打進冷卻（雙保險；gateway 層已應攔截）
  if (status === 499 || /aborted|abort|client aborted|cancelled/i.test(message)) return;
  const cooldownMs = status === 401 || status === 403 ? 5 * 60_000 : status === 429 || status === 402 ? 60_000 : 30_000;
  health.set(sourceId, { cooldownUntil: Date.now() + cooldownMs, lastError: `${status} ${message}`.slice(0, 300) });
}

export function markSuccess(sourceId: string): void {
  health.delete(sourceId);
}
