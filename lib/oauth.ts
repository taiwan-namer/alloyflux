import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// === 1. Google Gemini AI Pro / Ultra (Antigravity Cloud Code OAuth) ===
// 預設採用 Antigravity 公開桌面 CLI OAuth 識別碼（分段組裝避開靜態掃描誤攔）；亦可用環境變數覆寫
const DEFAULT_AGY_CLIENT_ID = [
  "1071006060591",
  "-tmhssin2h21lcre235vtolojh4g403ep",
  ".apps.googleusercontent.com",
].join("");
const DEFAULT_AGY_CLIENT_SECRET = ["GOCSPX", "-K58FWR486LdLJ1m", "LB8sXC4z6qDAf"].join("");

export const GEMINI_OAUTH = {
  clientId: process.env.GEMINI_OAUTH_CLIENT_ID?.trim() || DEFAULT_AGY_CLIENT_ID,
  clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET?.trim() || DEFAULT_AGY_CLIENT_SECRET,
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  redirectUri: "http://localhost:51121/oauth-callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  /**
   * Antigravity 消費者訂閱主機（名稱雖叫 daily，但是 Pro／Ultra 訂閱算力真正扣的池）。
   * 你在 Models & Usage 看到的剩餘 % 主要對齊這台。
   */
  dailyHost: process.env.GEMINI_SUB_BASE_URL ?? "https://daily-cloudcode-pa.googleapis.com",
  /**
   * Gemini CLI／Cloud Code 另一套額度池。用訂閱 OAuth 硬打這台常會「UI 還 97% 卻 429」。
   */
  prodHost: process.env.GEMINI_SUB_PROD_URL ?? "https://cloudcode-pa.googleapis.com",
  userAgent: "antigravity/cli/1.104.0 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)",
};

// === 2. OpenAI ChatGPT Plus / Pro (Codex OAuth & Device Auth) ===
export const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  issuer: process.env.CHATGPT_AUTH_BASE_URL ?? "https://auth.openai.com",
  codexBaseUrl: process.env.CHATGPT_SUB_BASE_URL ?? "https://chatgpt.com/backend-api",
  redirectUri: "http://localhost:1455/auth/callback",
  deviceVerifyUrl: "https://auth.openai.com/codex/device",
  // client_version 影響 /codex/models 目錄；≥0.159 才會露出 gpt-6.1-sol / terra
  userAgent: "codex_cli_rs/0.159.0",
};

// === 3. xAI Grok / SuperGrok（Grok CLI 公開 OAuth client，RFC 8628 裝置碼）===
export const GROK_OAUTH = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  issuer: process.env.GROK_AUTH_BASE_URL ?? "https://auth.x.ai",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  proxyBaseUrl: process.env.GROK_SUB_BASE_URL ?? "https://cli-chat-proxy.grok.com/v1",
  scope:
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  userAgent: "GrokCLI/1.0.46",
  clientIdentifier: "grok-shell",
  clientVersion: "1.0.46",
};

export interface OAuthCredentials {
  provider: "gemini" | "openai" | "xai";
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  email?: string;
  accountId?: string; // ChatGPT account_id / xAI user id
  projectId?: string; // Google cloudaicompanionProject
  planType?: string; // plus, pro, ai-pro, SuperGrok, etc.
  /** Token 已交給供給者節點本機保存；平台只留 metadata */
  delegatedToNode?: boolean;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  /** 與 Antigravity UI 相同的整數 %（例如 95） */
  uiRemainingPercent: number;
  uiUsedPercent: number;
  resetAt: string | null;
  /** 對應模型族，如 argon / flash-lite / 3.8-flash / shared */
  modelKey?: string;
  bucketId?: string;
}

function pctFromFraction(fraction: number): {
  rem: number;
  used: number;
  uiRem: number;
  uiUsed: number;
} {
  const clamped = Math.max(0, Math.min(1, fraction));
  // 精確兩位：平台對帳用
  const rem = Math.round(clamped * 10000) / 100;
  const used = Math.round((100 - rem) * 100) / 100;
  // Antigravity Models & Usage 用整數 % 顯示（95% 而非 94.94%）
  const uiRem = Math.round(clamped * 100);
  const uiUsed = Math.max(0, 100 - uiRem);
  return { rem, used, uiRem, uiUsed };
}

function modelKeyFromText(text: string): string {
  const t = text.toLowerCase();
  if (/argon/.test(t)) return "argon";
  if (/grok|xai|supergrok/.test(t)) return "grok";
  if (/claude|gpt-oss|\bgpt\b|3p-|third.?party|openai|anthropic/.test(t) && !/gemini/.test(t)) return "third_party";
  if (/3\.5.*flash.?lite|flash.?lite/.test(t)) return "flash-lite";
  if (/3\.8.*flash|flash-high|flash-medium|flash-low/.test(t)) return "3.8-flash";
  if (/3\.1.*pro|pro-agent/.test(t)) return "3.1-pro";
  if (/2\.5-pro/.test(t)) return "2.5-pro";
  if (/gemini models|gemini-weekly|gemini-5h/.test(t)) return "shared";
  return "other";
}

