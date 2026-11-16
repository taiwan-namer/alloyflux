"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { goToSourcesAfterBind } from "@/lib/cloud-site";

const TERMS_NAME = "《AI 工作流託管與開源評測合作條款》";

const FRAMEWORK_ROWS: { role: string; value: string; note: string }[] = [
  {
    role: "供給者身分",
    value: "算力節點夥伴（Node Partner）或 AI 工作流創作者",
    note: "以創作者與節點託管夥伴身分參與平台，完成授權後於 /sources 自訂分配用量。",
  },
  {
    role: "供給者分潤（80% 回饋）",
    value: "AI 工作流／Agent 創作者上架分潤 或 開源模型評測獎勵金",
    note: "依節點實際完成之智慧路由任務結算，回饋比例 80%，控制台即時換算回饋金額。",
  },
  {
    role: "買家付費（199 / 299 / 399）",
    value: "雲端工作台軟體服務費（SaaS 平台技術服務費）",
    note: "使用者開通雲端工作台軟體服務之平台技術服務費。",
  },
  {
    role: "額度調度行為",
    value: "多節點智慧路由託管與負載平衡測試",
    note: "於 Gemini、Claude、ChatGPT、Grok 多節點間自動進行容量保護與負載平衡測試。",
  },
  {
    role: "平台條款名稱",
    value: TERMS_NAME,
    note: "授權接入前請勾選同意；可點擊展開閱讀條款重點摘要。",
  },
];

const TERMS_SUMMARY: { title: string; body: string }[] = [
  {
    title: "一、合作定位",
    body: "夥伴以 AI 工作流創作者與算力節點夥伴身分，選擇模型模組完成授權接入，參與多節點智慧路由託管與負載平衡測試。",
  },
  {
    title: "二、自訂分配比例與容量保護",
    body: "完成模組授權後自動進入節點控制台（/sources），可針對 Gemini、Claude、ChatGPT、Grok 設定願意分配之容量上限，達上限自動停止派發。",
  },
  {
    title: "三、80% 創作者上架分潤與試算",
    body: "依節點實際完成之託管任務，結算 AI 工作流／Agent 創作者上架分潤（80% 回饋）或開源模型評測獎勵金，並於控制台即時換算新台幣回饋。",
  },
  {
    title: "四、多模型擴充與隨時撤銷",
    body: "進入控制台後可隨時增綁其他模型模組，亦可一鍵暫停或移除授權。",
  },
];

const VALUE_CARDS: { icon: string; title: string; body: string }[] = [
  {
    icon: "🛰️",
    title: "選模組即刻 OAuth 接入",
    body: "免註冊網站帳密，直接選擇 Gemini、ChatGPT、Grok 或 Claude 模組完成授權，完成後自動跳轉 /sources 控制台。",
  },
  {
    icon: "🎛️",
    title: "自訂分配用量＆換算回饋",
    body: "在 /sources 自由拉動 Gemini、Claude、ChatGPT、Grok 的分配比例，即時換算可領回多少 80% 創作者分潤金額。",
  },
  {
    icon: "🔌",
    title: "四大模型池智慧接力",
    body: "可同時串接多組模型節點，參與多節點智慧路由託管與負載平衡測試，單一池達上限自動無縫切換。",
  },
];

type ModuleKind = "gemini" | "chatgpt" | "grok" | "claude";

