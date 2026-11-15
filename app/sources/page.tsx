"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface QuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  uiRemainingPercent?: number;
  uiUsedPercent?: number;
  resetAt: string | null;
}

interface SubscriptionQuota {
  planType: string;
  email?: string;
  windows: QuotaWindow[];
  primaryUsedPercent: number;
  primaryRemainingPercent: number;
  fetchedAt: number;
}

interface SourceStatus {
  id: string;
  label: string;
  kind: "supplier" | "platform";
  provider: "gemini" | "openai" | "anthropic" | "xai" | "openrouter";
  authType: "oauth_sub" | "api_key";
  keyHint: string;
  priority: number;
  monthlyCapPoints: number | null;
  shareLimitPct: number;
  quota: SubscriptionQuota | null;
  quotaUpdatedAt: number | null;
  enabled: boolean;
  fromEnv: boolean;
  delegatedToNode?: boolean;
  usedThisMonthPoints: number;
  cooldownUntil: number | null;
  lastError: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI ChatGPT",
  anthropic: "Anthropic Claude",
  xai: "xAI Grok",
  openrouter: "OpenRouter",
};

interface SupplierUsageRow {
  createdAt: number;
  model: string | null;
  upstreamModelVersion: string | null;
  quotaLabel: string | null;
  quotaUsedPct: number | null;
  quotaBeforePct: number | null;
  quotaAfterPct: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chargedPoints: number | null;
}

interface SupplierUsage {
  sourceId: string;
  label: string;
  quota: SubscriptionQuota | null;
  totalUsedPct: number;
  messages: number;
  chargedPoints: number;
  rows: SupplierUsageRow[];
}

