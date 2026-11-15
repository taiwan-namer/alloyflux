"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

/* ───────── 型別 ───────── */

interface QuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  uiRemainingPercent?: number;
  resetAt: string | null;
  modelKey?: string;
}

interface SourceRow {
  id: string;
  label: string;
  kind: "supplier" | "platform";
  provider: "gemini" | "openai" | "anthropic" | "xai" | "openrouter";
  authType: "oauth_sub" | "api_key";
  keyHint: string;
  priority: number;
  monthlyCapPoints: number | null;
  shareLimitPct: number;
  quota: {
    planType: string;
    email?: string;
    windows: QuotaWindow[];
    primaryRemainingPercent: number;
    fetchedAt: number;
  } | null;
  quotaUpdatedAt: number | null;
  enabled: boolean;
  fromEnv: boolean;
  delegatedToNode?: boolean;
  usedThisMonthPoints: number;
  cooldownUntil: number | null;
  lastError: string | null;
}

interface NodeRow {
  id: string;
  label: string;
  accountName: string;
  status: "active" | "paused" | "revoked";
  acceptingJobs: boolean;
  maxConcurrency: number;
  dailyJobLimit: number;
  jobsToday: number;
  lastSeenAt: number | null;
  online: boolean;
  capabilities?: { id: string }[];
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  balance: number;
  createdAt: number;
}

interface LedgerRow {
  id: string;
  userId: string;
  type: string;
  amountPoints: number;
  refId: string | null;
  note: string | null;
  createdAt: number;
}

interface Overview {
  stats: {
    totalUsers: number;
    totalPartners: number;
    oauthSupplierSources?: number;
    partnerNodes?: number;
    todayMessages: number;
    todayFreeMessages: number;
    weekTopupPoints: number;
    weekSourceCostPoints: number;
    enabledSources: number;
    totalSources: number;
    onlineNodes: number;
    totalNodes: number;
  };
  sources: SourceRow[];
  nodes: NodeRow[];
  earnings: Record<string, unknown>[];
  jobStats: { status: string; count: number }[];
  recentUsers: UserRow[];
  recentLedger: LedgerRow[];
}

interface CodeRow {
  code: string;
  points: number;
  maxUses: number;
  usedCount: number;
  createdAt: number;
}

type ViewId =
  | "dashboard"
  | "reservoir"
  | "sources"
  | "nodes"
  | "traffic"
  | "members"
  | "partners"
  | "mint"
  | "ledger"
  | "compliance";

type IconName =
  | "external"
  | "grid"
  | "database"
  | "route"
  | "users"
  | "ticket"
  | "shield"
  | "chevron-right"
  | "chevron-down"
  | "menu";

/* ───────── 圖示 ───────── */

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "external":
      return (
        <svg {...common}>
          <path d="M14 4h6v6" />
          <path d="M20 4l-9 9" />
          <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="7" height="7" rx="1.2" />
          <rect x="13" y="4" width="7" height="7" rx="1.2" />
          <rect x="4" y="13" width="7" height="7" rx="1.2" />
          <rect x="13" y="13" width="7" height="7" rx="1.2" />
        </svg>
      );
    case "database":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
          <path d="M4.5 5.5v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6" />
          <path d="M4.5 11.5v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6" />
        </svg>
      );
    case "route":
      return (
        <svg {...common}>
          <circle cx="6" cy="18" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 19c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5" />
          <path d="M16 5.2a3 3 0 0 1 0 5.6" />
          <path d="M18 14c1.9.7 3 2.3 3 5" />
        </svg>
      );
    case "ticket":
      return (
        <svg {...common}>
          <path d="M4 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1a2 2 0 0 1 0-4v0a2 2 0 0 0 0-4V7a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v1Z" />
          <path d="M14 6v12" strokeDasharray="2 2.5" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6l7-3Z" />
          <path d="M9 12l2.2 2.2L15.5 10" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...common} strokeWidth={2}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common} strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
  }
}

/* ───────── 選單設定 ───────── */

interface NavChild {
  id: ViewId;
  label: string;
}
interface NavGroup {
  key: string;
  label: string;
  icon: IconName;
  children?: NavChild[];
  view?: ViewId;
  links?: { href: string; label: string }[];
}

const NAV: NavGroup[] = [
  {
    key: "front",
    label: "查看前台",
    icon: "external",
    links: [
      { href: "/", label: "AI 雲端工作台（/）" },
      { href: "/vendor", label: "算力節點夥伴入口（/vendor）" },
    ],
  },
  { key: "dashboard", label: "Dashboard 總覽", icon: "grid", view: "dashboard" },
  {
    key: "pool",
    label: "水庫與算力池",
    icon: "database",
    children: [
      { id: "reservoir", label: "各水庫可用餘額" },
      { id: "sources", label: "節點託管貨源" },
      { id: "nodes", label: "Node Agent 節點" },
    ],
  },
  {
    key: "routing",
    label: "智慧路由與流量",
    icon: "route",
    children: [{ id: "traffic", label: "今日流量與免費層" }],
  },
  {
    key: "members",
    label: "會員與節點夥伴",
    icon: "users",
    children: [
      { id: "members", label: "雲端工作台會員" },
      { id: "partners", label: "算力節點夥伴" },
    ],
  },
  {
    key: "billing",
    label: "服務費序號與對帳",
    icon: "ticket",
    children: [
      { id: "mint", label: "產生服務費序號" },
      { id: "ledger", label: "全站帳本與分潤對帳" },
    ],
  },
  { key: "compliance", label: "合規與條款規範", icon: "shield", view: "compliance" },
];