export default function VendorPage() {
  const router = useRouter();
  const [agreed, setAgreed] = useState(true);
  const [termsOpen, setTermsOpen] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [sessionUser, setSessionUser] = useState<{
    email?: string;
    role?: string;
    isSupplier?: boolean;
  } | null>(null);

  const [selectedModule, setSelectedModule] = useState<ModuleKind>("gemini");
  const [claudeMode, setClaudeMode] = useState<"oauth_pool" | "api_key">("oauth_pool");
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeCapPoints, setClaudeCapPoints] = useState(2000);
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
  const initialCountRef = useRef<number | null>(null);
  const submittingCodeRef = useRef(false);
  const lastSubmittedCodeRef = useRef<string | null>(null);
  const OAUTH_STATE_KEY = "aup_gemini_oauth_state";
  const OAUTH_URL_KEY = "aup_gemini_oauth_url";

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem(OAUTH_STATE_KEY);
      const savedUrl = sessionStorage.getItem(OAUTH_URL_KEY);
      if (savedState) setActiveOAuthState(savedState);
      if (savedUrl) setActiveAuthUrl(savedUrl);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setGoogleEnabled(Boolean(d.googleEnabled));
        if (d.user) {
          setSessionUser(d.user);
          // 已是節點夥伴 session → 直接進控制台
          if (d.user.role === "supplier" || d.user.isSupplier) {
            router.replace("/sources");
          }
        }
      })
      .catch(() => {});
  }, [router]);

  // 記錄初始節點數；本機監聽器自動完成 Google OAuth 時自動跳轉 /sources
  useEffect(() => {
    fetch("/api/sources", { cache: "no-store" })
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) {
          initialCountRef.current = list.length;
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeAuthUrl) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/sources", { cache: "no-store" });
        const list = await res.json();
        if (Array.isArray(list) && initialCountRef.current !== null && list.length > initialCountRef.current) {
          goToSourcesAfterBind((href) => router.push(href));
        }
      } catch {
        // ignore
      }
    }, 2500);
    return () => clearInterval(t);
  }, [activeAuthUrl, router]);

  // 輪詢 ChatGPT / Grok 裝置碼狀態，完成後自動跳轉 /sources
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
                ? "✓ Grok 模組 OAuth 授權完成！正在導向 /sources 設定分配用量…"
                : "✓ ChatGPT 模組 OAuth 授權完成！正在導向 /sources 設定分配用量…",
          });
          goToSourcesAfterBind((href) => router.push(href));
        } else if (data.error) {
          setOauthMsg({ ok: false, text: data.error });
          setDeviceFlow(null);
        }
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [deviceFlow, router]);

  function openAuthPopup(): Window | null {
    try {
      return window.open("about:blank", "_blank");
    } catch {
      return null;
    }
  }

  function navigateAuthPopup(popup: Window | null, url: string): boolean {
    if (popup && !popup.closed) {
      try {
        popup.location.href = url;
        return true;
      } catch {
        try {
          popup.close();
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  async function startModuleAuth() {
    if (!agreed) {
      setOauthMsg({ ok: false, text: `請先勾選同意${TERMS_NAME}` });
      return;
    }
    setOauthMsg(null);
    setDeviceFlow(null);
    setActiveAuthUrl(null);
    lastSubmittedCodeRef.current = null;
    setCallbackInput("");
    setBusy(true);
    const popup = openAuthPopup();
    try {
      if (selectedModule === "gemini" || (selectedModule === "claude" && claudeMode === "oauth_pool")) {
        const defaultLabel =
          subLabel.trim() || (selectedModule === "claude" ? "Claude & Gemini 訂閱池" : "");
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_gemini", label: defaultLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          try {
            popup?.close();
          } catch {
            // ignore
          }
          setOauthMsg({ ok: false, text: data.error || "啟動 Google OAuth 失敗" });
          return;
        }
        setActiveOAuthState(data.state);
        setActiveAuthUrl(data.authUrl);
        try {
          sessionStorage.setItem(OAUTH_STATE_KEY, data.state);
          sessionStorage.setItem(OAUTH_URL_KEY, data.authUrl);
        } catch {
          // ignore
        }
        if (!navigateAuthPopup(popup, data.authUrl)) {
          setOauthMsg({
            ok: false,
            text: "瀏覽器封鎖了彈窗。請點下方「前往 Google 授權」連結繼續。",
          });
        }
      } else if (selectedModule === "claude" && claudeMode === "api_key") {
        try {
          popup?.close();
        } catch {
          // ignore
        }
        if (!claudeKey.trim()) {
          setOauthMsg({ ok: false, text: "請輸入 Anthropic Claude API Key（sk-ant-...）" });
          return;
        }
        const res = await fetch("/api/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: subLabel.trim() || "Claude 算力節點",
            kind: "supplier",
            provider: "anthropic",
            apiKey: claudeKey.trim(),
            monthlyCapPoints: claudeCapPoints,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setOauthMsg({ ok: false, text: data.error || "Claude API Key 驗證失敗" });
          return;
        }
        setOauthMsg({ ok: true, text: "✓ Claude 算力節點接入成功！正在前往 /sources…" });
        goToSourcesAfterBind((href) => router.push(href));
      } else if (selectedModule === "chatgpt") {
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_chatgpt_device", label: subLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          try {
            popup?.close();
          } catch {
            // ignore
          }
          setOauthMsg({ ok: false, text: data.error || "啟動 ChatGPT 裝置碼授權失敗" });
          return;
        }
        setDeviceFlow({ kind: "chatgpt", state: data.state, userCode: data.userCode, verifyUrl: data.verifyUrl });
        if (!navigateAuthPopup(popup, data.verifyUrl)) {
          setOauthMsg({
            ok: false,
            text: "瀏覽器封鎖了彈窗。請點下方官方授權頁連結並輸入裝置碼。",
          });
        }
      } else {
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start_grok_device", label: subLabel, shareLimitPct }),
        });
        const data = await res.json();
        if (!res.ok) {
          try {
            popup?.close();
          } catch {
            // ignore
          }
          setOauthMsg({ ok: false, text: data.error || "啟動 Grok 裝置碼授權失敗" });
          return;
        }
        const verifyUrl = data.verifyUrlComplete || data.verifyUrl;
        setDeviceFlow({ kind: "grok", state: data.state, userCode: data.userCode, verifyUrl });
        if (!navigateAuthPopup(popup, verifyUrl)) {
          setOauthMsg({
            ok: false,
            text: "瀏覽器封鎖了彈窗。請點下方官方授權頁連結並輸入裝置碼。",
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCallbackUrl(overrideValue?: string) {
    const raw = (overrideValue ?? callbackInput).trim();
    if (!raw || busy || submittingCodeRef.current) return;
    if (lastSubmittedCodeRef.current === raw) {
      setOauthMsg({
        ok: false,
        text: "這個授權碼剛送過了。Google 授權碼只能換一次；請重新開啟 Google OAuth 後再貼一次。",
      });
      return;
    }
    let state = activeOAuthState;
    if (!state) {
      try {
        state = sessionStorage.getItem(OAUTH_STATE_KEY);
      } catch {
        state = null;
      }
    }
    if (!state) {
      setOauthMsg({
        ok: false,
        text: "找不到本次授權狀態。請在本分頁重新點啟動授權（勿只貼舊的 code），完成 Google 後再貼上。",
      });
      return;
    }
    submittingCodeRef.current = true;
    lastSubmittedCodeRef.current = raw;
    setBusy(true);
    setOauthMsg(null);
    try {
      const res = await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete_code",
          codeOrUrl: raw,
          state,
          label: subLabel.trim() || (selectedModule === "claude" ? "Claude & Gemini 訂閱池" : undefined),
          shareLimitPct,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOauthMsg({ ok: false, text: data.error || "授權驗證失敗，請確認貼上完整回呼網址" });
        return;
      }
      try {
        sessionStorage.removeItem(OAUTH_STATE_KEY);
        sessionStorage.removeItem(OAUTH_URL_KEY);
      } catch {
        // ignore
      }
      const claudeWin = Array.isArray(data.quota?.windows)
        ? data.quota.windows.find((w: { label?: string }) => /claude/i.test(w.label ?? ""))
        : null;
      const pctNote = claudeWin
        ? `（Claude & GPT 池剩餘 ${claudeWin.uiRemainingPercent ?? Math.round(claudeWin.remainingPercent)}%）`
        : typeof data.quota?.primaryRemainingPercent === "number"
          ? `（主池剩餘 ${data.quota.primaryRemainingPercent}%）`
          : "";
      setOauthMsg({
        ok: true,
        text: `✓ Google 算力節點綁定完成${pctNote}！正在進入 /sources…`,
      });
      lastSubmittedCodeRef.current = null;
      goToSourcesAfterBind((href) => router.push(href));
    } finally {
      submittingCodeRef.current = false;
      setBusy(false);
    }
  }

  function looksLikeGoogleAuthCode(val: string): boolean {
    const t = val.trim();
    return /[?&]code=[^&\s]{10,}/.test(t) || /^4\/[0-9A-Za-z_-]{20,}$/.test(t);
  }

  function onCallbackInputChange(val: string) {
    setCallbackInput(val);
    if (looksLikeGoogleAuthCode(val)) {
      void submitCallbackUrl(val);
    }
  }

  async function pasteFromClipboardAndSubmit() {
    try {
      const txt = (await navigator.clipboard.readText()).trim();
      if (!txt) {
        setOauthMsg({ ok: false, text: "剪貼簿是空的，請先在 Google 官方認證頁點「Copy to Clipboard」按鈕" });
        return;
      }
      setCallbackInput(txt);
      await submitCallbackUrl(txt);
    } catch {
      setOauthMsg({ ok: false, text: "瀏覽器請允許讀取剪貼簿，或直接在下方框內貼上" });
    }
  }

  const cardStyle = (active: boolean) => ({
    textAlign: "left" as const,
    padding: "15px 16px",
    borderRadius: 12,
    border: active ? "2px solid var(--accent)" : "1px solid var(--border)",
    background: active ? "rgba(91, 140, 255, 0.14)" : "var(--panel-2)",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  });

  return (
    <div className="vendor-page">
      <header className="vendor-header">
        <div className="vendor-brand">
          <span className="vendor-badge">NODE PARTNER</span>
          <strong>算力節點夥伴入口</strong>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <Link href="/sources" className="vendor-back">
            控制台 /sources →
          </Link>
          <Link href="/" className="vendor-back">
            ← 雲端工作台（聊天首頁 /）
          </Link>
        </div>
      </header>

      <main className="vendor-main">
        <section className="vendor-hero">
          <h1>成為算力節點夥伴・參與 AI 工作流創作者計畫</h1>
          <p className="vendor-lead">
            選擇您要託管的 AI 模型模組並完成 <strong>OAuth 授權登入</strong>，系統即自動讀取剩餘容量並導向{" "}
            <strong>/sources 控制台</strong>，讓您自由設定分配額度、即時換算{" "}
            <strong>80% AI 工作流／Agent 創作者上架分潤（開源模型評測獎勵金）</strong>。
          </p>
        </section>

        {/* === 回訪夥伴：網站 Google 登入 → /sources === */}
        <section className="card vendor-card" style={{ borderColor: "var(--accent)", marginBottom: 16 }}>
          <h2 style={{ marginTop: 0, marginBottom: 6 }}>已是節點夥伴？下次這樣回來</h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 13, lineHeight: 1.6 }}>
            用<strong>網站 Google 帳號</strong>登入（與模組 OAuth 分開），系統會標成節點夥伴並<strong>直接進入 /sources</strong>。
            {sessionUser?.email ? (
              <>
                <br />
                目前已登入：{sessionUser.email}
              </>
            ) : null}
          </p>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            {googleEnabled ? (
              <a
                className="primary"
                href="/api/auth/google/start?role=supplier&next=/sources"
                style={{ textDecoration: "none", display: "inline-block", padding: "10px 16px" }}
              >
                Google 登入 → 直達 /sources 控制台
              </a>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                尚未設定網站 Google 登入（BUYER_GOOGLE_CLIENT_ID）。可先用下方連結進入控制台。
              </span>
            )}
            <Link href="/sources" className="vendor-back" style={{ alignSelf: "center" }}>
              略過登入，直接開 /sources →
            </Link>
          </div>
        </section>

        {/* === 核心：直接顯示模組選擇卡片 → OAuth 授權完成自動跳 /sources === */}
        <section className="card vendor-card vendor-auth" id="join" style={{ borderColor: "var(--ok)" }}>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>第一次加入：選擇算力模組並啟動 OAuth 授權</h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 13 }}>
            免申請網站帳號密碼——點選下方任一模組完成官方授權後，立即跳轉至 <code>/sources</code> 設定分配用量與查看回饋金額換算。
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {/* 1. Google Gemini */}
            <button type="button" onClick={() => setSelectedModule("gemini")} style={cardStyle(selectedModule === "gemini")}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                ✦ Google Gemini 模組（AI Pro / Ultra）
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                一鍵開啟 <strong>Google OAuth 授權</strong>（雲端跳轉完貼回網址列即自動綁定並讀取剩餘 %；本機自動監聽完成）
              </div>
            </button>

            {/* 2. OpenAI ChatGPT */}
            <button type="button" onClick={() => setSelectedModule("chatgpt")} style={cardStyle(selectedModule === "chatgpt")}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                ◎ OpenAI ChatGPT 模組（Plus / Pro）
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                網頁／手機<strong>裝置碼 OAuth 授權</strong>（輸入代碼按允許後自動輪詢完成並讀取剩餘容量）
              </div>
            </button>

            {/* 3. xAI Grok */}
            <button type="button" onClick={() => setSelectedModule("grok")} style={cardStyle(selectedModule === "grok")}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                𝕏 xAI Grok 模組（SuperGrok）
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                網頁／手機<strong>裝置碼 OAuth 授權</strong>（輸入代碼按允許後自動輪詢完成並讀取剩餘容量）
              </div>
            </button>

            {/* 4. Anthropic Claude */}
            <button type="button" onClick={() => setSelectedModule("claude")} style={cardStyle(selectedModule === "claude")}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                ◈ Anthropic Claude 模組（Sonnet / Opus）
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                支援 <strong>Google OAuth（同步獨立 Claude 模型池 %）</strong> 或 <strong>Anthropic API Key</strong> 納入分配額度
              </div>
            </button>
          </div>

          {/* Claude 子模式切換 */}
          {selectedModule === "claude" && (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                marginBottom: 14,
              }}
            >
              <div className="row" style={{ gap: 8, marginBottom: claudeMode === "api_key" ? 12 : 4, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={claudeMode === "oauth_pool" ? "primary" : ""}
                  onClick={() => setClaudeMode("oauth_pool")}
                >
                  方式 1：Google Antigravity OAuth（含 Claude 5.5 訂閱額度池）
                </button>
                <button
                  type="button"
                  className={claudeMode === "api_key" ? "primary" : ""}
                  onClick={() => setClaudeMode("api_key")}
                >
                  方式 2：Anthropic Claude API Key 分配額度
                </button>
              </div>
              {claudeMode === "oauth_pool" ? (
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                  透過 Google OAuth 登入後，系統會自動讀取帳號內的獨立「Claude &amp; GPT 模型池」剩餘 % 並進入 /sources 獨立管理分配。
                </p>
              ) : (
                <div className="form-grid" style={{ marginTop: 8 }}>
                  <label>
                    Anthropic API Key
                    <input
                      type="password"
                      placeholder="sk-ant-..."
                      value={claudeKey}
                      onChange={(e) => setClaudeKey(e.target.value)}
                    />
                  </label>
                  <label>
                    每月願意分配額度上限：{claudeCapPoints.toLocaleString("zh-TW")} 額度
                    <input
                      type="range"
                      min={500}
                      max={10000}
                      step={500}
                      value={claudeCapPoints}
                      onChange={(e) => setClaudeCapPoints(Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="form-grid" style={{ marginBottom: 14 }}>
            <label>
              節點名稱（選填，之後可在 /sources 修改）
              <input
                value={subLabel}
                placeholder={`例如：我的 ${selectedModule.toUpperCase()} 算力節點 #1`}
                onChange={(e) => setSubLabel(e.target.value)}
              />
            </label>
            <label>
              初始分配比例：{shareLimitPct}%（保留 {100 - shareLimitPct}% 自用，進入 /sources 可隨時微調並試算回饋）
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
            onClick={() => void startModuleAuth()}
          >
            {selectedModule === "gemini" || (selectedModule === "claude" && claudeMode === "oauth_pool") ? (
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
                {busy
                  ? "正在開啟 Google OAuth…"
                  : selectedModule === "claude"
                    ? "一鍵開啟 Google OAuth 授權（同步 Claude 額度池）→ 前往 /sources"
                    : "一鍵開啟 Google OAuth 授權（Gemini AI Pro / Ultra）→ 前往 /sources"}
              </>
            ) : selectedModule === "claude" ? (
              <>{busy ? "正在驗證 Claude Key…" : "驗證並綁定 Claude 模組 → 前往 /sources 設定分配"}</>
            ) : selectedModule === "chatgpt" ? (
              <>{busy ? "正在產生裝置碼…" : "開啟 OpenAI ChatGPT 裝置碼 OAuth 授權 → 前往 /sources"}</>
            ) : (
              <>{busy ? "正在產生裝置碼…" : "開啟 xAI Grok 裝置碼 OAuth 授權 → 前往 /sources"}</>
            )}
          </button>

          {activeAuthUrl && (
            <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <a
                  href={activeAuthUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="primary"
                  style={{
                    display: "inline-block",
                    padding: "9px 14px",
                    borderRadius: 8,
                    textDecoration: "none",
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  前往 Google 授權
                </a>
              </div>
              <div style={{ marginBottom: 10, lineHeight: 1.7, fontSize: 13 }}>
                ① 授權後於官方頁點 <strong>Copy to Clipboard</strong>。
                <br />
                ② 回本頁在下方輸入欄點 <strong>貼上</strong>（完成後進入 <code>/sources</code>）。
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <input
                  style={{ flex: 1, minWidth: 220 }}
                  value={callbackInput}
                  disabled={busy}
                  placeholder="貼上授權碼（4/0A...）即自動綁定"
                  onChange={(e) => onCallbackInputChange(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void pasteFromClipboardAndSubmit()}
                >
                  {busy ? "綁定中…" : "貼上"}
                </button>
                <button
                  type="button"
                  disabled={busy || !callbackInput.trim()}
                  onClick={() => void submitCallbackUrl()}
                >
                  {busy ? "綁定中…" : "送出"}
                </button>
              </div>
            </div>
          )}

          {/* ChatGPT / Grok 裝置碼自動輪詢區 */}
          {deviceFlow && (
            <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                請在開啟的{" "}
                <a href={deviceFlow.verifyUrl} target="_blank" rel="noreferrer">
                  {deviceFlow.kind === "grok" ? "xAI Grok 官方授權頁" : "OpenAI ChatGPT 官方授權頁"}
                </a>{" "}
                輸入以下裝置碼：
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 3, margin: "10px 0", color: "var(--ok)" }}>
                {deviceFlow.userCode}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                按下允許後系統每 3 秒自動輪詢，完成後立即讀取剩餘容量並自動跳轉至 <code>/sources</code>…
              </div>
            </div>
          )}

          {oauthMsg && (
            <div style={{ marginTop: 12, fontWeight: 600, color: oauthMsg.ok ? "var(--ok)" : "var(--danger)" }}>
              {oauthMsg.text}
            </div>
          )}
        </section>

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

        {/* === 雙邊角色與金流合規名目一覽 === */}
        <section className="card vendor-card" id="compliance">
          <div className="vendor-card-head">
            <h2>雙邊角色與金流合規正式名目一覽</h2>
            <button type="button" onClick={() => setTermsOpen(true)}>
              閱讀合作條款摘要
            </button>
          </div>
          <p className="muted vendor-compliance-intro">
            平台所有節點託管、智慧路由負載平衡測試與創作者分潤結算，均嚴格依據以下正式合規名目運作：
          </p>
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>實質項目</th>
                  <th>✅ 平台正式合規名目</th>
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
