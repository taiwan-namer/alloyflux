"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export default function AdminPage() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  const [codes, setCodes] = useState<
    { code: string; points: number; maxUses: number; usedCount: number; createdAt: number }[]
  >([]);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshCodes = useCallback(async () => {
    const res = await fetch("/api/admin/redeem-codes");
    const data = await res.json();
    if (res.ok) setCodes(data.codes ?? []);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setOk(Boolean(d.user?.isAdmin));
        setEmail(d.user?.email ?? "");
        if (d.user?.isAdmin) void refreshCodes();
      })
      .catch(() => setOk(false));
  }, [refreshCodes]);

  async function mint(points: number, planLabel: string) {
    setMsg(null);
    setMintedCode(null);
    const res = await fetch("/api/admin/redeem-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        points,
        maxUses: 1,
        note: `admin mint · ${planLabel} · ${points} 額度`,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || "產碼失敗");
      return;
    }
    setMintedCode(data.code);
    setMsg(`已產生 ${planLabel}（${points.toLocaleString("zh-TW")} 額度）`);
    void refreshCodes();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("已複製");
    } catch {
      setMsg("複製失敗，請手動選取");
    }
  }

  if (ok === null) {
    return (
      <main style={{ maxWidth: 800, margin: "40px auto", padding: 16 }}>
        <p className="muted">驗證管理員…</p>
      </main>
    );
  }
  if (!ok) {
    return (
      <main style={{ maxWidth: 800, margin: "40px auto", padding: 16 }}>
        <h1>僅管理員可進入</h1>
        <p className="muted">請用 ADMIN_EMAILS 內的帳號登入。</p>
        <Link href="/">← 回首頁</Link>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>管理後台</h1>
        <div className="row" style={{ gap: 12 }}>
          <Link href="/">買家聊天</Link>
          <Link href="/sources">供給者貨源</Link>
        </div>
      </div>
      <p className="muted">登入為 {email}</p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>快捷入口</h2>
        <ul style={{ lineHeight: 1.8 }}>
          <li>
            <Link href="/sources">供給者訂閱／貨源（OAuth）</Link>
          </li>
          <li>
            <Link href="/nodes">Node Agent 狀態</Link>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>產生兌換碼</h2>
        <p className="muted">單次使用。對應 199／299／399 可用額度階梯。</p>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <button type="button" className="primary" onClick={() => void mint(1000, "199 輕量")}>
            1,000 額度（199）
          </button>
          <button type="button" onClick={() => void mint(1800, "299 進階")}>
            1,800 額度（299）
          </button>
          <button type="button" onClick={() => void mint(2800, "399 旗艦")}>
            2,800 額度（399）
          </button>
        </div>
        {mintedCode && (
          <div style={{ marginTop: 12 }}>
            <code>{mintedCode}</code>{" "}
            <button type="button" onClick={() => void copy(mintedCode)}>
              複製
            </button>
          </div>
        )}
        {msg && <p className="muted">{msg}</p>}
        <table style={{ marginTop: 16, width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th>碼</th>
              <th>額度</th>
              <th>使用</th>
              <th>建立</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.code}>
                <td>
                  <code>{c.code}</code>
                </td>
                <td>{c.points}</td>
                <td>
                  {c.usedCount}/{c.maxUses}
                </td>
                <td className="muted">{new Date(c.createdAt).toLocaleString("zh-TW")}</td>
              </tr>
            ))}
            {codes.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  尚無兌換碼
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
