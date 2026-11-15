/**
 * 雲端（Vercel + Supabase）為唯一資料來源。
 * 本機未設 DATABASE_URL 時，讀寫 API 代理到 OAUTH_CLOUD_API_BASE / NEXT_PUBLIC_APP_URL。
 * 公開站台網址不是密鑰；DATABASE_URL 只應存在於 Vercel。
 */

export const CLOUD_DB_PROXY_HEADER = "x-cloud-db-proxy";

export function hasLocalDatabaseUrl(): boolean {
  return Boolean(
    process.env.DATABASE_URL?.trim() ||
      process.env.POSTGRES_URL?.trim() ||
      process.env.SUPABASE_DB_URL?.trim(),
  );
}

export function cloudApiBase(): string {
  const raw =
    process.env.OAUTH_CLOUD_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "https://alloyflux.vercel.app";
  return raw.replace(/\/$/, "");
}

export function cloudSourcesUrl(): string {
  return `${cloudApiBase()}/sources`;
}

export function shouldProxyToCloudDb(req?: Request): boolean {
  if (hasLocalDatabaseUrl()) return false;
  if (req?.headers.get(CLOUD_DB_PROXY_HEADER) === "1") return false;
  // 相容舊 OAuth 防迴圈標頭
  if (req?.headers.get("x-oauth-no-proxy") === "1") return false;
  if (req?.headers.get("x-admin-no-proxy") === "1") return false;
  return true;
}

/** @deprecated 改用 shouldProxyToCloudDb */
export function shouldProxyOAuthPersist(req?: Request): boolean {
  return shouldProxyToCloudDb(req);
}

type JsonBody = Record<string, unknown> & { action?: string };

/** OAuth 寫入專用：POST JSON 到雲端 /api/oauth（轉發 cookie 以綁定擁有者） */
export async function persistOAuthViaCloud(body: JsonBody, req?: Request): Promise<Record<string, unknown>> {
  const url = `${cloudApiBase()}/api/oauth`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [CLOUD_DB_PROXY_HEADER]: "1",
    "x-oauth-no-proxy": "1",
  };
  const cookie = req?.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = typeof data.error === "string" ? data.error : `雲端綁定失敗（HTTP ${res.status}）`;
    throw new Error(err);
  }
  return data;
}

export async function proxyRequestToCloud(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${cloudApiBase()}${url.pathname}${url.search}`;
  const headers = new Headers();
  const pass = ["content-type", "cookie", "authorization", "accept"];
  for (const h of pass) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set(CLOUD_DB_PROXY_HEADER, "1");
  headers.set("x-oauth-no-proxy", "1");
  headers.set("x-admin-no-proxy", "1");

  const method = req.method.toUpperCase();
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const res = await fetch(target, init);
  const out = new Headers();
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
    out.set(k, v);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/**
 * 放在需讀寫 DB 的 route 開頭：
 * `const proxied = await cloudDbProxy(req); if (proxied) return proxied;`
 */
export async function cloudDbProxy(req: Request): Promise<Response | null> {
  if (!shouldProxyToCloudDb(req)) return null;
  try {
    return await proxyRequestToCloud(req);
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : "雲端 DB 代理失敗",
        hint: `請確認 ${cloudApiBase()} 可連線，或於 Vercel 設定 DATABASE_URL`,
      },
      { status: 502 },
    );
  }
}