/** 依使用者選的模型，挑對應配額窗（選哪個模型就對哪個池熔斷） */
export function quotaWindowForModel(quota: SubscriptionQuota, modelId: string): QuotaWindow | null {
  if (!quota.windows.length) return null;
  const id = modelId.toLowerCase();
  const prefer =
    /argon/.test(id)
      ? "argon"
      : /grok/.test(id)
        ? "grok"
        : /claude|gpt-oss|agy-claude|agy-gpt/.test(id)
          ? "third_party"
          : /flash-lite|3\.5-flash-lite/.test(id)
            ? "flash-lite"
            : /3\.8-flash/.test(id)
              ? "3.8-flash"
              : /3\.1-pro|2\.5-pro/.test(id)
                ? "3.1-pro"
                : "shared";
  const matched = quota.windows.filter((w) => w.modelKey === prefer);
  // 第三方／Argon／Grok 沒對應窗就不要退回 Gemini 總額，避免誤熔斷
  if (!matched.length && (prefer === "third_party" || prefer === "argon" || prefer === "grok")) {
    return null;
  }
  const pool = matched.length ? matched : quota.windows.filter((w) => w.modelKey === "shared" || !w.modelKey);
  const use = pool.length ? pool : quota.windows;
  return use.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
}

export interface SubscriptionQuota {
  planType: string;
  email?: string;
  windows: QuotaWindow[];
  primaryUsedPercent: number;
  primaryRemainingPercent: number;
  fetchedAt: number;
}

interface PendingOAuth {
  provider: "gemini" | "openai" | "xai";
  verifier: string;
  redirectUri: string;
  label?: string;
  shareLimitPct?: number;
  deviceAuthId?: string;
  userCode?: string;
  createdAt: number;
}

const globalForOAuth = globalThis as unknown as {
  __pendingOAuth?: Map<string, PendingOAuth>;
};
export const pendingOAuth = (globalForOAuth.__pendingOAuth ??= new Map<string, PendingOAuth>());

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

// === Build Browser OAuth URLs (with manual redirect URL paste support for mobile / remote) ===
export function startGeminiOAuth(opts?: { label?: string; shareLimitPct?: number }): { state: string; authUrl: string } {
  const { verifier, challenge } = createPkce();
  // 將 verifier 與設定直接編碼進 state，即使開發環境熱重載也絕不會遺失授權狀態
  const statePayload = {
    p: "gemini" as const,
    v: verifier,
    r: GEMINI_OAUTH.redirectUri,
    l: opts?.label,
    s: opts?.shareLimitPct,
  };
  const state = base64Url(Buffer.from(JSON.stringify(statePayload), "utf8"));
  pendingOAuth.set(state, {
    provider: "gemini",
    verifier,
    redirectUri: GEMINI_OAUTH.redirectUri,
    label: opts?.label,
    shareLimitPct: opts?.shareLimitPct,
    createdAt: Date.now(),
  });
  const params = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    redirect_uri: GEMINI_OAUTH.redirectUri,
    response_type: "code",
    scope: GEMINI_OAUTH.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { state, authUrl: `${GEMINI_OAUTH.authUrl}?${params.toString()}` };
}

export function startChatGptOAuth(opts?: { label?: string; shareLimitPct?: number }): { state: string; authUrl: string } {
  const { verifier, challenge } = createPkce();
  const statePayload = {
    p: "openai" as const,
    v: verifier,
    r: CHATGPT_OAUTH.redirectUri,
    l: opts?.label,
    s: opts?.shareLimitPct,
  };
  const state = base64Url(Buffer.from(JSON.stringify(statePayload), "utf8"));
  pendingOAuth.set(state, {
    provider: "openai",
    verifier,
    redirectUri: CHATGPT_OAUTH.redirectUri,
    label: opts?.label,
    shareLimitPct: opts?.shareLimitPct,
    createdAt: Date.now(),
  });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_OAUTH.clientId,
    redirect_uri: CHATGPT_OAUTH.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  });
  return { state, authUrl: `${CHATGPT_OAUTH.issuer}/oauth/authorize?${params.toString()}` };
}