const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: "Dashboard 總覽",
  reservoir: "各水庫可用餘額",
  sources: "節點託管貨源",
  nodes: "Node Agent 節點",
  traffic: "今日流量與免費層",
  members: "雲端工作台會員",
  partners: "算力節點夥伴",
  mint: "產生服務費序號",
  ledger: "全站帳本與分潤對帳",
  compliance: "合規與條款規範",
};

const COMPLIANCE_ROWS: { item: string; term: string; avoid: string }[] = [
  {
    item: "夥伴稱謂",
    term: "算力節點夥伴（Node Partner）／AI 工作流創作者",
    avoid: "帳號出租、額度賣家",
  },
  {
    item: "80% 分潤",
    term: "AI 工作流／Agent 創作者上架分潤（80% 回饋）／開源模型評測獎勵金",
    avoid: "帳號租金、點數拆帳、轉賣餘額",
  },
  {
    item: "使用者費用",
    term: "雲端工作台軟體服務費（SaaS 平台技術服務費：NT$ 199 / 299 / 399）",
    avoid: "代儲值、買官方 API 額度、API 轉售",
  },
  {
    item: "序號",
    term: "雲端工作台軟體服務費序號",
    avoid: "額度收購、共用訂閱帳號",
  },
  {
    item: "路由調度",
    term: "多節點智慧路由託管與負載平衡測試",
    avoid: "突破官方冷卻限制",
  },
  {
    item: "合作條款",
    term: "《AI 工作流託管與開源評測合作條款》",
    avoid: "（不得自行改寫條款名稱）",
  },
];

/* ───────── 小工具 ───────── */

const PROVIDER_GROUPS: { key: string; label: string }[] = [
  { key: "gemini", label: "Gemini" },
  { key: "claude_gpt", label: "Claude & GPT" },
  { key: "chatgpt", label: "ChatGPT" },
  { key: "grok", label: "Grok" },
  { key: "openrouter", label: "OpenRouter" },
];

function fmtTime(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

function fmtIso(iso: string | null | undefined) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString("zh-TW", { hour12: false });
}

function fmtNum(n: number) {
  return Math.round(n * 100) / 100 === Math.round(n)
    ? Math.round(n).toLocaleString("zh-TW")
    : (Math.round(n * 100) / 100).toLocaleString("zh-TW");
}

function level(pct: number): "high" | "mid" | "low" {
  if (pct >= 50) return "high";
  if (pct >= 20) return "mid";
  return "low";
}

function ledgerTypeLabel(t: string) {
  switch (t) {
    case "topup":
      return "服務費序號入帳";
    case "usage":
      return "工作台使用";
    case "source_usage":
      return "節點貨源消耗";
    case "supplier_earn":
      return "創作者分潤";
    default:
      return t;
  }
}

function jobStatusLabel(s: string) {
  const m: Record<string, string> = {
    queued: "排隊中",
    pending: "等待中",
    running: "執行中",
    assigned: "已派送",
    completed: "已完成",
    failed: "失敗",
    cancelled: "已取消",
    expired: "已逾時",
  };
  return m[s] ?? s;
}

function pick<T>(row: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k] as T;
  return undefined;
}

function Meter({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className={`adm-meter adm-${level(v)}`}>
      <div className="adm-meter-fill" style={{ width: `${v}%` }} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat-label">{label}</div>
      <div className="adm-stat-value">{value}</div>
      {sub && <div className="adm-stat-sub">{sub}</div>}
    </div>
  );
}

/* ───────── 主元件 ───────── */

