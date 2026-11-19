import { db, newId } from "./db";
import { MODELS } from "./models";
import {
  CHATGPT_OAUTH,
  GROK_OAUTH,
  fetchAntigravityAvailableModels,
  grokProxyHeaders,
  refreshOAuthCredentials,
  type OAuthCredentials,
} from "./oauth";
import { listSources, readOAuthCreds, saveUpdatedOAuthCreds } from "./sources";

export type CatalogFamily = "gemini" | "chatgpt" | "grok" | "claude";

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  family: CatalogFamily;
  sourceLabel?: string;
}

export interface FamilyRefreshResult {
  family: CatalogFamily;
  ok: boolean;
  error?: string;
  discovered: DiscoveredModel[];
  matchedCatalogIds: string[];
  /** 上游有、但平台 MODELS 尚未登錄 */
  newUpstreamIds: string[];
  /** 平台有登錄、但這次探測未見到 */
  missingUpstreamIds: string[];
}

export interface ModelCatalogRefreshReport {
  fetchedAt: number;
  families: FamilyRefreshResult[];
  summary: {
    discovered: number;
    newUpstream: number;
    matched: number;
    missing: number;
  };
}

async function ensureSnapshotTable(): Promise<void> {
  try {
    await db().exec(`
      CREATE TABLE IF NOT EXISTS model_catalog_snapshots (
        id TEXT PRIMARY KEY,
        fetched_at BIGINT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_catalog_snapshots_at
        ON model_catalog_snapshots(fetched_at DESC);
    `);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/model_catalog_snapshots|does not exist|relation/i.test(msg)) throw e;
  }
}

export async function saveModelCatalogSnapshot(report: ModelCatalogRefreshReport): Promise<void> {
  await ensureSnapshotTable();
  await db()
    .prepare(
      `INSERT INTO model_catalog_snapshots (id, fetched_at, payload_json) VALUES (?, ?, ?)`,
    )
    .run(newId(), report.fetchedAt, JSON.stringify(report));
}

