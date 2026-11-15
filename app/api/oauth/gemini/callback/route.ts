import { completeOAuthByCode } from "@/lib/oauth";
import { publicAppUrl } from "@/lib/cloud-site";
import { addOAuthSubscriptionSource } from "@/lib/sources";
import { getSessionUser, jsonError } from "@/lib/auth";

export const dynamic = "force-dynamic";

function htmlPage(opts: { ok: boolean; title: string; body: string; nextHref: string }): Response {
  const color = opts.ok ? "#3fb37f" : "#e05d5d";
  return new Response(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${opts.title}</title></head>
<body style="background:#0f1115;color:#e6e8ec;font-family:system-ui,sans-serif;text-align:center;padding:12vh 20px">
  <h2 style="color:${color}">${opts.title}</h2>
  <p style="max-width:420px;margin:12px auto;line-height:1.55;color:#9aa3b2">${opts.body}</p>
  <p><a href="${opts.nextHref}" style="color:#5b8cff">回到供給控制台</a></p>
  <script>setTimeout(function(){location.href=${JSON.stringify(opts.nextHref)}},${opts.ok ? 900 : 4000})</script>
</body></html>`,
    {
      status: opts.ok ? 200 : 400,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

/**
 * Google「網頁應用程式」OAuth 正式回呼。
 * Console 需登記：https://<你的網域>/api/oauth/gemini/callback
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  const sourcesHref = `${publicAppUrl()}/sources`;
  if (err) {
    return htmlPage({
      ok: false,
      title: "授權已取消",
      body: err === "access_denied" ? "您拒絕了 Google 授權。" : `Google 回傳：${err}`,
      nextHref: sourcesHref,
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? undefined;
  if (!code) {
    return htmlPage({
      ok: false,
      title: "缺少授權碼",
      body: "回呼網址沒有 code。請回到 /sources 重新點選 Google OAuth。",
      nextHref: sourcesHref,
    });
  }

  try {
    const session = await getSessionUser(req);
    if (!session?.isSupplier) {
      return htmlPage({
        ok: false,
        title: "請先以供給者帳號登入",
        body: "授權回呼需要已登入的供給者工作階段，請回到 /sources 登入後再綁定。",
        nextHref: sourcesHref,
      });
    }
    const fullUrl = url.toString();
    const { creds, label, shareLimitPct } = await completeOAuthByCode({
      codeOrUrl: fullUrl,
      state,
    });
    await addOAuthSubscriptionSource({
      creds,
      label,
      shareLimitPct,
      ownerUserId: session.id,
    });
    return htmlPage({
      ok: true,
      title: "✓ 訂閱帳號連結成功",
      body: "已同步剩餘容量，即將返回供給控制台。",
      nextHref: `${sourcesHref}?oauth=ok`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 非 HTML 客戶端（偵錯）仍可讀 JSON
    if (req.headers.get("accept")?.includes("application/json")) {
      return jsonError(e);
    }
    return htmlPage({
      ok: false,
      title: "授權失敗",
      body: message,
      nextHref: sourcesHref,
    });
  }
}