function SupplierLedger() {
  const [data, setData] = useState<SupplierUsage[]>([]);
  useEffect(() => {
    const load = () =>
      fetch("/api/supplier-usage")
        .then((r) => r.json())
        .then(setData)
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (data.length === 0) return null;
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>供給者用量明細：平台實際用掉你多少 Google 額度</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.6 }}>
        每則對話前後都向 Google 讀一次該模型的剩餘額度，差值就是這一則實際扣掉你的量。這些扣在
        <strong> Antigravity 訂閱額度</strong>（例如 Gemini 4 Argon 週額度）；
        <strong>gemini.google.com 網頁後台不會顯示這個池</strong>，請以這裡或 Antigravity 的 /usage 為準。
      </p>
      {data.map((s) => (
        <div key={s.sourceId} style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <strong>{s.label}</strong>
            <span>
              近 7 天平台共用掉 <strong style={{ color: "var(--warn)", fontSize: 18 }}>{s.totalUsedPct.toFixed(3)}%</strong>
              ・{s.messages} 則・買家付 {s.chargedPoints.toFixed(2)} 點
            </span>
          </div>
          {s.quota && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Google 直接回報本週已用（含你自己在 Antigravity 的使用）：
              {s.quota.windows
                .filter((w) => /週/.test(w.label) && !/即時/.test(w.label))
                .map((w) => `${w.label} ${w.usedPercent.toFixed(2)}%`)
                .join("、")}
            </div>
          )}
          {s.rows.length > 0 && (
            <table style={{ marginTop: 8, fontSize: 12 }}>
              <thead>
                <tr>
                  <th>時間</th>
                  <th>模型（Google 確認）</th>
                  <th>額度池</th>
                  <th>這則扣掉</th>
                  <th>剩餘（前 → 後）</th>
                  <th>Token 入／出</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.slice(0, 20).map((r) => (
                  <tr key={r.createdAt}>
                    <td>{new Date(r.createdAt).toLocaleTimeString("zh-TW")}</td>
                    <td>{r.upstreamModelVersion ?? r.model}</td>
                    <td>{r.quotaLabel ?? "—"}</td>
                    <td>{r.quotaUsedPct != null ? `${r.quotaUsedPct.toFixed(3)}%` : "（未記錄）"}</td>
                    <td>
                      {r.quotaBeforePct != null && r.quotaAfterPct != null
                        ? `${r.quotaBeforePct.toFixed(2)}% → ${r.quotaAfterPct.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td>
                      {r.inputTokens ?? 0} / {r.outputTokens ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [localCli, setLocalCli] = useState<{ provider: "gemini" | "openai" | "xai"; path: string; hint: string }[]>([]);

  // OAuth 訂閱綁定狀態
  const [subLabel, setSubLabel] = useState("");
  const [shareLimitPct, setShareLimitPct] = useState(80);
  const [activeOAuthState, setActiveOAuthState] = useState<string | null>(null);
  const [activeAuthUrl, setActiveAuthUrl] = useState<string | null>(null);
  const [callbackInput, setCallbackInput] = useState("");
  const [deviceFlow, setDeviceFlow] = useState<{
    kind: "chatgpt" | "grok";
    state: string;
    userCode: string;
    verifyUrl: string;
  } | null>(null);
  const [oauthMsg, setOauthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 進階：直接貼 OAuth Token 測試
  const [rawProvider, setRawProvider] = useState<"gemini" | "openai" | "xai">("gemini");
  const [rawAccess, setRawAccess] = useState("");
  const [rawRefresh, setRawRefresh] = useState("");
  const [rawExtraId, setRawExtraId] = useState("");

  // 傳統 API Key 表單
  const [form, setForm] = useState({
    label: "",
    kind: "platform" as "supplier" | "platform",
    provider: "gemini" as "gemini" | "openai" | "anthropic" | "xai" | "openrouter",
    apiKey: "",
    priority: "",
    monthlyCapPoints: "",
  });
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const list = await (await fetch("/api/sources")).json();
    setSources(list);
  }, []);

  const syncAndRefresh = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync_quota" }),
      });
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  useEffect(() => {
    void syncAndRefresh();
    fetch("/api/oauth")
      .then((r) => r.json())
      .then((d) => setLocalCli(d.localCli ?? []))
      .catch(() => {});
    const t = setInterval(() => void syncAndRefresh(), 30_000);
    return () => clearInterval(t);
  }, [syncAndRefresh]);

  // 輪詢 ChatGPT／Grok 裝置碼驗證狀態
  useEffect(() => {
    if (!deviceFlow) return;
    const timer = setInterval(async () => {
      try {
        const action = deviceFlow.kind === "grok" ? "poll_grok_device" : "poll_chatgpt_device";
        const res = await fetch("/api/oauth", {
          method: "POST",
          body: JSON.stringify({ action, state: deviceFlow.state }),
        });
        const data = await res.json();
        if (data.status === "completed") {
          setDeviceFlow(null);
          setOauthMsg({
            ok: true,
            text:
              deviceFlow.kind === "grok"
                ? "✓ Grok／SuperGrok 訂閱連結成功！已自動讀取剩餘容量"
                : "✓ ChatGPT Plus/Pro 訂閱連結成功！已自動讀取剩餘容量",
          });
          refresh();
        } else if (data.error) {
          setOauthMsg({ ok: false, text: data.error });
          setDeviceFlow(null);
        }
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [deviceFlow, refresh]);

  async function startBrowserOAuth(action: "start_gemini" | "start_chatgpt_browser") {
    setOauthMsg(null);
    setDeviceFlow(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({ action, label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setActiveOAuthState(data.state);
    setActiveAuthUrl(data.authUrl);
    window.open(data.authUrl, "_blank", "noopener,noreferrer");
  }

  async function startChatGptDevice() {
    setOauthMsg(null);
    setActiveAuthUrl(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({ action: "start_chatgpt_device", label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setDeviceFlow({ kind: "chatgpt", state: data.state, userCode: data.userCode, verifyUrl: data.verifyUrl });
    window.open(data.verifyUrl, "_blank", "noopener,noreferrer");
  }

  async function startGrokDevice() {
    setOauthMsg(null);
    setActiveAuthUrl(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({ action: "start_grok_device", label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    const verifyUrl = data.verifyUrlComplete || data.verifyUrl;
    setDeviceFlow({ kind: "grok", state: data.state, userCode: data.userCode, verifyUrl });
    window.open(verifyUrl, "_blank", "noopener,noreferrer");
  }

  async function submitCallbackUrl() {
    if (!callbackInput.trim()) return;
    setOauthMsg(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({
        action: "complete_code",
        codeOrUrl: callbackInput.trim(),
        state: activeOAuthState ?? undefined,
        label: subLabel,
        shareLimitPct,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setOauthMsg({ ok: true, text: "✓ 訂閱帳號綁定成功！已同步剩餘容量" });
    setCallbackInput("");
    setActiveAuthUrl(null);
    setSubLabel("");
    refresh();
  }

  async function importCli(provider: "gemini" | "openai" | "xai") {
    setOauthMsg(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({ action: "import_local_cli", provider, label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setOauthMsg({ ok: true, text: "✓ 已匯入本機訂閱帳號並同步剩餘容量" });
    refresh();
  }

  async function submitRawToken() {
    if (!rawAccess.trim()) return;
    setOauthMsg(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({
        action: "import_raw_token",
        provider: rawProvider,
        accessToken: rawAccess,
        refreshToken: rawRefresh,
        accountId: rawProvider === "openai" ? rawExtraId : undefined,
        projectId: rawProvider === "gemini" ? rawExtraId : undefined,
        label: subLabel,
        shareLimitPct,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setOauthMsg({ ok: true, text: "✓ 訂閱 Token 已加入並同步剩餘容量！" });
    setRawAccess("");
    setRawRefresh("");
    setRawExtraId("");
    refresh();
  }

  async function syncQuotas(sourceId?: string) {
    setSyncing(true);
    await fetch("/api/oauth", {
      method: "POST",
      body: JSON.stringify({ action: "sync_quota", sourceId }),
    });
    await refresh();
    setSyncing(false);
  }

  async function addApiKey() {
    setSavingKey(true);
    setKeyMsg(null);
    const res = await fetch("/api/sources", {
      method: "POST",
      body: JSON.stringify({
        label: form.label,
        kind: form.kind,
        provider: form.provider,
        apiKey: form.apiKey,
        priority: form.priority ? Number(form.priority) : undefined,
        monthlyCapPoints: form.monthlyCapPoints ? Number(form.monthlyCapPoints) : null,
      }),
    });
    const data = await res.json();
    setSavingKey(false);
    if (!res.ok) {
      setKeyMsg({ ok: false, text: data.error });
      return;
    }
    setKeyMsg({ ok: true, text: "已驗證並加入 API Key" });
    setForm((f) => ({ ...f, label: "", apiKey: "" }));
    refresh();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    refresh();
  }

  async function remove(id: string) {
    if (!confirm("確定移除這個貨源？")) return;
    await fetch(`/api/sources/${id}`, { method: "DELETE" });
    refresh();
  }

  const [gate, setGate] = useState<"loading" | "ok" | "deny">("loading");
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const allowed = Boolean(d.user?.isSupplier || d.user?.isAdmin);
        setIsAdmin(Boolean(d.user?.isAdmin));
        setGate(allowed ? "ok" : "deny");
      })
      .catch(() => setGate("deny"));
  }, []);

  if (gate === "loading") {
    return (
      <div className="page">
        <p className="muted">驗證供給者權限…</p>
      </div>
    );
  }
  if (gate === "deny") {
    return (
      <div className="page">
        <h1>供給者專區</h1>
        <p className="muted">請用「供給者」帳號登入後再進入此頁綁定訂閱。</p>
        <Link href="/">← 回首頁</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>供給者 · 訂閱貨源</h1>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          {isAdmin && <Link href="/admin">管理後台</Link>}
          {isAdmin && <Link href="/nodes">Node Agent</Link>}
          {isAdmin && <Link href="/">買家聊天</Link>}
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/";
            }}
          >
            登出
          </button>
        </div>
      </div>
      <p className="muted">
        在此綁定你的 Gemini／ChatGPT／Grok 訂閱或 API Key，釋出閒置額度給平台買家水庫。
        Node Agent 為可選加強；未啟動時平台仍可依 C=1 規則調度你的訂閱貨源。
      </p>

      <SupplierLedger />

      {/* === 做法 1：OAuth 訂閱帳號連結（Gemini AI Pro + ChatGPT Plus/Pro） === */}
      <div className="card" style={{ borderColor: "var(--ok)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0, color: "var(--ok)" }}>
            ★ 做法 1：連結供給者月費訂閱帳號（OAuth 免外掛，支援手機與多帳號接力）
          </h3>
          <button onClick={() => syncQuotas()} disabled={syncing}>
            {syncing ? "同步中…" : "🔄 立即同步所有訂閱剩餘容量"}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          可同時綁定 <strong>1 個 Gemini AI Pro + 1 個 ChatGPT Plus/Pro</strong>，或 <strong>2 個以上 Gemini AI Pro 帳號</strong>。當第 1 個帳號達到你設定的釋出上限或 5 小時冷卻時，系統會自動無縫切換到第 2 個帳號繼續回答。
        </p>

        <div className="form-grid" style={{ marginBottom: 14 }}>
          <label>
            帳號別名（選填，方便分辨第 1 / 第 2 個帳號）
            <input
              value={subLabel}
              placeholder="例如：我的 Gemini AI Pro #1"
              onChange={(e) => setSubLabel(e.target.value)}
            />
          </label>
          <label>
            願意釋出的最大容量比例：{shareLimitPct}%（保留 {100 - shareLimitPct}% 給自己）
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={shareLimitPct}
              onChange={(e) => setShareLimitPct(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button className="primary" onClick={() => startBrowserOAuth("start_gemini")}>
            🔗 連結 Google Gemini AI Pro / Ultra（OAuth 登入）
          </button>
          <button className="primary" onClick={startChatGptDevice}>
            📱 連結 ChatGPT Plus / Pro（手機 / 網頁裝置碼，最推薦）
          </button>
          <button onClick={() => startBrowserOAuth("start_chatgpt_browser")}>
            💻 連結 ChatGPT Plus / Pro（本機瀏覽器 OAuth）
          </button>
          <button className="primary" onClick={startGrokDevice}>
            📱 連結 Grok／SuperGrok（手機 / 網頁裝置碼）
          </button>
          {localCli.map((c) => (
            <button key={c.path} onClick={() => importCli(c.provider)}>
              ⚡ 一鍵匯入本機已登入{" "}
              {c.provider === "gemini" ? "Gemini" : c.provider === "xai" ? "Grok" : "ChatGPT"} ({c.hint})
            </button>
          ))}
        </div>

        {deviceFlow && (
          <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
            <div>
              請在開啟的 {deviceFlow.kind === "grok" ? "xAI／Grok" : "OpenAI"} 官方頁面（或用手機打開{" "}
              <a href={deviceFlow.verifyUrl} target="_blank" rel="noreferrer">
                {deviceFlow.verifyUrl}
              </a>
              ）輸入以下裝置碼（代碼在本頁，不是終端機）：
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 3, margin: "10px 0", color: "var(--ok)" }}>
              {deviceFlow.userCode}
            </div>
            <div className="muted">
              輸入並按允許後，這裡會自動偵測完成並讀取你的{" "}
              {deviceFlow.kind === "grok" ? "Grok" : "ChatGPT"} 訂閱剩餘容量…
            </div>
          </div>
        )}

        {activeAuthUrl && (
          <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
            <div style={{ marginBottom: 8 }}>
              <strong>本機登入：</strong>在彈出視窗登入同意後，本機監聽器會自動完成綁定。
              <br />
              <strong>手機或跨裝置登入：</strong>若在手機打開{" "}
              <a href={activeAuthUrl} target="_blank" rel="noreferrer">
                授權連結
              </a>{" "}
              登入後跳轉到 <code>localhost</code> 顯示無法連線，直接複製網址列整串 <code>http://localhost...</code> 貼在下方即可：
            </div>
            <div className="row">
              <input
                style={{ flex: 1 }}
                value={callbackInput}
                placeholder="貼上 http://localhost:51121/oauth-callback?code=... 或 code"
                onChange={(e) => setCallbackInput(e.target.value)}
              />
              <button className="primary" onClick={submitCallbackUrl}>
                完成綁定
              </button>
            </div>
          </div>
        )}

        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
            進階：直接貼上已有 OAuth Access / Refresh Token 綁定
          </summary>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>
              訂閱平台
              <select
                value={rawProvider}
                onChange={(e) => setRawProvider(e.target.value as "gemini" | "openai" | "xai")}
              >
                <option value="gemini">Google Gemini AI Pro / Ultra</option>
                <option value="openai">OpenAI ChatGPT Plus / Pro</option>
                <option value="xai">xAI Grok／SuperGrok</option>
              </select>
            </label>
            <label>
              {rawProvider === "gemini" ? "Project ID（選填，留空自動取得）" : "ChatGPT Account ID（選填）"}
              <input value={rawExtraId} onChange={(e) => setRawExtraId(e.target.value)} />
            </label>
            <label>
              OAuth Access Token
              <input type="password" value={rawAccess} onChange={(e) => setRawAccess(e.target.value)} />
            </label>
            <label>
              OAuth Refresh Token（選填，用於自動續期）
              <input type="password" value={rawRefresh} onChange={(e) => setRawRefresh(e.target.value)} />
            </label>
            <div className="full">
              <button onClick={submitRawToken} disabled={!rawAccess.trim()}>
                加入訂閱 Token 並讀取容量
              </button>
            </div>
          </div>
        </details>

        {oauthMsg && (
          <div style={{ marginTop: 10, color: oauthMsg.ok ? "var(--ok)" : "var(--danger)" }}>{oauthMsg.text}</div>
        )}
      </div>

      <div className="card" style={{ borderColor: "var(--ok)" }}>
        <h2 style={{ marginTop: 0 }}>買家任務請用 Node Agent</h2>
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
          舊版「平台領 Token 再代發」已退役。供給者在本機執行 Agent（Long Poll），平台只派
          model＋messages；OAuth／API Key 留在供給者電腦。
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link href="/nodes">前往 Node Agent 狀態頁 →</Link>
          <span className="muted">　指令：</span>
          <code>npm run node-agent -- register</code>
          <span className="muted"> → </span>
          <code>npm run node-agent -- start</code>
        </p>
      </div>

      {/* === 目前貨源與即時訂閱剩餘容量表 === */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>目前貨源與訂閱剩餘容量（依實際派發順序）</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.5 }}>
          以下數字只讀 Antigravity Hub（daily-cloudcode-pa），對齊官方 <strong>Models &amp; Usage</strong>：
          <strong>Gemini 總額</strong>、<strong>Gemini 4 Argon</strong>、以及
          <strong>Claude and GPT models</strong>（顯示為 Claude／GPT 第三方）。
          不再 fallback 到 Gemini CLI 池，避免跟官方 95%／96% 脫鉤。點「立即同步」可重抓。
        </p>
        <table>
          <thead>
            <tr>
              <th>名稱 / 帳號</th>
              <th>模式</th>
              <th>模型商</th>
              <th>Antigravity 訂閱即時剩餘（對齊官方 Models &amp; Usage）</th>
              <th>釋出上限</th>
              <th>優先序</th>
              <th>狀態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...sources]
              .sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === "supplier" ? -1 : 1;
                if (a.authType !== b.authType) return a.authType === "oauth_sub" ? -1 : 1;
                return a.priority - b.priority;
              })
              .map((s) => (
                <tr key={s.id}>
                  <td>
                    <div>{s.label}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {s.keyHint}
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${s.kind}`}>
                      {s.authType === "oauth_sub"
                        ? "供給者 OAuth 訂閱"
                        : s.kind === "supplier"
                          ? "供給者 API Key"
                          : "平台直連 API"}
                    </span>
                  </td>
                  <td>{PROVIDER_LABEL[s.provider] ?? s.provider}</td>
                  <td style={{ minWidth: 250 }}>
                    {s.authType === "oauth_sub" && s.quota ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {s.quota.windows.map((w, i) => (
                          <div key={i}>
                            <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                              <span>{w.label}</span>
                              <span>
                                剩餘{" "}
                                <strong>{w.uiRemainingPercent ?? Math.round(w.remainingPercent)}%</strong>
                                <span className="muted">（精確 {w.remainingPercent.toFixed(2)}%，已用 {w.usedPercent.toFixed(2)}%）</span>
                              </span>
                            </div>
                            <div
                              style={{
                                height: 7,
                                background: "var(--panel-2)",
                                borderRadius: 4,
                                overflow: "hidden",
                                marginTop: 2,
                              }}
                            >
                              <div
                                style={{
                                  width: `${Math.min(100, w.remainingPercent)}%`,
                                  height: "100%",
                                  background:
                                    w.usedPercent >= s.shareLimitPct
                                      ? "var(--warn)"
                                      : w.remainingPercent > 30
                                        ? "var(--ok)"
                                        : "var(--danger)",
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">
                        本月已用 {s.usedThisMonthPoints.toFixed(2)} / {s.monthlyCapPoints ?? "不限"} 點
                      </span>
                    )}
                  </td>
                  <td>
                    {s.authType === "oauth_sub" ? (
                      <select
                        value={s.shareLimitPct}
                        onChange={(e) => patch(s.id, { shareLimitPct: Number(e.target.value) })}
                      >
                        {[20, 40, 60, 80, 90, 100].map((pct) => (
                          <option key={pct} value={pct}>
                            最多用 {pct}%
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {s.fromEnv ? (
                      s.priority
                    ) : (
                      <input
                        style={{ width: 64 }}
                        defaultValue={s.priority}
                        onBlur={(e) =>
                          Number(e.target.value) !== s.priority && patch(s.id, { priority: Number(e.target.value) })
                        }
                      />
                    )}
                  </td>
                  <td>
                    {!s.enabled ? (
                      <span className="muted">已暫停</span>
                    ) : s.cooldownUntil ? (
                      <span className="notice" title={s.lastError ?? ""}>
                        冷卻中（{Math.ceil((s.cooldownUntil - Date.now()) / 1000)} 秒）
                      </span>
                    ) : s.authType === "oauth_sub" && s.quota && s.quota.primaryUsedPercent >= s.shareLimitPct ? (
                      <span className="notice">已達釋出上限（保護自用額度中）</span>
                    ) : (
                      <span style={{ color: "var(--ok)" }}>可用</span>
                    )}
                    {s.lastError && !s.cooldownUntil && (
                      <div className="muted" style={{ fontSize: 12 }} title={s.lastError}>
                        上次錯誤：{s.lastError.slice(0, 36)}
                      </div>
                    )}
                  </td>
                  <td>
                    {s.fromEnv ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        來自環境變數
                      </span>
                    ) : (
                      <div className="row">
                        {s.authType === "oauth_sub" && (
                          <button onClick={() => syncQuotas(s.id)} disabled={syncing}>
                            同步
                          </button>
                        )}
                        <button onClick={() => patch(s.id, { enabled: !s.enabled })}>{s.enabled ? "暫停" : "啟用"}</button>
                        <button onClick={() => remove(s.id)}>移除</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            {sources.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  還沒有任何貨源，請從上方連結你的 Gemini AI Pro 或 ChatGPT Plus/Pro 訂閱帳號
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* === 備援：平台直連大廠 API Key === */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>新增大廠 API Key（當所有供給者訂閱額度滿載時的保底通道）</h3>
        <div className="form-grid">
          <label>
            類型
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "supplier" | "platform" })}>
              <option value="platform">平台直連保底</option>
              <option value="supplier">供給者 API Key</option>
            </select>
          </label>
          <label>
            模型商
            <select
              value={form.provider}
              onChange={(e) =>
                setForm({
                  ...form,
                  provider: e.target.value as "gemini" | "openai" | "anthropic" | "xai" | "openrouter",
                })
              }
            >
              <option value="gemini">Google Gemini API</option>
              <option value="openai">OpenAI API</option>
              <option value="anthropic">Anthropic API</option>
              <option value="xai">xAI Grok API</option>
              <option value="openrouter">OpenRouter（全模型備援）</option>
            </select>
          </label>
          <label>
            名稱
            <input value={form.label} placeholder="例如：平台保底 Gemini Key" onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={form.apiKey}
              placeholder="AIza... 或 sk-..."
              autoComplete="off"
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </label>
          <div className="full row">
            <button onClick={addApiKey} disabled={savingKey || !form.apiKey.trim()}>
              {savingKey ? "驗證中…" : "驗證並加入 API Key"}
            </button>
            {keyMsg && <span className={keyMsg.ok ? "" : "error"}>{keyMsg.text}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