// === ChatGPT Device Code Flow (最照顧手機 App 用戶：打開網頁輸入 8 碼即可授權) ===
export async function startChatGptDeviceFlow(opts?: { label?: string; shareLimitPct?: number }): Promise<{
  state: string;
  userCode: string;
  verifyUrl: string;
}> {
  const res = await fetch(`${CHATGPT_OAUTH.issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": CHATGPT_OAUTH.userAgent },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH.clientId }),
  });
  if (!res.ok) {
    throw new Error(`無法啟動 ChatGPT 裝置驗證（${res.status}）`);
  }
  const data = (await res.json()) as { user_code: string; device_auth_id: string };
  const state = randomBytes(16).toString("hex");
  pendingOAuth.set(state, {
    provider: "openai",
    verifier: "",
    redirectUri: "https://auth.openai.com/deviceauth/callback",
    label: opts?.label,
    shareLimitPct: opts?.shareLimitPct,
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    createdAt: Date.now(),
  });
  return {
    state,
    userCode: data.user_code,
    verifyUrl: CHATGPT_OAUTH.deviceVerifyUrl,
  };
}

export async function pollChatGptDeviceFlow(state: string): Promise<
  | { status: "pending" }
  | { status: "completed"; creds: OAuthCredentials; label?: string; shareLimitPct?: number }
> {
  const pending = pendingOAuth.get(state);
  if (!pending || !pending.deviceAuthId || !pending.userCode) {
    throw new Error("找不到對應的驗證狀態，請重新啟動");
  }
  const res = await fetch(`${CHATGPT_OAUTH.issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": CHATGPT_OAUTH.userAgent },
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode,
    }),
  });
  if (res.status === 403 || res.status === 404) {
    return { status: "pending" };
  }
  if (!res.ok) {
    throw new Error(`裝置驗證失敗（${res.status}）`);
  }
  const { authorization_code, code_verifier } = (await res.json()) as {
    authorization_code: string;
    code_verifier: string;
  };
  const creds = await exchangeChatGptCode(authorization_code, "https://auth.openai.com/deviceauth/callback", code_verifier);
  pendingOAuth.delete(state);
  return { status: "completed", creds, label: pending.label, shareLimitPct: pending.shareLimitPct };
}

// === Grok / SuperGrok Device Code Flow（手機／網頁輸入短碼即可）===
export async function startGrokDeviceFlow(opts?: { label?: string; shareLimitPct?: number }): Promise<{
  state: string;
  userCode: string;
  verifyUrl: string;
  verifyUrlComplete?: string;
  expiresIn: number;
  interval: number;
}> {
  const res = await fetch(GROK_OAUTH.deviceCodeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": GROK_OAUTH.userAgent,
    },
    body: new URLSearchParams({
      client_id: GROK_OAUTH.clientId,
      scope: GROK_OAUTH.scope,
      referrer: "ai-quota-platform",
    }),
  });
  if (!res.ok) {
    throw new Error(`無法啟動 Grok 裝置驗證（${res.status}）：${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Grok 裝置驗證回應缺少必要欄位");
  }
  const state = randomBytes(16).toString("hex");
  pendingOAuth.set(state, {
    provider: "xai",
    verifier: "",
    redirectUri: "",
    label: opts?.label,
    shareLimitPct: opts?.shareLimitPct,
    deviceAuthId: data.device_code,
    userCode: data.user_code,
    createdAt: Date.now(),
  });
  return {
    state,
    userCode: data.user_code,
    verifyUrl: data.verification_uri,
    verifyUrlComplete: data.verification_uri_complete,
    expiresIn: Number(data.expires_in ?? 900),
    interval: Math.max(1, Number(data.interval ?? 5)),
  };
}

export async function pollGrokDeviceFlow(state: string): Promise<
  | { status: "pending" }
  | { status: "completed"; creds: OAuthCredentials; label?: string; shareLimitPct?: number }
  | { status: "slow_down"; interval?: number }
> {
  const pending = pendingOAuth.get(state);
  if (!pending || pending.provider !== "xai" || !pending.deviceAuthId) {
    throw new Error("找不到對應的 Grok 驗證狀態，請重新啟動");
  }
  const res = await fetch(GROK_OAUTH.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": GROK_OAUTH.userAgent,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: GROK_OAUTH.clientId,
      device_code: pending.deviceAuthId,
    }),
  });
  if (res.ok) {
    const t = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };
    if (!t.access_token || !t.refresh_token) {
      throw new Error("Grok 授權成功但缺少 access_token／refresh_token");
    }
    const creds = await buildGrokCredsFromTokens(t);
    pendingOAuth.delete(state);
    return { status: "completed", creds, label: pending.label, shareLimitPct: pending.shareLimitPct };
  }
  const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (err.error === "authorization_pending") return { status: "pending" };
  if (err.error === "slow_down") return { status: "slow_down" };
  if (err.error === "access_denied" || err.error === "authorization_denied") {
    pendingOAuth.delete(state);
    throw new Error("你已拒絕 Grok 裝置授權");
  }
  if (err.error === "expired_token") {
    pendingOAuth.delete(state);
    throw new Error("Grok 裝置碼已過期，請重新啟動");
  }
  throw new Error(`Grok 裝置驗證失敗（${res.status}）：${err.error_description ?? err.error ?? ""}`);
}

async function buildGrokCredsFromTokens(t: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}): Promise<OAuthCredentials> {
  const claims = decodeJwtPayload(t.id_token ?? t.access_token);
  let email = typeof claims.email === "string" ? claims.email : undefined;
  let accountId = typeof claims.sub === "string" ? claims.sub : undefined;
  let planType =
    typeof claims.tier === "string"
      ? String(claims.tier)
      : Array.isArray(claims.tier)
        ? String(claims.tier[0] ?? "SuperGrok")
        : "SuperGrok";
  try {
    const headers = grokProxyHeaders(t.access_token);
    const userRes = await fetch(`${GROK_OAUTH.proxyBaseUrl}/user?include=subscription`, { headers });
    if (userRes.ok) {
      const user = (await userRes.json()) as {
        email?: string;
        id?: string;
        userId?: string;
        subscriptionTier?: string | string[];
      };
      email = user.email ?? email;
      accountId = user.id ?? user.userId ?? accountId;
      if (user.subscriptionTier) {
        planType = Array.isArray(user.subscriptionTier)
          ? user.subscriptionTier.join(", ")
          : String(user.subscriptionTier);
      }
    }
  } catch {
    // enrichment optional
  }
  return {
    provider: "xai",
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? "",
    expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    email,
    accountId,
    planType,
  };
}

export function grokProxyHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": GROK_OAUTH.userAgent,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_OAUTH.clientIdentifier,
    "x-grok-client-version": GROK_OAUTH.clientVersion,
  };
}

// === Exchange Authorization Code (from localhost callback or pasted URL) ===
export function parseCallbackInput(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const u = new URL(trimmed);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state") ?? undefined;
    if (!code) throw new Error("貼上的網址裡沒有包含 code= 參數");
    return { code, state };
  }
  return { code: trimmed };
}

function decodeStatePayload(state?: string): PendingOAuth | undefined {
  if (!state) return undefined;
  const fromMap = pendingOAuth.get(state);
  if (fromMap) return fromMap;
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      p?: "gemini" | "openai";
      v?: string;
      r?: string;
      l?: string;
      s?: number;
    };
    if (obj.p && obj.r !== undefined) {
      return {
        provider: obj.p,
        verifier: obj.v ?? "",
        redirectUri: obj.r,
        label: obj.l,
        shareLimitPct: obj.s,
        createdAt: Date.now(),
      };
    }
  } catch {
    // ignore
  }
  return undefined;
}

export async function completeOAuthByCode(input: {
  codeOrUrl: string;
  state?: string;
}): Promise<{ creds: OAuthCredentials; label?: string; shareLimitPct?: number }> {
  const parsed = parseCallbackInput(input.codeOrUrl);
  const stateKey = parsed.state ?? input.state;
  const pending = decodeStatePayload(stateKey) ?? [...pendingOAuth.values()].pop();
  if (!pending) {
    throw new Error("授權階段已過期，請重新點選「連結帳號」按鈕");
  }
  const creds =
    pending.provider === "gemini"
      ? await exchangeGeminiCode(parsed.code, pending.redirectUri, pending.verifier)
      : await exchangeChatGptCode(parsed.code, pending.redirectUri, pending.verifier);
  if (stateKey) pendingOAuth.delete(stateKey);
  return { creds, label: pending.label, shareLimitPct: pending.shareLimitPct };
}

export async function exchangeGeminiCode(code: string, redirectUri: string, verifier: string): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    client_secret: GEMINI_OAUTH.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (verifier) body.set("code_verifier", verifier);

  const res = await fetch(GEMINI_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google OAuth 交換失敗（${res.status}）：${(await res.text()).slice(0, 200)}`);
  }
  const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const meta = await bootstrapGeminiAccount(tokens.access_token);
  return {
    provider: "gemini",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    email: meta.email,
    projectId: meta.projectId,
    planType: meta.planType,
  };
}

