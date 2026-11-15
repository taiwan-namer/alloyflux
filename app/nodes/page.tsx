"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Cap {
  providerKey: string;
  modelId: string;
  authSourceType: string;
  enabled: boolean;
}

interface NodeRow {
  id: string;
  label: string;
  accountName: string;
  status: string;
  online: boolean;
  acceptingJobs: boolean;
  maxConcurrency: number;
  dailyJobLimit: number;
  jobsToday: number;
  lastSeenAt: number | null;
  credentialHint: string;
  capabilities: Cap[];
}

interface Earning {
  id: string;
  job_id: string;
  reward_points: number;
  status: string;
  created_at: number;
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [health, setHealth] = useState<{ online: number; total: number; note: string } | null>(null);
  const [adminOk, setAdminOk] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await (await fetch("/api/nodes")).json();
      if (data.error) {
        setNodes([]);
        return;
      }
      setNodes(Array.isArray(data.nodes) ? data.nodes : []);
      setEarnings(Array.isArray(data.earnings) ? data.earnings : []);
    } catch {
      setNodes([]);
    }
    try {
      const h = await (await fetch("/api/nodes/egress")).json();
      if (!h.error) setHealth({ online: h.online, total: h.total, note: h.note });
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const ok = Boolean(d.user?.isAdmin);
        setAdminOk(ok);
        if (ok) void refresh();
      })
      .catch(() => setAdminOk(false));
  }, [refresh]);

  useEffect(() => {
    if (!adminOk) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [adminOk, refresh]);

  if (adminOk === null) {
    return (
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        <p className="muted">驗證管理員權限…</p>
      </main>
    );
  }
  if (!adminOk) {
    return (
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        <h1>僅管理員可進入</h1>
        <p className="muted">Node Agent 屬於管理後台。</p>
        <Link href="/admin">← 管理後台</Link>
        {" · "}
        <Link href="/">回首頁</Link>
      </main>
    );
  }

  async function revoke(id: string) {
    if (!confirm("確定撤銷此節點？撤銷後需重新 register。")) return;
    await fetch(`/api/nodes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    void refresh();
  }

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>供給者 Node Agent</h1>
        <div className="row" style={{ gap: 12 }}>
          <Link href="/">← 聊天</Link>
          <Link href="/sources">訂閱研究／貨源</Link>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>架構</h2>
        <p className="muted" style={{ lineHeight: 1.6, marginTop: 0 }}>
          買家 → 平台任務佇列 → 供給者本機 Agent（Long Poll）→ 已獲准模型 → 回平台。
          Agent 主動連線，<strong>不需公開住宅 IP、Port Forward、住宅代理</strong>。
          API Key／OAuth 只存在供給者電腦；平台不存供給者模型金鑰。不做指紋／UA／TLS 偽裝。
        </p>
        <ol style={{ lineHeight: 1.7, marginBottom: 0 }}>
          <li>
            <code>npm run node-agent -- register</code>
          </li>
          <li>
            <code>npm run node-agent -- start</code>（保持視窗開啟）
          </li>
          <li>
            聊天選 <strong>Node Agent · Mock</strong> 送出測試訊息
          </li>
        </ol>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          節點狀態
          {health && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              Online {health.online}/{health.total}
            </span>
          )}
        </h3>
        {health && <p className="muted" style={{ fontSize: 13 }}>{health.note}</p>}
        <table>
          <thead>
            <tr>
              <th>節點</th>
              <th>狀態</th>
              <th>能力</th>
              <th>今日／上限</th>
              <th>並行</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>
                  <div>{n.label}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {n.accountName} · {n.id.slice(0, 8)} · {n.credentialHint}
                  </div>
                </td>
                <td>
                  {n.status === "revoked" ? (
                    <span className="muted">已撤銷</span>
                  ) : n.online ? (
                    <span style={{ color: "var(--ok)" }}>
                      ● Online{n.acceptingJobs ? "" : "（暫停接單）"}
                    </span>
                  ) : (
                    <span className="muted">○ Offline</span>
                  )}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {n.capabilities.map((c) => `${c.providerKey}:${c.modelId}`).join(", ") || "—"}
                </td>
                <td>
                  {n.jobsToday}/{n.dailyJobLimit}
                </td>
                <td>{n.maxConcurrency}</td>
                <td>
                  {n.status !== "revoked" && (
                    <button type="button" onClick={() => void revoke(n.id)}>
                      撤銷
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {nodes.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  尚無節點。在專案目錄執行 <code>npm run node-agent -- register</code>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>供給者收益（冪等）</h3>
        <table>
          <thead>
            <tr>
              <th>時間</th>
              <th>Job</th>
              <th>點數</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {earnings.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.created_at).toLocaleString("zh-TW")}</td>
                <td>
                  <code>{e.job_id.slice(0, 8)}</code>
                </td>
                <td>{e.reward_points}</td>
                <td>{e.status}</td>
              </tr>
            ))}
            {earnings.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  尚無收益紀錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
