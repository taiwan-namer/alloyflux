"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface QuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  uiRemainingPercent?: number;
  resetAt: string | null;
}

interface SubscriptionQuota {
  planType: string;
  email?: string;
  windows: QuotaWindow[];
  primaryRemainingPercent: number;
  fetchedAt: number;
}

interface SourceStatus {
  id: string;
  label: string;
  kind: "supplier" | "platform";
  provider: "gemini" | "openai" | "anthropic" | "xai" | "openrouter";
  authType: "oauth_sub" | "api_key";
  shareLimitPct: number;
  quota: SubscriptionQuota | null;
  enabled: boolean;
}

const TERMS_NAME = "《AI 工作流託管與開源評測合作條款》";

const FRAMEWORK_ROWS: { role: string; value: string; note: string }[] = [
  {
    role: "夥伴身分",
    value: "算力節點夥伴（Node Partner）或 AI 工作流創作者",
    note: "以創作者與節點託管夥伴身分參與平台，自訂安全托管比例。",
  },
  {
    role: "夥伴分潤（80% 回饋）",
    value: "AI 工作流／Agent 創作者上架分潤 或 開源模型評測獎勵金",
    note: "依節點實際完成之智慧路由任務結算，享有 80% 創作者回饋。",
  },
  {
    role: "買家方案（199 / 299 / 399）",
    value: "雲端工作台軟體服務費（SaaS 平台技術服務費）",
    note: "使用者開通雲端工作台軟體服務之平台技術服務費。",
  },
  {
    role: "調度機制",
    value: "多節點智慧路由託管與負載平衡測試",
    note: "於多個已授權節點間自動進行容量保護、智慧路由與負載平衡測試。",
  },
  {
    role: "平台條款",
    value: TERMS_NAME,
    note: "授權接入前請詳閱；點擊右側按鈕可展開條款重點摘要。",
  },
];

const TERMS_SUMMARY: { title: string; body: string }[] = [
  {
    title: "一、合作定位",
    body: "夥伴以 AI 工作流創作者與算力節點夥伴身分，將具合法授權之模型工作流接入平台節點，參與多節點智慧路由託管與負載平衡測試。",
  },
  {
    title: "二、安全托管門檻",
    body: "夥伴可自訂願意託管之容量比例（預設 80%，保留 20% 自用）；達到門檻時系統自動停止派發任務，保障夥伴自用權益。",
  },
  {
    title: "三、80% 創作者上架分潤",
    body: "依節點實際完成之託管評測與工作流任務，結算 AI 工作流／Agent 創作者上架分潤（80% 回饋）或開源模型評測獎勵金。",
  },
  {
    title: "四、隨時啟停與撤銷",
    body: "夥伴可隨時於節點清單一鍵暫停派發或移除授權，立即生效。",
  },
];

const VALUE_CARDS: { icon: string; title: string; body: string }[] = [
  {
    icon: "🛰️",
    title: "選模組即刻 OAuth 接入",
    body: "無需註冊額外帳號密碼，直接選擇模型模組完成 Google OAuth 或官方裝置碼授權，系統即自動同步剩餘容量。",
  },
  {
    icon: "🛡️",
    title: "多節點智慧路由託管",
    body: "自訂安全託管上限（如釋出 80%、保留 20%），參與多節點智慧路由託管與負載平衡測試，達上限自動保護停派。",
  },
  {
    icon: "💰",
    title: "80% 創作者上架分潤",
    body: "依實際完成之工作流任務，領取 AI 工作流／Agent 創作者上架分潤（80% 回饋）或開源模型評測獎勵金。",
  },
];

type ModuleKind = "gemini" | "chatgpt" | "grok";