export async function latestModelCatalogSnapshot(): Promise<ModelCatalogRefreshReport | null> {
  await ensureSnapshotTable();
  try {
    const row = (await db()
      .prepare(
        `SELECT payload_json FROM model_catalog_snapshots ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get()) as { payload_json: string } | undefined;
    if (!row?.payload_json) return null;
    return JSON.parse(row.payload_json) as ModelCatalogRefreshReport;
  } catch {
    return null;
  }
}

async function freshCreds(sourceId: string, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (creds.expiresAt && creds.expiresAt - Date.now() < 5 * 60_000 && creds.refreshToken) {
    const next = await refreshOAuthCredentials(creds);
    await saveUpdatedOAuthCreds(sourceId, next);
    return next;
  }
  return creds;
}

function catalogWireIds(family: CatalogFamily): string[] {
  if (family === "gemini") {
    return MODELS.filter((m) => m.antigravityId && m.category === "gemini").map((m) => m.antigravityId!);
  }
  if (family === "claude") {
    return MODELS.filter((m) => m.antigravityId && m.category.startsWith("antigravity")).map(
      (m) => m.antigravityId!,
    );
  }
  if (family === "chatgpt") {
    return MODELS.filter((m) => m.codexId).map((m) => m.codexId!);
  }
  return MODELS.filter((m) => m.grokId).map((m) => m.grokId!);
}

function diffFamily(
  family: CatalogFamily,
  discovered: DiscoveredModel[],
  ok: boolean,
  error?: string,
): FamilyRefreshResult {
  const upstream = new Set(discovered.map((d) => d.id));
  const catalog = catalogWireIds(family);
  const matchedCatalogIds = catalog.filter((id) => upstream.has(id));
  const missingUpstreamIds = catalog.filter((id) => !upstream.has(id));
  const catalogSet = new Set(catalog);
  const newUpstreamIds = [...upstream].filter((id) => !catalogSet.has(id));
  return {
    family,
    ok,
    error,
    discovered,
    matchedCatalogIds,
    newUpstreamIds,
    missingUpstreamIds: ok ? missingUpstreamIds : [],
  };
}

async function refreshAntigravityFamilies(): Promise<{
  gemini: FamilyRefreshResult;
  claude: FamilyRefreshResult;
}> {
  const sources = (await listSources()).filter(
    (s) => s.enabled && s.authType === "oauth_sub" && s.provider === "gemini" && !s.removedAt,
  );
  if (!sources.length) {
    const empty = diffFamily("gemini", [], false, "沒有啟用中的 Google／Antigravity OAuth 水庫");
    const emptyClaude = diffFamily("claude", [], false, "沒有啟用中的 Google／Antigravity OAuth 水庫");
    return { gemini: empty, claude: emptyClaude };
  }

  const geminiDisc: DiscoveredModel[] = [];
  const claudeDisc: DiscoveredModel[] = [];
  const errors: string[] = [];

  for (const s of sources.slice(0, 8)) {
    try {
      let creds = await readOAuthCreds(s.id);
      if (!creds || creds.delegatedToNode) {
        errors.push(`${s.label}: 憑證在節點或無法讀取`);
        continue;
      }
      creds = await freshCreds(s.id, creds);
      const catalog = await fetchAntigravityAvailableModels(creds, { allowDailyFallback: true });
      for (const [id, meta] of Object.entries(catalog)) {
        const row: DiscoveredModel = {
          id,
          displayName: meta.displayName,
          family: /claude|gpt-oss|\bgpt\b/i.test(id) ? "claude" : "gemini",
          sourceLabel: s.label,
        };
        if (row.family === "claude") claudeDisc.push(row);
        else geminiDisc.push(row);
      }
    } catch (e) {
      errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const uniq = (rows: DiscoveredModel[]) => {
    const map = new Map<string, DiscoveredModel>();
    for (const r of rows) map.set(r.id, r);
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  };

  const geminiOk = geminiDisc.length > 0;
  const claudeOk = claudeDisc.length > 0 || geminiOk; // 同一目錄；沒有 Claude 也可能只是帳號沒開
  return {
    gemini: diffFamily(
      "gemini",
      uniq(geminiDisc),
      geminiOk,
      geminiOk ? undefined : errors[0] || "Antigravity 目錄為空",
    ),
    claude: diffFamily(
      "claude",
      uniq(claudeDisc),
      claudeOk,
      claudeOk ? undefined : errors[0] || "Antigravity 目錄無 Claude／GPT-OSS",
    ),
  };
}

async function refreshChatGptFamily(): Promise<FamilyRefreshResult> {
  const sources = (await listSources()).filter(
    (s) => s.enabled && s.authType === "oauth_sub" && s.provider === "openai" && !s.removedAt,
  );
  if (!sources.length) {
    return diffFamily("chatgpt", [], false, "沒有啟用中的 ChatGPT OAuth 水庫");
  }

  const discovered: DiscoveredModel[] = [];
  const errors: string[] = [];

  for (const s of sources.slice(0, 5)) {
    try {
      let creds = await readOAuthCreds(s.id);
      if (!creds || creds.delegatedToNode) {
        errors.push(`${s.label}: 憑證在節點或無法讀取`);
        continue;
      }
      creds = await freshCreds(s.id, creds);
      const url = `${CHATGPT_OAUTH.codexBaseUrl}/codex/models`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "User-Agent": CHATGPT_OAUTH.userAgent,
          Accept: "application/json",
          ...(creds.accountId ? { "ChatGPT-Account-ID": creds.accountId } : {}),
        },
      });
      if (!res.ok) {
        errors.push(`${s.label}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
        continue;
      }
      const data = (await res.json()) as
        | { models?: { id?: string; slug?: string; name?: string }[] }
        | { data?: { id?: string; slug?: string; name?: string }[] }
        | Record<string, unknown>;
      const list = Array.isArray((data as { models?: unknown }).models)
        ? (data as { models: { id?: string; slug?: string; name?: string }[] }).models
        : Array.isArray((data as { data?: unknown }).data)
          ? (data as { data: { id?: string; slug?: string; name?: string }[] }).data
          : [];
      for (const m of list) {
        const id = (m.id || m.slug || "").trim();
        if (!id) continue;
        discovered.push({
          id,
          displayName: m.name || id,
          family: "chatgpt",
          sourceLabel: s.label,
        });
      }
      // 若目錄 API 結構未對上，至少回報硬編碼候選仍可對照
      if (!list.length) {
        for (const id of catalogWireIds("chatgpt")) {
          discovered.push({ id, family: "chatgpt", sourceLabel: `${s.label}（catalog fallback）` });
        }
        errors.push(`${s.label}: /codex/models 無模型列，改以平台清單對照`);
      }
    } catch (e) {
      errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const map = new Map<string, DiscoveredModel>();
  for (const d of discovered) map.set(d.id, d);
  const uniq = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  return diffFamily(
    "chatgpt",
    uniq,
    uniq.length > 0,
    uniq.length ? undefined : errors[0] || "ChatGPT 模型目錄探測失敗",
  );
}

async function refreshGrokFamily(): Promise<FamilyRefreshResult> {
  const sources = (await listSources()).filter(
    (s) => s.enabled && s.authType === "oauth_sub" && s.provider === "xai" && !s.removedAt,
  );
  if (!sources.length) {
    return diffFamily("grok", [], false, "沒有啟用中的 Grok OAuth 水庫");
  }

  const discovered: DiscoveredModel[] = [];
  const errors: string[] = [];
  const known = catalogWireIds("grok");

  for (const s of sources.slice(0, 3)) {
    try {
      let creds = await readOAuthCreds(s.id);
      if (!creds || creds.delegatedToNode) {
        errors.push(`${s.label}: 憑證在節點或無法讀取`);
        continue;
      }
      creds = await freshCreds(s.id, creds);
      // Grok CLI 無穩定公開 models list；以平台已知 id 對 auth/user 探測存活
      const probeUrl = `${GROK_OAUTH.issuer.replace(/\/$/, "")}/user`;
      const res = await fetch(probeUrl, {
        headers: {
          ...grokProxyHeaders(creds.accessToken),
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        errors.push(`${s.label}: 帳號探測 HTTP ${res.status}`);
        continue;
      }
      for (const id of known) {
        discovered.push({
          id,
          family: "grok",
          displayName: id,
          sourceLabel: `${s.label}（帳號可用；Grok 無公開 models list）`,
        });
      }
    } catch (e) {
      errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const map = new Map<string, DiscoveredModel>();
  for (const d of discovered) map.set(d.id, d);
  const uniq = [...map.values()];
  return diffFamily(
    "grok",
    uniq,
    uniq.length > 0,
    uniq.length ? undefined : errors[0] || "Grok 探測失敗（官方尚無穩定 models list）",
  );
}

/** 一鍵探測四大訂閱池上游目錄，與平台 MODELS 對照 */
export async function refreshAllModelCatalogs(): Promise<ModelCatalogRefreshReport> {
  const [agy, chatgpt, grok] = await Promise.all([
    refreshAntigravityFamilies(),
    refreshChatGptFamily(),
    refreshGrokFamily(),
  ]);
  const families = [agy.gemini, chatgpt, grok, agy.claude];
  const report: ModelCatalogRefreshReport = {
    fetchedAt: Date.now(),
    families,
    summary: {
      discovered: families.reduce((n, f) => n + f.discovered.length, 0),
      newUpstream: families.reduce((n, f) => n + f.newUpstreamIds.length, 0),
      matched: families.reduce((n, f) => n + f.matchedCatalogIds.length, 0),
      missing: families.reduce((n, f) => n + f.missingUpstreamIds.length, 0),
    },
  };
  try {
    await saveModelCatalogSnapshot(report);
  } catch {
    // 探測結果仍回傳；寫庫失敗不擋 admin
  }
  return report;
}
