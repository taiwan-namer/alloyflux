import { createServer, type Server } from "node:http";
import {
  completeOAuthByCode,
  detectLocalCliCredentials,
  geminiOAuthMode,
  importLocalCliCredential,
  pollChatGptDeviceFlow,
  pollGrokDeviceFlow,
  resolveGeminiOAuthRedirectUri,
  startChatGptDeviceFlow,
  startChatGptOAuth,
  startGeminiOAuth,
  startGrokDeviceFlow,
  type OAuthCredentials,
} from "@/lib/oauth";
import {
  cloudApiBase,
  cloudSourcesUrl,
  persistOAuthViaCloud,
  shouldProxyOAuthPersist,
} from "@/lib/cloud-api";
import {
  addOAuthSubscriptionSource,
  syncAllSubscriptionQuotas,
  syncSourceQuotaById,
} from "@/lib/sources";
import { jsonError } from "@/lib/auth";

export const dynamic = "force-dynamic";

const globalForServers = globalThis as unknown as {
  __geminiCallbackServer?: Server;
  __chatgptCallbackServer?: Server;
  __callbackVersion?: number;
};

const CALLBACK_VERSION = 3;

async function saveOAuthSource(
  req: Request | undefined,
  input: {
    creds: OAuthCredentials;
    label?: string;
    shareLimitPct?: number;
  },
): Promise<Record<string, unknown>> {
  if (shouldProxyOAuthPersist(req)) {
    return persistOAuthViaCloud({
      action: "import_raw_token",
      provider: input.creds.provider,
      accessToken: input.creds.accessToken,
      refreshToken: input.creds.refreshToken,
      accountId: input.creds.accountId,
      projectId: input.creds.projectId,
      email: input.creds.email,
      planType: input.creds.planType,
      expiresAt: input.creds.expiresAt,
      label: input.label,
      shareLimitPct: input.shareLimitPct,
    });
  }
  return addOAuthSubscriptionSource(input);
}

async function completeCodeAndSave(
  req: Request | undefined,
  input: {
    codeOrUrl: string;
    state?: string;
    label?: string;
    shareLimitPct?: number;
  },
): Promise<Record<string, unknown>> {
  // 一律在「啟動授權的同一環境」兌換 code（client_id/secret/PKCE 必須一致）。
  // 本機無 DB 時：本機換 token，再把憑證寫入雲端——不可把 code 丟給雲端換（常因 Vercel 與本機 OAuth client 不同而失敗）。
  const { creds, label, shareLimitPct } = await completeOAuthByCode({
    codeOrUrl: input.codeOrUrl,
    state: input.state,
  });
  if (shouldProxyOAuthPersist(req)) {
    return persistOAuthViaCloud({
      action: "import_raw_token",
      provider: creds.provider,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      accountId: creds.accountId,
      projectId: creds.projectId,
      email: creds.email,
      planType: creds.planType,
      expiresAt: creds.expiresAt,
      label: input.label || label,
      shareLimitPct: input.shareLimitPct ?? shareLimitPct,
    });
  }
  const added = await addOAuthSubscriptionSource({
    creds,
    label: input.label || label,
    shareLimitPct: input.shareLimitPct ?? shareLimitPct,
  });
  return { ok: true, ...added };
}

