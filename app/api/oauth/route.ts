import { createServer, type Server } from "node:http";
import {
  completeOAuthByCode,
  detectLocalCliCredentials,
  importLocalCliCredential,
  pollChatGptDeviceFlow,
  pollGrokDeviceFlow,
  startChatGptDeviceFlow,
  startChatGptOAuth,
  startGeminiOAuth,
  startGrokDeviceFlow,
  type OAuthCredentials,
} from "@/lib/oauth";
import {
  addOAuthSubscriptionSource,
  syncAllSubscriptionQuotas,
  syncSourceQuotaById,
} from "@/lib/sources";
import { jsonError, requireSupplier } from "@/lib/auth";

export const dynamic = "force-dynamic";

const globalForServers = globalThis as unknown as {
  __geminiCallbackServer?: Server;
  __chatgptCallbackServer?: Server;
  __callbackVersion?: number;
};

const CALLBACK_VERSION = 2;

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
        const { creds, label, shareLimitPct } = await completeOAuthByCode({ codeOrUrl: fullUrl });
        await addOAuthSubscriptionSource({ creds, label, shareLimitPct });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="background:#0f1115;color:#e6e8ec;font-family:sans-serif;text-align:center;padding-top:15vh">
          <h2 style="color:#3fb37f">✓ 訂閱帳號連結成功！已同步剩餘容量</h2>
          <p>這個視窗會自動跳回 AI 用量平台。</p>
          <script>setTimeout(()=>{location.href="http://127.0.0.1:3000/sources"},800)</script>
        </body></html>`);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="background:#0f1115;color:#e05d5d;font-family:sans-serif;text-align:center;padding-top:15vh">
          <h2>授權失敗</h2><p>${e instanceof Error ? e.message : String(e)}</p>
          <p><a href="http://127.0.0.1:3000/sources" style="color:#5b8cff">← 回到設定頁重試</a></p>
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
    return Response.json({
      localCli: detectLocalCliCredentials(),
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
      sourceId?: string;
    };

    switch (body.action) {
      case "start_gemini": {
        ensureLocalCallbackListener(51121, "/oauth-callback");
        const res = startGeminiOAuth({ label: body.label, shareLimitPct: body.shareLimitPct });
        return Response.json(res);
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
        const added = await addOAuthSubscriptionSource({
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
        const added = await addOAuthSubscriptionSource({
          creds: r.creds,
          label: r.label,
          shareLimitPct: r.shareLimitPct,
        });
        return Response.json({ status: "completed", ...added });
      }
      case "complete_code": {
        if (!body.codeOrUrl) return Response.json({ error: "請貼上授權回呼網址或 code" }, { status: 400 });
        const { creds, label, shareLimitPct } = await completeOAuthByCode({
          codeOrUrl: body.codeOrUrl,
          state: body.state,
        });
        const added = await addOAuthSubscriptionSource({
          creds,
          label: body.label || label,
          shareLimitPct: body.shareLimitPct ?? shareLimitPct,
        });
        return Response.json({ ok: true, ...added });
      }
      case "import_local_cli": {
        if (!body.provider) return Response.json({ error: "請指定 provider" }, { status: 400 });
        const creds = await importLocalCliCredential(body.provider);
        const added = await addOAuthSubscriptionSource({
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
        const creds: OAuthCredentials = {
          provider: body.provider,
          accessToken: body.accessToken.trim(),
          refreshToken: body.refreshToken?.trim() ?? "",
          expiresAt: Date.now() + 3600_000,
          accountId: body.accountId?.trim() || undefined,
          projectId: body.projectId?.trim() || undefined,
          planType:
            body.provider === "gemini" ? "Google AI Pro" : body.provider === "xai" ? "SuperGrok" : "PRO",
        };
        const added = await addOAuthSubscriptionSource({
          creds,
          label: body.label,
          shareLimitPct: body.shareLimitPct,
        });
        return Response.json({ ok: true, ...added });
      }
      case "sync_quota": {
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