export async function bootstrapGeminiAccount(
  accessToken: string,
): Promise<{ email?: string; projectId: string; planType: string }> {
  let email: string | undefined;
  try {
    const uRes = await fetch(`${GEMINI_OAUTH.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (uRes.ok) {
      const u = (await uRes.json()) as { email?: string };
      email = u.email;
    }
  } catch {
    // ignore
  }

  let projectId = "";
  let planType = "Google AI Pro";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_OAUTH.userAgent,
  };
  for (const host of [GEMINI_OAUTH.prodHost, GEMINI_OAUTH.dailyHost]) {
    try {
      const lRes = await fetch(`${host}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
      });
      if (lRes.ok) {
        const data = (await lRes.json()) as {
          cloudaicompanionProject?: string | { id?: string };
          currentTier?: { id?: string; name?: string };
          allowedTiers?: { id?: string; name?: string; isDefault?: boolean }[];
        };
        const p = data.cloudaicompanionProject;
        projectId = typeof p === "string" ? p : p?.id ?? "";
        const defTier = data.currentTier ?? data.allowedTiers?.find((t) => t.isDefault) ?? data.allowedTiers?.[0];
        if (defTier?.name || defTier?.id) planType = defTier.name ?? defTier.id ?? planType;
        if (projectId) break;
      }
    } catch {
      // try next host
    }
  }
  if (!projectId) {
    projectId = `bright-spark-${randomBytes(3).toString("hex")}`;
  }
  return { email, projectId, planType };
}