function ensureLocalCallbackListener(port: number, expectedPath: string) {
  const key = port === 51121 ? "__geminiCallbackServer" : "__chatgptCallbackServer";
  const existing = globalForServers[key];
  if (existing && existing.listening && globalForServers.__callbackVersion === CALLBACK_VERSION) return;
  if (existing) {
    try {
      existing.close();
    } catch {
      // ignore
    }
    globalForServers[key] = undefined;
  }
  globalForServers.__callbackVersion = CALLBACK_VERSION;
  try {
    const srv = createServer(async (req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (!u.pathname.startsWith(expectedPath)) {
          res.writeHead(404);
          return res.end("Not found");
        }
        const fullUrl = u.toString();
        // 本機監聽只負責收下 Google 回呼；寫入一律走雲端或本機 DB（若有）
        await completeCodeAndSave(undefined, { codeOrUrl: fullUrl });
        const nextUrl = shouldProxyOAuthPersist() ? cloudSourcesUrl() : "http://127.0.0.1:3000/sources";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="background:#0f1115;color:#e6e8ec;font-family:sans-serif;text-align:center;padding-top:15vh">
          <h2 style="color:#3fb37f">✓ 訂閱帳號連結成功！已同步剩餘容量</h2>
          <p>這個視窗會自動跳回 AI 用量平台。</p>
          <script>setTimeout(()=>{location.href=${JSON.stringify(nextUrl)}},800)</script>
        </body></html>`);
      } catch (e) {
        const sourcesHref = shouldProxyOAuthPersist() ? cloudSourcesUrl() : "http://127.0.0.1:3000/sources";
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="background:#0f1115;color:#e05d5d;font-family:sans-serif;text-align:center;padding-top:15vh">
          <h2>授權失敗</h2><p>${e instanceof Error ? e.message : String(e)}</p>
          <p><a href="${sourcesHref}" style="color:#5b8cff">← 回到設定頁重試</a></p>
          <p style="color:#9aa3b2;font-size:13px;max-width:420px;margin:16px auto">也可複製網址列整串，貼回線上 /vendor 或 /sources 的「完成綁定」欄位。</p>
        </body></html>`);
      }
    });
    srv.on("error", () => {});
    // 不鎖死 127.0.0.1，讓 Windows 的 localhost (IPv6 ::1 與 IPv4 127.0.0.1) 都連得進來
    srv.listen(port);
    globalForServers[key] = srv;
  } catch {
    // ignore listener error
  }
}

