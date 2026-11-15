/**
 * 本機開發可不設 DATABASE_URL：OAuth 綁定改轉發到雲端（Vercel）API 寫入 Supabase。
 * OAUTH_CLOUD_API_BASE / NEXT_PUBLIC_APP_URL 為公開站台網址，不是資料庫密鑰。
 */

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

type OAuthActionBody = Record<string, unknown> & { action: string };

/** 將需寫入 DB 的 OAuth 動作轉發到雲端；避免本機持有 DATABASE_URL。 */
export async function persistOAuthViaCloud(body: OAuthActionBody): Promise<Record<string, unknown>> {
  const url = `${cloudApiBase()}/api/oauth`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 防止萬一雲端也缺 DB 時自我遞迴
      "x-oauth-no-proxy": "1",
    },
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

export function shouldProxyOAuthPersist(req?: Request): boolean {
  if (hasLocalDatabaseUrl()) return false;
  if (req?.headers.get("x-oauth-no-proxy") === "1") return false;
  return true;
}