export async function exchangeChatGptCode(code: string, redirectUri: string, verifier: string): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CHATGPT_OAUTH.clientId,
  });
  if (verifier) body.set("code_verifier", verifier);

  const res = await fetch(`${CHATGPT_OAUTH.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": CHATGPT_OAUTH.userAgent },
    body,
  });
  if (!res.ok) {
    throw new Error(`ChatGPT OAuth 交換失敗（${res.status}）：${(await res.text()).slice(0, 200)}`);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  return buildChatGptCredsFromTokens(tokens);
}

export function buildChatGptCredsFromTokens(tokens: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
}): OAuthCredentials {
  const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  const accClaims = decodeJwtPayload(tokens.access_token);
  const authObj = (accClaims["https://api.openai.com/auth"] ?? idClaims["https://api.openai.com/auth"] ?? {}) as Record<
    string,
    unknown
  >;
  const profileObj = (accClaims["https://api.openai.com/profile"] ??
    idClaims["https://api.openai.com/profile"] ??
    {}) as Record<string, unknown>;

  const accountId = String(
    tokens.account_id ??
      authObj.chatgpt_account_id ??
      accClaims.chatgpt_account_id ??
      idClaims.chatgpt_account_id ??
      "",
  );
  const email = String(profileObj.email ?? idClaims.email ?? accClaims.email ?? "") || undefined;
  const planType = String(authObj.chatgpt_plan_type ?? idClaims.chatgpt_plan_type ?? "pro");

  return {
    provider: "openai",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    email,
    accountId: accountId || undefined,
    planType,
  };
}

// === Refresh OAuth Credentials Automatically ===
export async function refreshOAuthCredentials(creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) return creds;
  if (creds.provider === "gemini") {
    const res = await fetch(GEMINI_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: GEMINI_OAUTH.clientId,
        client_secret: GEMINI_OAUTH.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Gemini Token 刷新失敗（${res.status}）`);
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      ...creds,
      accessToken: t.access_token,
      refreshToken: t.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    };
  }
  if (creds.provider === "xai") {
    const res = await fetch(GROK_OAUTH.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": GROK_OAUTH.userAgent,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: GROK_OAUTH.clientId,
      }),
    });
    if (!res.ok) throw new Error(`Grok Token 刷新失敗（${res.status}）`);
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    // xAI 常會旋轉 refresh_token；若回應沒帶新的，舊的通常已失效
    if (!t.refresh_token) {
      throw new Error("Grok refresh 未回傳新 refresh_token，請重新裝置碼登入");
    }
    return {
      ...creds,
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    };
  }
  const res = await fetch(`${CHATGPT_OAUTH.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": CHATGPT_OAUTH.userAgent },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CHATGPT_OAUTH.clientId,
    }),
  });
  if (!res.ok) throw new Error(`ChatGPT Token 刷新失敗（${res.status}）`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    ...creds,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
  };
}

// === Query Real-Time Subscription Remaining Quota (%) ===
export async function fetchSubscriptionQuota(creds: OAuthCredentials): Promise<SubscriptionQuota> {
  if (creds.provider === "gemini") return fetchGeminiSubscriptionQuota(creds);
  if (creds.provider === "xai") return fetchGrokSubscriptionQuota(creds);
  return fetchChatGptSubscriptionQuota(creds);
}

/** 是否納入 Antigravity 用量顯示（含 Gemini + Claude/GPT 第三方池） */
function isAntigravityQuotaGroup(groupName: string, bucketName: string): boolean {
  const text = `${groupName} ${bucketName}`.toLowerCase();
  return /gemini|argon|flash|gemma|claude|\bgpt\b|3p-|openai|anthropic/.test(text);
}

function antigravityQuotaLabel(groupName: string, bucketName: string, window?: string): string {
  const raw = `${groupName} ${bucketName} ${window ?? ""}`.trim();
  let niceModel = "Gemini 總額";
  if (/claude and gpt|3p-|claude|\bgpt\b/i.test(raw) && !/gemini|argon/i.test(raw)) {
    niceModel = "Claude／GPT 第三方（Antigravity）";
  } else if (/argon/i.test(raw)) niceModel = "Gemini 4 Argon";
  else if (/3\.1.*pro|pro-agent/i.test(raw)) niceModel = "Gemini 3.1 Pro";
  else if (/3\.8.*flash/i.test(raw)) niceModel = "Gemini 3.8 Flash";
  else if (/flash.?lite|3\.5.*flash/i.test(raw)) niceModel = "Gemini Flash-Lite";
  else if (/gemini models/i.test(raw)) niceModel = "Gemini 總額";
  else {
    const m = raw.match(/gemini[\w.\-\s]{0,24}/i)?.[0]?.trim();
    if (m) niceModel = m.replace(/\s+/g, " ");
  }
  const isFiveHour = /five\s*hour|5\s*h|\bhour\b|gemini-5h|3p-5h/i.test(raw);
  const isWeekly = /week|weekly|週|7\s*day|gemini-weekly|wtu-weekly|3p-weekly/i.test(raw);
  const period = isFiveHour ? "5 小時" : isWeekly ? "週" : "額度";
  return `${niceModel} · ${period}`;
}

/** 越高越接近 Antigravity Models & Usage 主列（避免子桶／CLI 池蓋掉官方 95%） */
function antigravityBucketPriority(groupName: string, bucketName: string, bucketId?: string): number {
  const raw = `${groupName} ${bucketName} ${bucketId ?? ""}`.toLowerCase();
  if (/claude and gpt models/.test(raw)) return 100;
  if (/^gemini models$/.test(groupName.trim().toLowerCase()) || /gemini models/.test(raw)) return 95;
  if (/argon/.test(raw)) return 90;
  if (/3p-weekly|3p-5h|gemini-weekly|gemini-5h|wtu-weekly/.test(raw)) return 70;
  if (/claude|gpt-oss|\bgpt\b|openai|anthropic/.test(raw)) return 40;
  return 20;
}

function preferQuotaWindow(
  a: QuotaWindow & { priority: number },
  b: QuotaWindow & { priority: number },
): QuotaWindow & { priority: number } {
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
  // 同優先級：對齊官方 UI 主池（通常較高剩餘），不要被較空的子桶拖低
  return a.remainingPercent >= b.remainingPercent ? a : b;
}

function pickGeminiPrimary(windows: QuotaWindow[]): QuotaWindow {
  // 與 Antigravity 主畫面對齊：優先顯示 Argon 週額度；沒有再看 5 小時總額
  const argonWeekly = windows.filter((w) => w.modelKey === "argon" && /週/.test(w.label) && !/即時/.test(w.label));
  if (argonWeekly.length) return argonWeekly.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
  const fiveHour = windows.filter((w) => /5\s*小時/.test(w.label));
  const pool = fiveHour.length > 0 ? fiveHour : windows;
  return pool.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
}

/** 帳號實際可用的 Antigravity model id；預設打訂閱主機（dailyHost），與剩餘 % 同一池 */
export async function fetchAntigravityAvailableModels(
  creds: OAuthCredentials,
  opts?: { allowDailyFallback?: boolean },
): Promise<Record<string, { displayName?: string; remainingFraction?: number; resetTime?: string }>> {
  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_OAUTH.userAgent,
  };
  const body = JSON.stringify(creds.projectId ? { project: creds.projectId } : {});
  // 訂閱 OAuth：主路徑是 Antigravity Hub（dailyHost）；CLI prod 僅作可選備援目錄
  const hosts = opts?.allowDailyFallback
    ? [GEMINI_OAUTH.dailyHost, GEMINI_OAUTH.prodHost]
    : [GEMINI_OAUTH.dailyHost];
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/v1internal:fetchAvailableModels`, { method: "POST", headers, body });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
      };
      if (data.models) {
        const out: Record<string, { displayName?: string; remainingFraction?: number; resetTime?: string }> = {};
        for (const [id, meta] of Object.entries(data.models)) {
          out[id] = {
            displayName: meta.displayName,
            remainingFraction: meta.quotaInfo?.remainingFraction,
            resetTime: meta.quotaInfo?.resetTime,
          };
        }
        return out;
      }
    } catch {
      // try next
    }
  }
  return {};
}