export default function VendorPage() {
  const [agreed, setAgreed] = useState(true);
  const [termsOpen, setTermsOpen] = useState(false);

  const [selectedModule, setSelectedModule] = useState<ModuleKind>("gemini");
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
  const [busy, setBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refreshSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      if (res.ok) {
        const list = (await res.json()) as SourceStatus[];
        setSources(Array.isArray(list) ? list.filter((s) => s.authType === "oauth_sub") : []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // 輪詢 ChatGPT / Grok 裝置碼狀態，授權成功立即自動啟用
  useEffect(() => {
    if (!deviceFlow) return;
    const timer = setInterval(async () => {
      try {
        const action = deviceFlow.kind === "grok" ? "poll_grok_device" : "poll_chatgpt_device";
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, state: deviceFlow.state }),
        });
        const data = await res.json();
        if (data.status === "completed") {
          setDeviceFlow(null);
          setOauthMsg({
            ok: true,
            text:
              deviceFlow.kind === "grok"
                ? "✓ Grok 模組 OAuth 連結成功！已自動讀取剩餘容量並加入智慧路由池"
                : "✓ ChatGPT 模組 OAuth 連結成功！已自動讀取剩餘容量並加入智慧路由池",
          });
          void refreshSources();
        } else if (data.error) {
          setOauthMsg({ ok: false, text: data.error });
          setDeviceFlow(null);
        }
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [deviceFlow, refreshSources]);

  async function startModuleOAuth() {
    if (!agreed) {
      setOauthMsg({ ok: false, text: `請先勾選同意${TERMS_NAME}` });
      return;
    }
    setOauthMsg(null);
    setDeviceFlow(null);
    setActiveAuthUrl(null);
    setBusy(true);
    try {
      if (selectedModule === "gemini") {
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_gemini", label: subLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          setOauthMsg({ ok: false, text: data.error || "啟動 Google OAuth 失敗" });
          return;
        }
        setActiveOAuthState(data.state);
        setActiveAuthUrl(data.authUrl);
        window.open(data.authUrl, "_blank", "noopener,noreferrer");
      } else if (selectedModule === "chatgpt") {
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_chatgpt_device", label: subLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          setOauthMsg({ ok: false, text: data.error || "啟動 ChatGPT OAuth 失敗" });
          return;
        }
        setDeviceFlow({ kind: "chatgpt", state: data.state, userCode: data.userCode, verifyUrl: data.verifyUrl });
        window.open(data.verifyUrl, "_blank", "noopener,noreferrer");
      } else {
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_grok_device", label: subLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          setOauthMsg({ ok: false, text: data.error || "啟動 Grok OAuth 失敗" });
          return;
        }
        const verifyUrl = data.verifyUrlComplete || data.verifyUrl;
        setDeviceFlow({ kind: "grok", state: data.state, userCode: data.userCode, verifyUrl });
        window.open(verifyUrl, "_blank", "noopener,noreferrer");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCallbackUrl() {
    if (!callbackInput.trim()) return;
    setBusy(true);
    setOauthMsg(null);
    try {
      const res = await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        setOauthMsg({ ok: false, text: data.error || "完成授權失敗" });
        return;
      }
      setOauthMsg({ ok: true, text: "✓ Google OAuth 授權連結成功！已自動同步剩餘容量並投入多節點智慧路由" });
      setCallbackInput("");
      setActiveAuthUrl(null);
      setSubLabel("");
      await refreshSources();
    } finally {
      setBusy(false);
    }
  }

  async function syncAllQuotas() {
    setSyncing(true);
    try {
      await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync_quota" }),
      });
      await refreshSources();
    } finally {
      setSyncing(false);
    }
  }

  async function toggleEnabled(s: SourceStatus) {
    await fetch(`/api/sources/${s.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    void refreshSources();
  }

  return (
    <div className="vendor-page">
      <header className="vendor-header">
        <div className="vendor-brand">
          <span className="vendor-badge">NODE PARTNER</span>
          <strong>算力節點夥伴專區</strong>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <Link href="/sources" className="vendor-back">
            進階節點明細 →
          </Link>
          <Link href="/" className="vendor-back">
            ← 返回雲端工作台（聊天首頁）
          </Link>
        </div>
      </header>

      <main className="vendor-main">
        <section className="vendor-hero">
          <h1>成為算力節點夥伴・參與 AI 工作流創作者計畫</h1>
          <p className="vendor-lead">
            選擇您要託管的 AI 模組並透過官方 <strong>OAuth 授權登入</strong>（免註冊網站帳號密碼），即可參與
            <strong>多節點智慧路由託管與負載平衡測試</strong>，並領取
            <strong> 80% AI 工作流／Agent 創作者上架分潤（開源模型評測獎勵金）</strong>。
          </p>
        </section>

        {/* === 核心：選模組 → 直接 Google / 官方 OAuth 授權接入 === */}
        <section className="card vendor-card vendor-auth" id="join" style={{ borderColor: "var(--ok)" }}>
          <div className="vendor-card-head">
            <div>
              <h2 style={{ margin: 0 }}>步驟 1：選擇託管模組並進行 OAuth 授權</h2>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                免填帳號密碼——選好模組後直接以 Google OAuth 或官方裝置碼登入，授權完成即刻同步可用容量。
              </p>
            </div>
          </div>

          {/* 模組選擇卡片 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 12,
              margin: "16px 0",
            }}
          >
            <button
              type="button"
              onClick={() => setSelectedModule("gemini")}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: 12,
                border: selectedModule === "gemini" ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: selectedModule === "gemini" ? "rgba(91, 140, 255, 0.14)" : "var(--panel-2)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                ✦ Google Gemini 模組 {selectedModule === "gemini" ? "（已選）" : ""}
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                Gemini AI Pro / Ultra（含 Gemini、Claude、GPT-OSS 多模型池）· <strong>Google OAuth 直接登入</strong>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setSelectedModule("chatgpt")}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: 12,
                border: selectedModule === "chatgpt" ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: selectedModule === "chatgpt" ? "rgba(91, 140, 255, 0.14)" : "var(--panel-2)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                ◎ OpenAI ChatGPT 模組 {selectedModule === "chatgpt" ? "（已選）" : ""}
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                ChatGPT Plus / Pro（GPT-6 / 5.6 全系列）· <strong>官方 OAuth 裝置碼登入</strong>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setSelectedModule("grok")}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: 12,
                border: selectedModule === "grok" ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: selectedModule === "grok" ? "rgba(91, 140, 255, 0.14)" : "var(--panel-2)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                𝕏 xAI Grok 模組 {selectedModule === "grok" ? "（已選）" : ""}
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                Grok / SuperGrok（Grok 4.7 / 4.6 / 4.5）· <strong>官方 OAuth 裝置碼登入</strong>
              </div>
            </button>
          </div>

          <div className="form-grid" style={{ marginBottom: 14 }}>
            <label>
              節點別名（選填，方便辨識多組節點）
              <input
                value={subLabel}
                placeholder="例如：我的主力 Gemini 節點 #1"
                onChange={(e) => setSubLabel(e.target.value)}
              />
            </label>
            <label>
              託管容量上限：{shareLimitPct}%（自動為您保留 {100 - shareLimitPct}% 自用緩衝）
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

          <label className="vendor-agree" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              我已閱讀並同意{TERMS_NAME}
              <button type="button" className="ghost vendor-inline-link" onClick={() => setTermsOpen(true)}>
                查看條款摘要
              </button>
            </span>
          </label>

          <button
            type="button"
            className="vendor-google"
            style={{ width: "100%", justifyContent: "center", cursor: agreed && !busy ? "pointer" : "not-allowed" }}
            disabled={!agreed || busy}
            onClick={() => void startModuleOAuth()}
          >
            {selectedModule === "gemini" ? (
              <>
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                {busy ? "正在開啟 Google OAuth…" : "使用 Google OAuth 登入並接入 Gemini 算力節點"}
              </>
            ) : selectedModule === "chatgpt" ? (
              <>{busy ? "正在產生授權碼…" : "開啟 OpenAI OAuth 授權並接入 ChatGPT 算力節點"}</>
            ) : (
              <>{busy ? "正在產生授權碼…" : "開啟 xAI OAuth 授權並接入 Grok 算力節點"}</>
            )}
          </button>

          {/* Google OAuth 回呼網址貼上區（雲端環境完成 Google 登入後貼回網址即綁定） */}
          {activeAuthUrl && (
            <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
              <div style={{ marginBottom: 8, lineHeight: 1.6, fontSize: 13 }}>
                <strong>完成 Google OAuth 最後一步：</strong>
                <br />
                在新開的{" "}
                <a href={activeAuthUrl} target="_blank" rel="noreferrer">
                  Google 官方授權視窗
                </a>{" "}
                點選允許後，瀏覽器網址列會跳轉至 <code>http://localhost:51121/oauth-callback?code=...</code>
                （顯示無法連上此網站屬正常現象）。請<strong>整串複製該網址列的網址</strong>貼在下方，即可立即啟用節點：
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <input
                  style={{ flex: 1, minWidth: 220 }}
                  value={callbackInput}
                  placeholder="貼上 http://localhost:51121/oauth-callback?code=... 整串網址"
                  onChange={(e) => setCallbackInput(e.target.value)}
                />
                <button type="button" className="primary" disabled={busy || !callbackInput.trim()} onClick={() => void submitCallbackUrl()}>
                  {busy ? "驗證同步中…" : "完成綁定並啟用"}
                </button>
              </div>
            </div>
          )}

          {/* ChatGPT / Grok 裝置碼顯示區 */}
          {deviceFlow && (
            <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                請在開啟的{" "}
                <a href={deviceFlow.verifyUrl} target="_blank" rel="noreferrer">
                  {deviceFlow.kind === "grok" ? "xAI 官方授權頁" : "OpenAI 官方授權頁"}
                </a>{" "}
                輸入以下驗證碼：
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 3, margin: "10px 0", color: "var(--ok)" }}>
                {deviceFlow.userCode}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                在官方頁面按下允許後，本頁每 3 秒自動偵測並讀取剩餘容量，無需手動重新整理…
              </div>
            </div>
          )}

          {oauthMsg && (
            <div style={{ marginTop: 12, fontWeight: 600, color: oauthMsg.ok ? "var(--ok)" : "var(--danger)" }}>
              {oauthMsg.text}
            </div>
          )}
        </section>

        {/* === 已接入的算力節點與即時可用容量 === */}
        {sources.length > 0 && (
          <section className="card vendor-card">
            <div className="vendor-card-head">
              <h2 style={{ margin: 0 }}>目前運作中的算力節點（{sources.length}）</h2>
              <button type="button" onClick={() => void syncAllQuotas()} disabled={syncing}>
                {syncing ? "同步中…" : "🔄 同步最新容量"}
              </button>
            </div>
            <div className="vendor-table-wrap" style={{ marginTop: 10 }}>
              <table className="vendor-table">
                <thead>
                  <tr>
                    <th>節點名稱</th>
                    <th>模組</th>
                    <th>即時剩餘容量</th>
                    <th>託管上限</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.label}</strong>
                        {s.quota?.email && <div className="muted" style={{ fontSize: 12 }}>{s.quota.email}</div>}
                      </td>
                      <td>{s.provider.toUpperCase()}</td>
                      <td>
                        {s.quota ? (
                          <div style={{ display: "grid", gap: 4 }}>
                            {s.quota.windows.slice(0, 3).map((w) => (
                              <span key={w.label} style={{ fontSize: 12 }}>
                                {w.label}：<strong>{Math.round(w.uiRemainingPercent ?? w.remainingPercent)}%</strong>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">待同步</span>
                        )}
                      </td>
                      <td>{s.shareLimitPct}%</td>
                      <td>
                        <button type="button" onClick={() => void toggleEnabled(s)}>
                          {s.enabled ? "🟢 託管派發中（點此暫停）" : "⏸ 已暫停（點此啟用）"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="vendor-values">
          {VALUE_CARDS.map((c) => (
            <article key={c.title} className="vendor-value-card">
              <div className="vendor-value-icon" aria-hidden>
                {c.icon}
              </div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </article>
          ))}
        </section>

        {/* === 雙邊角色與金流合規正式名目一覽 === */}
        <section className="card vendor-card" id="compliance">
          <div className="vendor-card-head">
            <h2>雙邊角色與金流合規正式名目</h2>
            <button type="button" onClick={() => setTermsOpen(true)}>
              閱讀合作條款摘要
            </button>
          </div>
          <p className="muted vendor-compliance-intro">
            本平台嚴格遵循軟體服務與創作者工作流託管規範，所有節點調度、回饋結算與雲端工作台服務均採用以下正式合規名目：
          </p>
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>實質項目</th>
                  <th>平台正式合規名目</th>
                  <th>運作說明</th>
                </tr>
              </thead>
              <tbody>
                {FRAMEWORK_ROWS.map((r) => (
                  <tr key={r.role}>
                    <td className="vendor-td-role">
                      <span className="vendor-chip">{r.role}</span>
                    </td>
                    <td>
                      <strong>{r.value}</strong>
                    </td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="vendor-footer muted">
          © 算力節點夥伴計畫 · 依據{TERMS_NAME}運作
        </footer>
      </main>

      {termsOpen && (
        <div className="modal-backdrop" onClick={() => setTermsOpen(false)}>
          <div
            className="modal-panel vendor-terms-modal"
            role="dialog"
            aria-modal="true"
            aria-label="條款重點摘要"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{TERMS_NAME}</h2>
            <p className="muted">重點摘要</p>
            {TERMS_SUMMARY.map((t) => (
              <div key={t.title} className="modal-section">
                <h3>{t.title}</h3>
                <p className="muted vendor-terms-body">{t.body}</p>
              </div>
            ))}
            <div className="vendor-terms-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setAgreed(true);
                  setTermsOpen(false);
                }}
              >
                我已了解並同意
              </button>
              <button type="button" onClick={() => setTermsOpen(false)}>
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
