"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface MeUser {
  id: string;
  email: string;
  name: string;
  role: "buyer" | "supplier";
  isAdmin: boolean;
  isSupplier: boolean;
}

const TERMS_NAME = "《AI 工作流託管與開源評測合作條款》";

const FRAMEWORK_ROWS: { role: string; label: string; value: string; note: string }[] = [
  {
    role: "身分角色",
    label: "夥伴稱謂",
    value: "算力節點夥伴（Node Partner）／AI 工作流創作者",
    note: "以創作者與節點託管夥伴身分參與平台，並於自有節點完成安全托管設定。",
  },
  {
    role: "創作者分潤",
    label: "80% 回饋",
    value: "AI 工作流／Agent 創作者上架分潤（80% 回饋）或 開源模型評測獎勵金",
    note: "依節點實際完成之託管任務結算，回饋比例 80%。",
  },
  {
    role: "軟體服務費",
    label: "雲端工作台",
    value: "雲端工作台軟體服務費（SaaS 平台技術服務費：NT$ 199 / 299 / 399）",
    note: "由使用者購買雲端工作台軟體服務時支付，對應平台技術服務。",
  },
  {
    role: "路由與調度",
    label: "智慧路由",
    value: "多節點智慧路由託管與負載平衡測試",
    note: "平台於多個已授權節點之間進行智慧路由、容量保護與負載平衡測試。",
  },
  {
    role: "合作條款",
    label: "法定文件",
    value: TERMS_NAME,
    note: "加入前請詳閱；可展開查看條款重點摘要。",
  },
];

const TERMINOLOGY_ROWS: { item: string; term: string; desc: string }[] = [
  { item: "夥伴稱謂", term: "算力節點夥伴（Node Partner）／AI 工作流創作者", desc: "對外一律使用此稱謂。" },
  {
    item: "80% 分潤",
    term: "AI 工作流／Agent 創作者上架分潤（80% 回饋）／開源模型評測獎勵金",
    desc: "夥伴端之回饋與獎勵名稱。",
  },
  {
    item: "使用者費用",
    term: "雲端工作台軟體服務費（SaaS 平台技術服務費：NT$ 199 / 299 / 399）",
    desc: "對應雲端工作台軟體服務之平台技術服務費。",
  },
  { item: "路由調度", term: "多節點智慧路由託管與負載平衡測試", desc: "描述節點託管與調度機制。" },
  { item: "合作條款", term: TERMS_NAME, desc: "夥伴加入與使用平台之依據文件。" },
];

const TERMS_SUMMARY: { title: string; body: string }[] = [
  {
    title: "一、合作定位",
    body: "夥伴以 AI 工作流創作者與算力節點夥伴身分，將具合法授權之開源模型、本機模型或自有合規服務託管於平台節點，參與多節點智慧路由託管與負載平衡測試。",
  },
  {
    title: "二、託管範圍與安全托管門檻",
    body: "夥伴須自行設定每日任務上限、同時處理數與分享比例等安全托管門檻；平台依門檻進行容量保護，達上限時自動停止派送。",
  },
  {
    title: "三、創作者上架分潤",
    body: "夥伴可獲得 AI 工作流／Agent 創作者上架分潤（80% 回饋），或開源模型評測獎勵金，依實際完成之託管任務結算。",
  },
  {
    title: "四、資料與隱私",
    body: "授權憑證僅於夥伴節點本機保存，平台僅留存必要之中繼資料；夥伴不得蒐集或留存使用者對話內容。",
  },
  {
    title: "五、夥伴責任",
    body: "夥伴應確保託管內容與所用模型、服務均符合其授權條款與當地法規，並配合平台之安全稽核與異常處置。",
  },
  {
    title: "六、暫停與終止",
    body: "夥伴可隨時暫停或撤銷節點；平台於發現違規或安全風險時，得暫停派送並通知夥伴處理。",
  },
];