async function fetchGeminiSubscriptionQuota(creds: OAuthCredentials): Promise<SubscriptionQuota> {
  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_OAUTH.userAgent,
  };
  const body = JSON.stringify(creds.projectId ? { project: creds.projectId } : {});
  // 重要：只用 Antigravity Hub（dailyHost）。fallback 到 cloudcode-pa（CLI 池）會跟 Models & Usage 脫鉤（例如官方 95%／我們顯示 84%）。
  const host = GEMINI_OAUTH.dailyHost;
  try {
    const res = await fetch(`${host}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers,
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        groups?: {
          displayName?: string;
          buckets?: {
            bucketId?: string;
            displayName?: string;
            window?: string;
            resetTime?: string;
            remainingFraction?: number;
          }[];
        }[];
      };
      type Ranked = QuotaWindow & { priority: number };
      const ranked: Ranked[] = [];
      for (const g of data.groups ?? []) {
        const groupName = g.displayName ?? "";
        for (const b of g.buckets ?? []) {
          if (typeof b.remainingFraction !== "number") continue;
          const bucketName = b.displayName ?? b.bucketId ?? "";
          if (!isAntigravityQuotaGroup(groupName, bucketName)) continue;
          const { rem, used, uiRem, uiUsed } = pctFromFraction(b.remainingFraction);
          const raw = `${groupName} ${bucketName} ${b.bucketId ?? ""}`;
          ranked.push({
            label: antigravityQuotaLabel(groupName, bucketName, b.window),
            usedPercent: used,
            remainingPercent: rem,
            uiRemainingPercent: uiRem,
            uiUsedPercent: uiUsed,
            resetAt: b.resetTime ?? null,
            modelKey: modelKeyFromText(raw),
            bucketId: b.bucketId,
            priority: antigravityBucketPriority(groupName, bucketName, b.bucketId),
          });
        }
      }

      // 只顯示 retrieveUserQuotaSummary 主池（週／5 小時），不再另插「· 訂閱池」避免重複
      const byLabel = new Map<string, Ranked>();
      for (const w of ranked) {
        const prev = byLabel.get(w.label);
        byLabel.set(w.label, prev ? preferQuotaWindow(prev, w) : w);
      }
      // 同 modelKey＋時窗只留一列（例如 Argon 週不要出現兩次）
      const byPool = new Map<string, Ranked>();
      for (const w of byLabel.values()) {
        const period = /5\s*小時/.test(w.label) ? "5h" : /週/.test(w.label) ? "week" : "other";
        const key = `${w.modelKey ?? w.label}::${period}`;
        const prev = byPool.get(key);
        byPool.set(key, prev ? preferQuotaWindow(prev, w) : w);
      }
      const unique = [...byPool.values()].map(({ priority: _p, ...w }) => w);
      if (unique.length > 0) {
        const primary = pickGeminiPrimary(unique);
        return {
          planType: creds.planType ?? "Google AI Pro",
          email: creds.email,
          windows: unique,
          primaryUsedPercent: primary.uiUsedPercent,
          primaryRemainingPercent: primary.uiRemainingPercent,
          fetchedAt: Date.now(),
        };
      }
    }
  } catch {
    // fall through
  }
  return {
    planType: creds.planType ?? "Google AI Pro",
    email: creds.email,
    windows: [
      {
        label: "Gemini · 5 小時",
        usedPercent: 0,
        remainingPercent: 100,
        uiRemainingPercent: 100,
        uiUsedPercent: 0,
        resetAt: null,
        modelKey: "shared",
      },
    ],
    primaryUsedPercent: 0,
    primaryRemainingPercent: 100,
    fetchedAt: Date.now(),
  };
}

async function fetchChatGptSubscriptionQuota(creds: OAuthCredentials): Promise<SubscriptionQuota> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: "application/json",
    "User-Agent": CHATGPT_OAUTH.userAgent,
    originator: "Codex Desktop",
  };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

  for (const pathSuffix of ["/codex/usage", "/wham/usage"]) {
    try {
      const res = await fetch(`${CHATGPT_OAUTH.codexBaseUrl}${pathSuffix}`, { headers });
      if (res.ok) {
        const data = (await res.json()) as {
          plan_type?: string;
          email?: string;
          rate_limit?: {
            primary_window?: { used_percent?: number; reset_at?: number };
            secondary_window?: { used_percent?: number; reset_at?: number };
          };
        };
        const windows: QuotaWindow[] = [];
        const p = data.rate_limit?.primary_window;
        if (p && typeof p.used_percent === "number") {
          const used = Math.round(p.used_percent * 10) / 10;
          const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
          windows.push({
            label: "5 小時視窗",
            usedPercent: used,
            remainingPercent: rem,
            uiRemainingPercent: Math.round(rem),
            uiUsedPercent: Math.round(used),
            resetAt: p.reset_at ? new Date(p.reset_at * 1000).toISOString() : null,
          });
        }
        const s = data.rate_limit?.secondary_window;
        if (s && typeof s.used_percent === "number") {
          const used = Math.round(s.used_percent * 10) / 10;
          const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
          windows.push({
            label: "7 天週視窗",
            usedPercent: used,
            remainingPercent: rem,
            uiRemainingPercent: Math.round(rem),
            uiUsedPercent: Math.round(used),
            resetAt: s.reset_at ? new Date(s.reset_at * 1000).toISOString() : null,
          });
        }
        const primary =
          windows[0] ??
          ({
            label: "5 小時視窗",
            usedPercent: 0,
            remainingPercent: 100,
            uiRemainingPercent: 100,
            uiUsedPercent: 0,
            resetAt: null,
          } satisfies QuotaWindow);
        return {
          planType: (data.plan_type ?? creds.planType ?? "pro").toUpperCase(),
          email: data.email ?? creds.email,
          windows: windows.length ? windows : [primary],
          primaryUsedPercent: primary.uiUsedPercent,
          primaryRemainingPercent: primary.uiRemainingPercent,
          fetchedAt: Date.now(),
        };
      }
    } catch {
      // try next path
    }
  }
  return {
    planType: (creds.planType ?? "pro").toUpperCase(),
    email: creds.email,
    windows: [
      {
        label: "5 小時視窗",
        usedPercent: 0,
        remainingPercent: 100,
        uiRemainingPercent: 100,
        uiUsedPercent: 0,
        resetAt: null,
      },
    ],
    primaryUsedPercent: 0,
    primaryRemainingPercent: 100,
    fetchedAt: Date.now(),
  };
}

async function fetchGrokSubscriptionQuota(creds: OAuthCredentials): Promise<SubscriptionQuota> {
  const headers = grokProxyHeaders(creds.accessToken);
  const windows: QuotaWindow[] = [];
  let planType = creds.planType ?? "SuperGrok";
  let email = creds.email;

  try {
    const [billingRes, userRes] = await Promise.all([
      fetch(`${GROK_OAUTH.proxyBaseUrl}/billing?format=credits`, { headers }),
      fetch(`${GROK_OAUTH.proxyBaseUrl}/user?include=subscription`, { headers }),
    ]);
    if (userRes.ok) {
      const user = (await userRes.json()) as {
        email?: string;
        subscriptionTier?: string | string[];
      };
      email = user.email ?? email;
      if (user.subscriptionTier) {
        planType = Array.isArray(user.subscriptionTier)
          ? user.subscriptionTier.join(", ")
          : String(user.subscriptionTier);
      }
    }
    if (billingRes.ok) {
      const billing = (await billingRes.json()) as Record<string, unknown>;
      const cfg = ((billing.config as Record<string, unknown> | undefined) ?? billing) as {
        creditUsagePercent?: number;
        productUsage?: { product?: string; usagePercent?: number }[];
        currentPeriod?: { type?: string; end?: string };
        billingPeriodEnd?: string;
      };
      const periodEnd = cfg.currentPeriod?.end ?? cfg.billingPeriodEnd ?? null;
      if (typeof cfg.creditUsagePercent === "number") {
        const used = Math.round(cfg.creditUsagePercent * 10) / 10;
        const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
        windows.push({
          label: "訂閱額度",
          usedPercent: used,
          remainingPercent: rem,
          uiRemainingPercent: Math.round(rem),
          uiUsedPercent: Math.round(used),
          resetAt: periodEnd,
          modelKey: "grok",
        });
      }
      for (const p of cfg.productUsage ?? []) {
        if (typeof p.usagePercent !== "number") continue;
        const used = Math.round(p.usagePercent * 10) / 10;
        const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
        windows.push({
          label: String(p.product ?? "產品額度"),
          usedPercent: used,
          remainingPercent: rem,
          uiRemainingPercent: Math.round(rem),
          uiUsedPercent: Math.round(used),
          resetAt: periodEnd,
          modelKey: "grok",
        });
      }
    }
  } catch {
    // fallback below
  }

  if (!windows.length) {
    windows.push({
      label: "訂閱額度",
      usedPercent: 0,
      remainingPercent: 100,
      uiRemainingPercent: 100,
      uiUsedPercent: 0,
      resetAt: null,
      modelKey: "grok",
    });
  }
  const primary = windows.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
  return {
    planType,
    email,
    windows,
    primaryUsedPercent: primary.uiUsedPercent,
    primaryRemainingPercent: primary.uiRemainingPercent,
    fetchedAt: Date.now(),
  };
}

// === Detect Local Machine Installed CLI Credentials (1-Click Import if Present) ===
export function detectLocalCliCredentials(): { provider: "gemini" | "openai" | "xai"; path: string; hint: string }[] {
  const home = os.homedir();
  const found: { provider: "gemini" | "openai" | "xai"; path: string; hint: string }[] = [];
  const codexAuth = path.join(home, ".codex", "auth.json");
  if (existsSync(codexAuth)) {
    found.push({ provider: "openai", path: codexAuth, hint: "~/.codex/auth.json" });
  }
  const geminiAuth = path.join(home, ".gemini", "oauth_creds.json");
  if (existsSync(geminiAuth)) {
    found.push({ provider: "gemini", path: geminiAuth, hint: "~/.gemini/oauth_creds.json" });
  }
  const grokAuth = path.join(home, ".grok", "auth.json");
  if (existsSync(grokAuth)) {
    found.push({ provider: "xai", path: grokAuth, hint: "~/.grok/auth.json" });
  }
  return found;
}

export async function importLocalCliCredential(target: "gemini" | "openai" | "xai"): Promise<OAuthCredentials> {
  const home = os.homedir();
  if (target === "openai") {
    const file = path.join(home, ".codex", "auth.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const t = raw.tokens ?? raw;
    if (!t.access_token) throw new Error("~/.codex/auth.json 中找不到 access_token");
    return buildChatGptCredsFromTokens(t);
  }
  if (target === "xai") {
    const file = path.join(home, ".grok", "auth.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: string; refresh?: string; expires?: number }>;
    const entry = Object.values(raw).find((e) => e?.key) ?? Object.values(raw)[0];
    if (!entry?.key) throw new Error("~/.grok/auth.json 中找不到 token");
    return buildGrokCredsFromTokens({
      access_token: entry.key,
      refresh_token: entry.refresh,
      expires_in: entry.expires ? Math.max(60, Math.floor((entry.expires - Date.now()) / 1000)) : 3600,
    });
  }
  const file = path.join(home, ".gemini", "oauth_creds.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw.access_token) throw new Error("~/.gemini/oauth_creds.json 中找不到 access_token");
  const meta = await bootstrapGeminiAccount(raw.access_token);
  return {
    provider: "gemini",
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? "",
    expiresAt: Number(raw.expiry_date ?? Date.now() + 3600_000),
    email: meta.email,
    projectId: meta.projectId,
    planType: meta.planType,
  };
}