export default function AdminPage() {
  const [email, setEmail] = useState("");
  const [active, setActive] = useState<ViewId>("reservoir");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ pool: true, billing: true });
  const [navOpen, setNavOpen] = useState(false);

  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [loadingOv, setLoadingOv] = useState(false);

  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  const [customPoints, setCustomPoints] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshCodes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/redeem-codes");
      const data = await res.json();
      if (res.ok) setCodes(data.codes ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshOverview = useCallback(async () => {
    setLoadingOv(true);
    try {
      const res = await fetch("/api/admin/overview", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setOv(data as Overview);
        setOvErr(null);
        return;
      }
      // overview 失敗時仍嘗試直接拉貨源，避免後台整頁空白
      const sRes = await fetch("/api/sources", { cache: "no-store" });
      const sData = await sRes.json();
      if (sRes.ok && Array.isArray(sData)) {
        setOv({
          stats: {
            totalUsers: 0,
            totalPartners: 0,
            oauthSupplierSources: sData.filter((s: SourceRow) => s.kind === "supplier").length,
            partnerNodes: sData.filter((s: SourceRow) => s.kind === "supplier").length,
            todayMessages: 0,
            todayFreeMessages: 0,
            weekTopupPoints: 0,
            weekSourceCostPoints: 0,
            enabledSources: sData.filter((s: SourceRow) => s.enabled).length,
            totalSources: sData.length,
            onlineNodes: 0,
            totalNodes: 0,
          },
          sources: sData as SourceRow[],
          nodes: [],
          earnings: [],
          jobStats: [],
          recentUsers: [],
          recentLedger: [],
        });
        setOvErr(`總覽部分失敗（${data.error || res.status}），已改顯示貨源列表`);
        return;
      }
      setOvErr(data.error || "載入總覽失敗");
    } catch {
      try {
        const sRes = await fetch("/api/sources", { cache: "no-store" });
        const sData = await sRes.json();
        if (sRes.ok && Array.isArray(sData)) {
          setOv({
            stats: {
              totalUsers: 0,
              totalPartners: 0,
              oauthSupplierSources: sData.filter((s: SourceRow) => s.kind === "supplier").length,
              partnerNodes: sData.filter((s: SourceRow) => s.kind === "supplier").length,
              todayMessages: 0,
              todayFreeMessages: 0,
              weekTopupPoints: 0,
              weekSourceCostPoints: 0,
              enabledSources: sData.filter((s: SourceRow) => s.enabled).length,
              totalSources: sData.length,
              onlineNodes: 0,
              totalNodes: 0,
            },
            sources: sData as SourceRow[],
            nodes: [],
            earnings: [],
            jobStats: [],
            recentUsers: [],
            recentLedger: [],
          });
          setOvErr("總覽逾時，已改顯示貨源列表");
          return;
        }
      } catch {
        /* ignore */
      }
      setOvErr("網路錯誤，無法載入總覽");
    } finally {
      setLoadingOv(false);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
    void refreshCodes();
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setEmail(d.user?.email ?? "免驗證模式（開放預覽）");
      })
      .catch(() => setEmail("免驗證模式（開放預覽）"));
  }, [refreshOverview, refreshCodes]);

  useEffect(() => {
    const t = setInterval(() => void refreshOverview(), 30_000);
    return () => clearInterval(t);
  }, [refreshOverview]);

  /* 水庫分組 */
  const reservoirGroups = useMemo(() => {
    const map: Record<string, { source: SourceRow; windows: QuotaWindow[] }[]> = {};
    for (const g of PROVIDER_GROUPS) map[g.key] = [];
    for (const s of ov?.sources ?? []) {
      const wins = s.quota?.windows ?? [];
      if (s.provider === "gemini") {
        const third = wins.filter((w) => w.modelKey === "third_party");
        const rest = wins.filter((w) => w.modelKey !== "third_party");
        map.gemini.push({ source: s, windows: rest });
        if (third.length) map.claude_gpt.push({ source: s, windows: third });
      } else if (s.provider === "anthropic") {
        map.claude_gpt.push({ source: s, windows: wins });
      } else if (s.provider === "openai") {
        map.chatgpt.push({ source: s, windows: wins });
      } else if (s.provider === "xai") {
        map.grok.push({ source: s, windows: wins });
      } else {
        map.openrouter.push({ source: s, windows: wins });
      }
    }
    return map;
  }, [ov]);

  async function syncQuotas() {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync_quota" }),
      });
      const data = await res.json();
      if (!res.ok) setMsg(data.error || "同步失敗");
      else setMsg("已同步各水庫剩餘容量");
      await refreshOverview();
    } catch {
      setMsg("同步失敗：網路錯誤");
    } finally {
      setSyncing(false);
    }
  }

  async function toggleSource(s: SourceRow) {
    setBusyId(s.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/sources/${encodeURIComponent(s.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(data.error || "更新失敗");
      else setMsg(`${s.label} 已${s.enabled ? "停用" : "啟用"}`);
      await refreshOverview();
    } catch {
      setMsg("更新失敗：網路錯誤");
    } finally {
      setBusyId(null);
    }
  }

  async function mint(points: number, planLabel: string) {
    setMsg(null);
    setMintedCode(null);
    if (!Number.isFinite(points) || points <= 0) {
      setMsg("請輸入有效的額度數字");
      return;
    }
    const res = await fetch("/api/admin/redeem-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        points,
        maxUses: 1,
        note: `admin mint · 雲端工作台軟體服務費序號 · ${planLabel} · ${points} 額度`,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || "產生序號失敗");
      return;
    }
    setMintedCode(data.code);
    setMsg(`已產生雲端工作台軟體服務費序號：${planLabel}（${points.toLocaleString("zh-TW")} 額度）`);
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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/";
  }

  function go(id: ViewId) {
    setActive(id);
    setNavOpen(false);
    setMsg(null);
  }

  function toggleGroup(key: string) {
    setExpanded((p) => ({ ...p, [key]: !p[key] }));
  }

  /* ───── 各視圖 ───── */

  const stats = ov?.stats;

  function renderReservoir() {
    return (
      <>
        <div className="adm-toolbar">
          <button type="button" className="adm-btn adm-btn-primary" onClick={() => void syncQuotas()} disabled={syncing}>
            {syncing ? "同步中…" : "同步各水庫容量（sync_quotas）"}
          </button>
          <button type="button" className="adm-btn" onClick={() => void refreshOverview()} disabled={loadingOv}>
            {loadingOv ? "更新中…" : "重新整理"}
          </button>
          <Link href="/sources" className="adm-btn">
            前往 /sources 綁定授權
          </Link>
        </div>

        {PROVIDER_GROUPS.map((g) => {
          const entries = reservoirGroups[g.key] ?? [];
          return (
            <section key={g.key} className="adm-section">
              <h3 className="adm-section-title">
                {g.label}
                <span className="adm-count">{entries.length}</span>
              </h3>
              {entries.length === 0 ? (
                <div className="adm-empty">尚無 {g.label} 水庫</div>
              ) : (
                <div className="adm-reservoir-grid">
                  {entries.map(({ source: s, windows }) => {
                    const remain =
                      windows.length > 0
                        ? Math.min(...windows.map((w) => w.remainingPercent))
                        : (s.quota?.primaryRemainingPercent ?? null);
                    const cooling = s.cooldownUntil && s.cooldownUntil > Date.now();
                    return (
                      <article key={`${g.key}-${s.id}`} className={`adm-res-card ${s.enabled ? "" : "is-off"}`}>
                        <div className="adm-res-head">
                          <div className="adm-res-title">
                            <strong>{s.label}</strong>
                            <span className="adm-sub">
                              {s.quota?.planType ?? (s.authType === "api_key" ? "API 直連" : "訂閱授權")}
                              {s.quota?.email ? ` · ${s.quota.email}` : ""}
                            </span>
                          </div>
                          <span className={`adm-pill ${s.enabled ? "adm-pill-ok" : "adm-pill-off"}`}>
                            {s.enabled ? "啟用" : "停用"}
                          </span>
                        </div>

                        {remain !== null ? (
                          <div className="adm-res-main">
                            <div className={`adm-res-pct adm-text-${level(remain)}`}>{Math.round(remain)}%</div>
                            <div className="adm-res-bar">
                              <div className="adm-sub">剩餘可用</div>
                              <Meter pct={remain} />
                            </div>
                          </div>
                        ) : (
                          <div className="adm-sub">尚無容量資料（可按「同步各水庫容量」）</div>
                        )}

                        {windows.length > 0 && (
                          <ul className="adm-win-list">
                            {windows.map((w, i) => (
                              <li key={`${w.label}-${i}`}>
                                <div className="adm-win-row">
                                  <span>{w.label}</span>
                                  <span className={`adm-text-${level(w.remainingPercent)}`}>
                                    {Math.round(w.uiRemainingPercent ?? w.remainingPercent)}%
                                  </span>
                                </div>
                                <Meter pct={w.remainingPercent} />
                                <div className="adm-sub">重置：{fmtIso(w.resetAt)}</div>
                              </li>
                            ))}
                          </ul>
                        )}

                        <dl className="adm-kv">
                          <div>
                            <dt>分享上限</dt>
                            <dd>{s.shareLimitPct}%</dd>
                          </div>
                          <div>
                            <dt>本月已用</dt>
                            <dd>{fmtNum(s.usedThisMonthPoints)}</dd>
                          </div>
                          <div>
                            <dt>容量更新</dt>
                            <dd>{fmtTime(s.quotaUpdatedAt)}</dd>
                          </div>
                        </dl>

                        {(cooling || s.lastError) && (
                          <div className="adm-alert">
                            {cooling && <div>冷卻中，至 {fmtTime(s.cooldownUntil)}</div>}
                            {s.lastError && <div>最近錯誤：{s.lastError}</div>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </>
    );
  }

  function renderSources() {
    const list = ov?.sources ?? [];
    return (
      <>
        <div className="adm-toolbar">
          <Link href="/sources" className="adm-btn adm-btn-primary">
            前往 /sources 進行 OAuth 綁定
          </Link>
          <button type="button" className="adm-btn" onClick={() => void refreshOverview()} disabled={loadingOv}>
            重新整理
          </button>
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>名稱</th>
                <th>類型</th>
                <th>剩餘</th>
                <th>分享上限</th>
                <th>本月已用</th>
                <th>狀態</th>
                <th>啟用</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const remain = s.quota?.primaryRemainingPercent;
                const cooling = s.cooldownUntil && s.cooldownUntil > Date.now();
                return (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.label}</strong>
                      <div className="adm-sub">
                        {s.provider} · {s.keyHint || "—"}
                      </div>
                    </td>
                    <td>
                      <span className="adm-pill">{s.kind === "platform" ? "平台直連" : "節點託管"}</span>
                    </td>
                    <td>{typeof remain === "number" ? `${Math.round(remain)}%` : "—"}</td>
                    <td>{s.shareLimitPct}%</td>
                    <td>{fmtNum(s.usedThisMonthPoints)}</td>
                    <td>
                      {cooling ? (
                        <span className="adm-pill adm-pill-warn">冷卻中</span>
                      ) : s.lastError ? (
                        <span className="adm-pill adm-pill-err" title={s.lastError}>
                          異常
                        </span>
                      ) : (
                        <span className="adm-pill adm-pill-ok">正常</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`adm-switch ${s.enabled ? "is-on" : ""}`}
                        onClick={() => void toggleSource(s)}
                        disabled={busyId === s.id}
                        aria-pressed={s.enabled}
                        aria-label={`${s.enabled ? "停用" : "啟用"} ${s.label}`}
                      >
                        <span />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="adm-empty-cell">
                    尚無貨源
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  function renderNodes() {
    const list = ov?.nodes ?? [];
    return (
      <>
        <div className="adm-stat-grid">
          <Stat label="線上節點" value={`${stats?.onlineNodes ?? 0} / ${stats?.totalNodes ?? 0}`} />
          <Stat label="今日完成任務" value={list.reduce((a, n) => a + (n.jobsToday ?? 0), 0)} />
        </div>
        <div className="adm-toolbar">
          <Link href="/nodes" className="adm-btn adm-btn-primary">
            前往 /nodes 查看詳細連線
          </Link>
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>節點</th>
                <th>夥伴</th>
                <th>連線</th>
                <th>派送</th>
                <th>同時處理上限</th>
                <th>今日任務 / 上限</th>
                <th>最後心跳</th>
              </tr>
            </thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id}>
                  <td>
                    <strong>{n.label}</strong>
                    <div className="adm-sub">{n.capabilities?.length ?? 0} 項能力</div>
                  </td>
                  <td>{n.accountName}</td>
                  <td>
                    <span className={`adm-pill ${n.online ? "adm-pill-ok" : "adm-pill-off"}`}>
                      {n.status === "revoked" ? "已撤銷" : n.online ? "線上" : "離線"}
                    </span>
                  </td>
                  <td>
                    <span className="adm-pill">
                      {n.status === "paused" ? "已暫停" : n.acceptingJobs ? "接收中" : "不接收"}
                    </span>
                  </td>
                  <td>{n.maxConcurrency}</td>
                  <td>
                    {n.jobsToday} / {n.dailyJobLimit}
                  </td>
                  <td className="adm-sub">{fmtTime(n.lastSeenAt)}</td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="adm-empty-cell">
                    尚無 Node Agent 節點
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  function renderTraffic() {
    const total = stats?.todayMessages ?? 0;
    const free = stats?.todayFreeMessages ?? 0;
    const freePct = total > 0 ? Math.round((free / total) * 100) : 0;
    const jobs = ov?.jobStats ?? [];
    const jobTotal = jobs.reduce((a, j) => a + j.count, 0);
    return (
      <>
        <div className="adm-stat-grid">
          <Stat label="今日訊息總數" value={total.toLocaleString("zh-TW")} />
          <Stat label="免費層訊息" value={free.toLocaleString("zh-TW")} sub={`佔 ${freePct}%`} />
          <Stat label="付費工作台訊息" value={Math.max(0, total - free).toLocaleString("zh-TW")} />
          <Stat label="今日路由任務" value={jobTotal.toLocaleString("zh-TW")} />
        </div>
        <section className="adm-section">
          <h3 className="adm-section-title">多節點智慧路由託管與負載平衡測試 · 今日任務狀態</h3>
          {jobs.length === 0 ? (
            <div className="adm-empty">今日尚無路由任務</div>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>狀態</th>
                    <th>任務數</th>
                    <th>占比</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.status}>
                      <td>{jobStatusLabel(j.status)}</td>
                      <td>{j.count}</td>
                      <td>
                        <div className="adm-inline-meter">
                          <Meter pct={jobTotal ? (j.count / jobTotal) * 100 : 0} />
                          <span className="adm-sub">{jobTotal ? Math.round((j.count / jobTotal) * 100) : 0}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  }

  function renderMembers() {
    const list = ov?.recentUsers ?? [];
    return (
      <>
        <div className="adm-stat-grid">
          <Stat label="會員總數" value={(stats?.totalUsers ?? 0).toLocaleString("zh-TW")} />
          <Stat
            label="OAuth 供給節點"
            value={(stats?.oauthSupplierSources ?? stats?.partnerNodes ?? 0).toLocaleString("zh-TW")}
            sub={`role=supplier ${stats?.totalPartners ?? 0}`}
          />
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>名稱</th>
                <th>身分</th>
                <th>工作台額度餘額</th>
                <th>建立時間</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>
                    <span className={`adm-pill ${u.role === "supplier" ? "adm-pill-ok" : ""}`}>
                      {u.role === "supplier" ? "節點夥伴" : "會員"}
                    </span>
                  </td>
                  <td>{fmtNum(u.balance)}</td>
                  <td className="adm-sub">{fmtTime(u.createdAt)}</td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={5} className="adm-empty-cell">
                    尚無會員
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  function renderPartners() {
    // 模組 OAuth（/vendor、/sources）寫入 sources，不會建立 users.role=supplier
    const oauthNodes = (ov?.sources ?? []).filter((s) => s.kind === "supplier");
    const rolePartners = (ov?.recentUsers ?? []).filter((u) => u.role === "supplier");
    return (
      <>
        <div className="adm-stat-grid">
          <Stat
            label="OAuth 模組節點"
            value={(stats?.oauthSupplierSources ?? stats?.partnerNodes ?? oauthNodes.length).toLocaleString("zh-TW")}
          />
          <Stat label="網站帳號夥伴（role=supplier）" value={(stats?.totalPartners ?? 0).toLocaleString("zh-TW")} />
          <Stat label="線上 Node Agent" value={`${stats?.onlineNodes ?? 0} / ${stats?.totalNodes ?? 0}`} />
        </div>

        <h3 className="adm-section-title" style={{ marginTop: 8 }}>
          已授權模組節點（來自 /vendor・/sources）
          <span className="adm-count">{oauthNodes.length}</span>
        </h3>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>節點名稱</th>
                <th>供應商</th>
                <th>識別／Email</th>
                <th>剩餘</th>
                <th>分配上限</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {oauthNodes.map((s) => {
                const remain = s.quota?.primaryRemainingPercent;
                return (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.label}</strong>
                      <div className="adm-sub">{s.authType === "oauth_sub" ? "OAuth 訂閱" : "API Key"}</div>
                    </td>
                    <td>{s.provider}</td>
                    <td className="adm-sub">{s.quota?.email || s.keyHint || "—"}</td>
                    <td>{typeof remain === "number" ? `${Math.round(remain)}%` : "—"}</td>
                    <td>{s.shareLimitPct}%</td>
                    <td>
                      <span className={`adm-pill ${s.enabled ? "adm-pill-ok" : "adm-pill-off"}`}>
                        {s.enabled ? "啟用" : "停用"}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {oauthNodes.length === 0 && (
                <tr>
                  <td colSpan={6} className="adm-empty-cell">
                    尚無 OAuth／API 供給節點。請至 /vendor 或 /sources 完成模組授權。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h3 className="adm-section-title" style={{ marginTop: 20 }}>
          網站帳號標記為節點夥伴
          <span className="adm-count">{rolePartners.length}</span>
        </h3>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>名稱</th>
                <th>名下 Node Agent</th>
                <th>建立時間</th>
              </tr>
            </thead>
            <tbody>
              {rolePartners.map((u) => {
                const own = (ov?.nodes ?? []).filter((n) => n.accountName === u.name || n.accountName === u.email);
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>{u.name}</td>
                    <td>{own.length ? `${own.length}（線上 ${own.filter((n) => n.online).length}）` : "—"}</td>
                    <td className="adm-sub">{fmtTime(u.createdAt)}</td>
                  </tr>
                );
              })}
              {rolePartners.length === 0 && (
                <tr>
                  <td colSpan={4} className="adm-empty-cell">
                    尚無 users.role=supplier 帳號（模組 OAuth 不會自動建立此角色）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="adm-sub adm-note">
          ChatGPT／Gemini／Grok 模組授權會出現在上方「已授權模組節點」與「節點託管貨源／各水庫可用餘額」，不會出現在網站帳號夥伴列表。
        </p>
      </>
    );
  }

  function renderMint() {
    return (
      <>
        <section className="adm-section">
          <p className="adm-sub">
            雲端工作台軟體服務費序號（單次使用）。對應 SaaS 平台技術服務費 NT$ 199／299／399 之工作台額度階梯。
          </p>
          <div className="adm-toolbar">
            <button type="button" className="adm-btn adm-btn-primary" onClick={() => void mint(1000, "NT$ 199 輕量")}>
              1,000 額度（199）
            </button>
            <button type="button" className="adm-btn" onClick={() => void mint(1800, "NT$ 299 進階")}>
              1,800 額度（299）
            </button>
            <button type="button" className="adm-btn" onClick={() => void mint(2800, "NT$ 399 旗艦")}>
              2,800 額度（399）
            </button>
          </div>
          <div className="adm-toolbar">
            <input
              className="adm-input"
              type="number"
              min={1}
              placeholder="自訂工作台額度"
              value={customPoints}
              onChange={(e) => setCustomPoints(e.target.value)}
            />
            <button
              type="button"
              className="adm-btn"
              onClick={() => void mint(Number(customPoints), "自訂")}
              disabled={!customPoints}
            >
              產生自訂序號
            </button>
          </div>
          {mintedCode && (
            <div className="adm-minted">
              <code>{mintedCode}</code>
              <button type="button" className="adm-btn" onClick={() => void copy(mintedCode)}>
                複製
              </button>
            </div>
          )}
        </section>

        <section className="adm-section">
          <h3 className="adm-section-title">最近產生的服務費序號</h3>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>序號</th>
                  <th>工作台額度</th>
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
                    <td>{c.points.toLocaleString("zh-TW")}</td>
                    <td>
                      {c.usedCount}/{c.maxUses}
                    </td>
                    <td className="adm-sub">{fmtTime(c.createdAt)}</td>
                  </tr>
                ))}
                {codes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="adm-empty-cell">
                      尚無服務費序號
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  function renderLedger() {
    const earnings = ov?.earnings ?? [];
    const rewardOf = (e: Record<string, unknown>) => Number(pick<number>(e, "reward_points", "rewardPoints") ?? 0);
    const statusOf = (e: Record<string, unknown>) => String(pick<string>(e, "status") ?? "pending");
    const totalReward = earnings.reduce((a, e) => a + rewardOf(e), 0);
    const pendingReward = earnings.filter((e) => statusOf(e) !== "paid").reduce((a, e) => a + rewardOf(e), 0);
    const paidReward = totalReward - pendingReward;
    const ledger = ov?.recentLedger ?? [];
    return (
      <>
        <div className="adm-stat-grid">
          <Stat label="近 7 日服務費序號入帳" value={fmtNum(stats?.weekTopupPoints ?? 0)} sub="工作台額度" />
          <Stat label="近 7 日節點貨源消耗" value={fmtNum(Math.abs(stats?.weekSourceCostPoints ?? 0))} sub="工作台額度" />
          <Stat label="創作者分潤（待結算）" value={fmtNum(pendingReward)} sub={`共 ${earnings.length} 筆紀錄`} />
          <Stat label="創作者分潤（已結算）" value={fmtNum(paidReward)} />
        </div>

        <section className="adm-section">
          <h3 className="adm-section-title">AI 工作流／Agent 創作者上架分潤（近 {Math.min(earnings.length, 20)} 筆）</h3>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>夥伴帳號</th>
                  <th>節點</th>
                  <th>分潤</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {earnings.slice(0, 20).map((e, i) => (
                  <tr key={String(pick(e, "id") ?? i)}>
                    <td className="adm-sub">{fmtTime(Number(pick<number>(e, "created_at", "createdAt") ?? 0))}</td>
                    <td className="adm-mono">{String(pick(e, "account_id", "accountId") ?? "—").slice(0, 10)}</td>
                    <td className="adm-mono">{String(pick(e, "node_id", "nodeId") ?? "—").slice(0, 10)}</td>
                    <td>{fmtNum(rewardOf(e))}</td>
                    <td>
                      <span className={`adm-pill ${statusOf(e) === "paid" ? "adm-pill-ok" : "adm-pill-warn"}`}>
                        {statusOf(e) === "paid" ? "已結算" : "待結算"}
                      </span>
                    </td>
                  </tr>
                ))}
                {earnings.length === 0 && (
                  <tr>
                    <td colSpan={5} className="adm-empty-cell">
                      尚無分潤紀錄
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="adm-section">
          <h3 className="adm-section-title">全站最近帳本</h3>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>類型</th>
                  <th>用戶</th>
                  <th>額度變動</th>
                  <th>備註</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="adm-sub">{fmtTime(l.createdAt)}</td>
                    <td>
                      <span className="adm-pill">{ledgerTypeLabel(l.type)}</span>
                    </td>
                    <td className="adm-mono">{l.userId.slice(0, 10)}</td>
                    <td className={l.amountPoints >= 0 ? "adm-text-high" : "adm-text-low"}>
                      {l.amountPoints >= 0 ? "+" : ""}
                      {fmtNum(l.amountPoints)}
                    </td>
                    <td className="adm-sub">{l.note ?? "—"}</td>
                  </tr>
                ))}
                {ledger.length === 0 && (
                  <tr>
                    <td colSpan={5} className="adm-empty-cell">
                      尚無帳本紀錄
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  function renderCompliance() {
    return (
      <>
        <p className="adm-sub">
          營運、客服與公告一律使用下列官方名詞。右欄為內部提醒，僅供管理後台參考，請勿對外公開或用於行銷文案。
        </p>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>項目</th>
                <th>官方合規名詞</th>
                <th>內部：避免使用</th>
              </tr>
            </thead>
            <tbody>
              {COMPLIANCE_ROWS.map((r) => (
                <tr key={r.item}>
                  <td>
                    <span className="adm-pill adm-pill-ok">{r.item}</span>
                  </td>
                  <td>
                    <strong>{r.term}</strong>
                  </td>
                  <td className="adm-sub">{r.avoid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  function renderDashboard() {
    return (
      <>
        <div className="adm-stat-grid">
          <Stat label="會員總數" value={(stats?.totalUsers ?? 0).toLocaleString("zh-TW")} />
          <Stat
            label="OAuth 供給節點"
            value={(stats?.oauthSupplierSources ?? stats?.partnerNodes ?? stats?.totalSources ?? 0).toLocaleString("zh-TW")}
            sub={`網站帳號夥伴 ${stats?.totalPartners ?? 0}`}
          />
          <Stat label="今日訊息" value={(stats?.todayMessages ?? 0).toLocaleString("zh-TW")} sub={`免費層 ${stats?.todayFreeMessages ?? 0}`} />
          <Stat label="啟用貨源" value={`${stats?.enabledSources ?? 0} / ${stats?.totalSources ?? 0}`} />
          <Stat label="線上節點" value={`${stats?.onlineNodes ?? 0} / ${stats?.totalNodes ?? 0}`} />
          <Stat label="近 7 日序號入帳" value={fmtNum(stats?.weekTopupPoints ?? 0)} sub={`貨源消耗 ${fmtNum(Math.abs(stats?.weekSourceCostPoints ?? 0))}`} />
        </div>
        <section className="adm-section">
          <h3 className="adm-section-title">快速前往</h3>
          <div className="adm-toolbar">
            <button type="button" className="adm-btn" onClick={() => go("reservoir")}>
              各水庫可用餘額
            </button>
            <button type="button" className="adm-btn" onClick={() => go("mint")}>
              產生服務費序號
            </button>
            <button type="button" className="adm-btn" onClick={() => go("ledger")}>
              全站帳本與分潤對帳
            </button>
            <Link href="/sources" className="adm-btn">
              /sources
            </Link>
            <Link href="/nodes" className="adm-btn">
              /nodes
            </Link>
          </div>
        </section>
      </>
    );
  }

  const views: Record<ViewId, () => ReactNode> = {
    dashboard: renderDashboard,
    reservoir: renderReservoir,
    sources: renderSources,
    nodes: renderNodes,
    traffic: renderTraffic,
    members: renderMembers,
    partners: renderPartners,
    mint: renderMint,
    ledger: renderLedger,
    compliance: renderCompliance,
  };

  const activeGroupKey = NAV.find((g) => g.view === active || g.children?.some((c) => c.id === active))?.key;

  return (
    <div className={`adm-shell ${navOpen ? "is-nav-open" : ""}`}>
      <aside className="adm-side">
        <div className="adm-side-head">
          <div className="adm-side-title">總站管理後台</div>
          <div className="adm-side-sub" title={email}>
            {email}
          </div>
        </div>

        <nav className="adm-nav">
          {NAV.map((g) => {
            const hasSub = Boolean(g.children || g.links);
            const isOpen = Boolean(expanded[g.key]);
            const isActiveTop = g.view === active;
            return (
              <div key={g.key} className="adm-nav-group">
                <button
                  type="button"
                  className={`adm-nav-item ${isActiveTop ? "active" : ""} ${
                    !isOpen && activeGroupKey === g.key && hasSub ? "has-active" : ""
                  }`}
                  onClick={() => (hasSub ? toggleGroup(g.key) : go(g.view!))}
                  aria-expanded={hasSub ? isOpen : undefined}
                >
                  <Icon name={g.icon} />
                  <span className="adm-nav-label">{g.label}</span>
                  {hasSub && <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} />}
                </button>
                {hasSub && isOpen && (
                  <div className="adm-nav-sub">
                    {g.children?.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`adm-nav-subitem ${active === c.id ? "active" : ""}`}
                        onClick={() => go(c.id)}
                      >
                        {c.label}
                      </button>
                    ))}
                    {g.links?.map((l) => (
                      <Link key={l.href} href={l.href} className="adm-nav-subitem">
                        {l.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="adm-side-foot">
          <button type="button" className="adm-nav-item" onClick={() => void logout()}>
            <span className="adm-nav-label">登出</span>
          </button>
        </div>
      </aside>

      {navOpen && <button type="button" className="adm-backdrop" aria-label="關閉選單" onClick={() => setNavOpen(false)} />}

      <section className="adm-content">
        <header className="adm-topbar">
          <button type="button" className="adm-menu-btn" onClick={() => setNavOpen(true)} aria-label="開啟選單">
            <Icon name="menu" />
          </button>
          <h1>{VIEW_TITLES[active]}</h1>
          <span className="adm-topbar-spacer" />
          {loadingOv && <span className="adm-sub">更新中…</span>}
        </header>
        <div className="adm-body">
          {ovErr && <div className="adm-alert">{ovErr}</div>}
          {msg && <div className="adm-toast">{msg}</div>}
          {!ov && !ovErr && active !== "mint" && active !== "compliance" ? (
            <div className="adm-empty">載入中…</div>
          ) : (
            views[active]()
          )}
        </div>
      </section>
    </div>
  );
}