const VALUE_CARDS: { icon: string; title: string; body: string }[] = [
  {
    icon: "🛰️",
    title: "多節點智慧路由託管",
    body: "將您的節點加入平台，參與多節點智慧路由託管與負載平衡測試，讓 AI 工作流在多個節點間穩定分流。",
  },
  {
    icon: "🛡️",
    title: "自訂安全托管門檻",
    body: "自行設定每日任務上限、同時處理數與分享比例；憑證留在您的節點本機，達門檻時平台自動停止派送。",
  },
  {
    icon: "💰",
    title: "80% 創作者上架分潤",
    body: "依實際完成之託管任務，獲得 AI 工作流／Agent 創作者上架分潤（80% 回饋），或開源模型評測獎勵金。",
  },
];

export default function VendorPage() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<MeUser | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const [agreed, setAgreed] = useState(true);
  const [termsOpen, setTermsOpen] = useState(false);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const d = await res.json();
      setUser(d.user ?? null);
      setGoogleEnabled(Boolean(d.googleEnabled));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!agreed) {
      setMsg(`請先勾選同意${TERMS_NAME}`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "login"
            ? { email, password }
            : { email, password, name: name.trim() || undefined, role: "supplier" },
        ),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d.error || (mode === "login" ? "登入失敗" : "註冊失敗"));
        return;
      }
      setPassword("");
      await loadMe();
    } catch {
      setMsg("網路錯誤，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setBusy(false);
      setUser(null);
      await loadMe();
    }
  }

  const statusLabel = user?.isAdmin
    ? "平台管理員（兼具算力節點夥伴權限）"
    : user?.isSupplier
      ? "算力節點夥伴・已啟用"
      : "一般雲端工作台會員（尚未啟用節點夥伴身分）";

  return (
    <div className="vendor-page">
      <header className="vendor-header">
        <div className="vendor-brand">
          <span className="vendor-badge">NODE PARTNER</span>
          <strong>算力節點夥伴入口</strong>
        </div>
        <Link href="/" className="vendor-back">
          ← 雲端工作台（聊天首頁 /）
        </Link>
      </header>

      <main className="vendor-main">
        <section className="vendor-hero">
          <h1>成為算力節點夥伴，參與 AI 工作流創作者計畫</h1>
          <p className="vendor-lead">
            算力節點夥伴（Node Partner）／AI 工作流創作者，可將合規授權的節點加入平台，參與
            <strong>多節點智慧路由託管與負載平衡測試</strong>，自訂安全托管門檻，並獲得
            <strong>AI 工作流／Agent 創作者上架分潤（80% 回饋）</strong>或開源模型評測獎勵金。
          </p>
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

        <section className="card vendor-card">
          <div className="vendor-card-head">
            <h2>合規運作架構一覽</h2>
            <button type="button" onClick={() => setTermsOpen(true)}>
              查看條款重點摘要
            </button>
          </div>
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>官方名稱</th>
                  <th>說明</th>
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

        <section className="card vendor-card vendor-auth" id="join">
          {loading ? (
            <p className="muted">檢查登入狀態…</p>
          ) : user ? (
            <div className="vendor-welcome">
              <div className="vendor-welcome-head">
                <div>
                  <h2>歡迎回來，{user.name || user.email}</h2>
                  <p className="muted">{user.email}</p>
                </div>
                <span className={`vendor-status ${user.isSupplier ? "is-active" : "is-idle"}`}>{statusLabel}</span>
              </div>

              {user.isSupplier ? (
                <div className="vendor-cta-grid">
                  <Link href="/sources" className="vendor-cta primary-cta">
                    前往節點與授權託管設定（/sources）
                  </Link>
                  {user.isAdmin && (
                    <Link href="/nodes" className="vendor-cta">
                      查看 Node Agent 連線狀態（/nodes）
                    </Link>
                  )}
                  {user.isAdmin && (
                    <Link href="/admin" className="vendor-cta">
                      前往總站管理後台（/admin）
                    </Link>
                  )}
                  <Link href="/" className="vendor-cta">
                    返回 AI 雲端工作台（/）
                  </Link>
                </div>
              ) : (
                <div className="vendor-notice">
                  <p>
                    目前登入的是一般雲端工作台會員身分。若要成為算力節點夥伴，請先登出，再以「註冊為算力節點夥伴」建立夥伴帳號。
                  </p>
                  <div className="vendor-cta-grid">
                    <Link href="/" className="vendor-cta">
                      返回 AI 雲端工作台（/）
                    </Link>
                  </div>
                </div>
              )}

              <div className="vendor-logout-row">
                <button type="button" onClick={() => void logout()} disabled={busy}>
                  登出
                </button>
              </div>
            </div>
          ) : (
            <div className="vendor-login">
              <h2>加入算力節點夥伴</h2>
              <p className="muted">登入或註冊後，即可設定節點、安全托管門檻與創作者分潤。</p>

              <label className="vendor-agree">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>
                  我已閱讀並同意{TERMS_NAME}
                  <button type="button" className="ghost vendor-inline-link" onClick={() => setTermsOpen(true)}>
                    查看摘要
                  </button>
                </span>
              </label>

              {googleEnabled ? (
                <a
                  className={`vendor-google ${agreed ? "" : "is-disabled"}`}
                  href="/api/auth/google/start?role=supplier&next=/vendor"
                  aria-disabled={!agreed}
                  onClick={(e) => {
                    if (!agreed) {
                      e.preventDefault();
                      setMsg(`請先勾選同意${TERMS_NAME}`);
                    }
                  }}
                >
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
                  使用 Google 登入為算力節點夥伴
                </a>
              ) : (
                <p className="vendor-hint">Google 登入尚未啟用，請使用下方 Email 登入／註冊。</p>
              )}

              <details className="vendor-email" open={!googleEnabled}>
                <summary>Email 登入／註冊為算力節點夥伴</summary>
                <form onSubmit={(e) => void submitEmail(e)} className="vendor-form">
                  <div className="auth-tabs">
                    <button
                      type="button"
                      className={mode === "login" ? "primary" : ""}
                      onClick={() => setMode("login")}
                    >
                      登入
                    </button>
                    <button
                      type="button"
                      className={mode === "register" ? "primary" : ""}
                      onClick={() => setMode("register")}
                    >
                      註冊為節點夥伴
                    </button>
                  </div>
                  {mode === "register" && (
                    <input
                      type="text"
                      placeholder="顯示名稱（選填）"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                  <input
                    type="email"
                    placeholder="Email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                  <input
                    type="password"
                    placeholder="密碼"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button type="submit" className="primary" disabled={busy || !agreed}>
                    {busy ? "處理中…" : mode === "login" ? "登入" : "註冊為算力節點夥伴"}
                  </button>
                </form>
              </details>

              {msg && <p className="error vendor-msg">{msg}</p>}
            </div>
          )}
        </section>

        <section className="card vendor-card" id="compliance">
          <h2>平台合規聲明與名詞規範</h2>
          <p className="muted vendor-compliance-intro">
            為確保所有夥伴與使用者對平台運作有一致理解，平台對外文件、介面與客服溝通，一律採用下列官方名詞。
          </p>
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>官方名詞</th>
                  <th>說明</th>
                </tr>
              </thead>
              <tbody>
                {TERMINOLOGY_ROWS.map((r) => (
                  <tr key={r.item}>
                    <td className="vendor-td-role">
                      <span className="vendor-chip">{r.item}</span>
                    </td>
                    <td>
                      <strong>{r.term}</strong>
                    </td>
                    <td className="muted">{r.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="vendor-statements">
            <li>節點託管僅限夥伴本人具合法授權之開源模型、本機模型或自有合規服務。</li>
            <li>授權憑證保存於夥伴節點本機，平台僅保存必要之中繼資料，並可隨時由夥伴撤銷。</li>
            <li>雲端工作台軟體服務費為 SaaS 平台技術服務費，與夥伴之創作者分潤為不同項目、各自獨立計算。</li>
            <li>加入前請詳閱{TERMS_NAME}，並依條款完成安全托管門檻設定。</li>
          </ul>
        </section>

        <footer className="vendor-footer muted">
          © 算力節點夥伴計畫・本頁所載名詞以{TERMS_NAME}為準
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
            <p className="muted">重點摘要（完整內容以正式條款為準）</p>
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