export async function GET() {
  try {
    const geminiMode = geminiOAuthMode();
    return Response.json({
      localCli: detectLocalCliCredentials(),
      persistMode: shouldProxyOAuthPersist() ? "cloud" : "local",
      cloudApiBase: shouldProxyOAuthPersist() ? cloudApiBase() : null,
      geminiOAuthMode: geminiMode,
      geminiRedirectUri: resolveGeminiOAuthRedirectUri(),
      geminiWebOAuthReady: geminiMode === "web",
    });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action:
        | "start_gemini"
        | "start_chatgpt_browser"
        | "start_chatgpt_device"
        | "poll_chatgpt_device"
        | "start_grok_device"
        | "poll_grok_device"
        | "complete_code"
        | "import_local_cli"
        | "import_raw_token"
        | "sync_quota";
      label?: string;
      shareLimitPct?: number;
      state?: string;
      codeOrUrl?: string;
      provider?: "gemini" | "openai" | "xai";
      accessToken?: string;
      refreshToken?: string;
      accountId?: string;
      projectId?: string;
      email?: string;
      planType?: string;
      expiresAt?: number;
      sourceId?: string;
    };

    switch (body.action) {
      case "start_gemini": {
        const res = startGeminiOAuth({ label: body.label, shareLimitPct: body.shareLimitPct });
        // 只有本機開發才開 51121 自動接 callback；線上（Vercel）走「複製 localhost 網址貼回」流程
        if (!process.env.VERCEL) {
          ensureLocalCallbackListener(51121, "/oauth-callback");
        }
        return Response.json({
          ...res,
          persistMode: shouldProxyOAuthPersist(req) ? "cloud" : "local",
        });
      }
      case "start_chatgpt_browser": {
        ensureLocalCallbackListener(1455, "/auth/callback");
        const res = startChatGptOAuth({ label: body.label, shareLimitPct: body.shareLimitPct });
        return Response.json(res);
      }
      case "start_chatgpt_device": {
        const res = await startChatGptDeviceFlow({ label: body.label, shareLimitPct: body.shareLimitPct });
        return Response.json(res);
      }
      case "poll_chatgpt_device": {
        if (!body.state) return Response.json({ error: "缺少 state" }, { status: 400 });
        const r = await pollChatGptDeviceFlow(body.state);
        if (r.status === "pending") return Response.json({ status: "pending" });
        const added = await saveOAuthSource(req, {
          creds: r.creds,
          label: r.label,
          shareLimitPct: r.shareLimitPct,
        });
        return Response.json({ status: "completed", ...added });
      }
      case "start_grok_device": {
        const res = await startGrokDeviceFlow({ label: body.label, shareLimitPct: body.shareLimitPct });
        return Response.json(res);
      }
      case "poll_grok_device": {
        if (!body.state) return Response.json({ error: "缺少 state" }, { status: 400 });
        const r = await pollGrokDeviceFlow(body.state);
        if (r.status === "pending" || r.status === "slow_down") return Response.json({ status: "pending" });
        const added = await saveOAuthSource(req, {
          creds: r.creds,
          label: r.label,
          shareLimitPct: r.shareLimitPct,
        });
        return Response.json({ status: "completed", ...added });
      }
      case "complete_code": {
        if (!body.codeOrUrl) return Response.json({ error: "請貼上授權回呼網址或 code" }, { status: 400 });
        const added = await completeCodeAndSave(req, {
          codeOrUrl: body.codeOrUrl,
          state: body.state,
          label: body.label,
          shareLimitPct: body.shareLimitPct,
        });
        return Response.json({ ok: true, ...added });
      }
      case "import_local_cli": {
        if (!body.provider) return Response.json({ error: "請指定 provider" }, { status: 400 });
        const creds = await importLocalCliCredential(body.provider);
        const added = await saveOAuthSource(req, {
          creds,
          label: body.label,
          shareLimitPct: body.shareLimitPct,
        });
        return Response.json({ ok: true, ...added });
      }
      case "import_raw_token": {
        if (!body.provider || !body.accessToken?.trim()) {
          return Response.json({ error: "請選擇平台並填入 OAuth Access Token" }, { status: 400 });
        }
        // 雲端寫庫入口：不可再代理出去
        if (shouldProxyOAuthPersist(req)) {
          return Response.json(
            {
              error:
                "本機未設定 DATABASE_URL，且無法再轉發 raw token。請在 Vercel 確認已設定 DATABASE_URL，或於線上站台完成綁定。",
            },
            { status: 503 },
          );
        }
        const creds: OAuthCredentials = {
          provider: body.provider,
          accessToken: body.accessToken.trim(),
          refreshToken: body.refreshToken?.trim() ?? "",
          expiresAt:
            typeof body.expiresAt === "number" && body.expiresAt > Date.now()
              ? body.expiresAt
              : Date.now() + 3600_000,
          accountId: body.accountId?.trim() || undefined,
          projectId: body.projectId?.trim() || undefined,
          email: body.email?.trim() || undefined,
          planType:
            body.planType?.trim() ||
            (body.provider === "gemini" ? "Google AI Pro" : body.provider === "xai" ? "SuperGrok" : "PRO"),
        };
        const added = await addOAuthSubscriptionSource({
          creds,
          label: body.label,
          shareLimitPct: body.shareLimitPct,
        });
        return Response.json({ ok: true, ...added });
      }
      case "sync_quota": {
        if (shouldProxyOAuthPersist(req)) {
          const data = await persistOAuthViaCloud({
            action: "sync_quota",
            sourceId: body.sourceId,
          });
          return Response.json(data);
        }
        if (body.sourceId) {
          const quota = await syncSourceQuotaById(body.sourceId);
          return Response.json({ ok: true, quota });
        }
        await syncAllSubscriptionQuotas();
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "未知的 action" }, { status: 400 });
    }
  } catch (e) {
    return jsonError(e);
  }
}
