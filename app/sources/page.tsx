"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { goToSourcesAfterBind } from "@/lib/cloud-site";
import { MAX_SUPPLIER_SHARE_LIMIT_PCT } from "@/lib/share-limit";

const OAUTH_STATE_KEY = "aup_gemini_oauth_state";
const OAUTH_URL_KEY = "aup_gemini_oauth_url";

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
  subscriptionExpiresAt?: string | null;
  subscriptionActive?: boolean;
  subscriptionStatus?: "active" | "inactive" | "unknown" | "auth_failed" | "usage_unavailable";
}

function formatSubscriptionExpiry(quota: SubscriptionQuota | null): string | null {
  if (!quota?.subscriptionExpiresAt) return null;
  const t = Date.parse(quota.subscriptionExpiresAt);
  if (!Number.isFinite(t)) return null;
  const days = (t - Date.now()) / 86_400_000;
  const date = new Date(t).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (days < 0) return `已於 ${date} 到期`;
  if (days <= 7) return `訂閱到期 ${date}（剩 ${Math.ceil(days)} 天・平台優先消化）`;
  return `訂閱到期 ${date}（約 ${Math.ceil(days)} 天）`;
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
  gemini: "Google Gemini（含 Claude／GPT 多模型池）",
  openai: "OpenAI ChatGPT",
  anthropic: "Anthropic Claude",
  xai: "xAI Grok",
  openrouter: "OpenRouter",
};

/**
 * 分潤換算口徑：
 * 1) 實際已領回：買家消耗額度 ×（NT$199/1000）× 80% = 每點 NT$ 0.1592
 * 2) 預估（訂閱節點）：以官方訂閱月費為錨，不再用「假設每週 2200 買家額度」灌水
 *    滿載月估 = 訂閱月費 × 分配%（= 你願意託管出去的訂閱成本等值）
 *    本週剩餘 = 滿載月估 ×（可調度剩餘% / 分配%）/ 4.3
 */
const NTD_PER_BUYER_POINT_AT_80_PCT = 0.199 * 0.8;
const WEEKS_PER_MONTH = 4.3;

/** 台灣官網常見訂閱月費（含稅參考）；用於預估錨定，非 API token 市價 */
function resolvePlanMonthlyNtd(source: SourceStatus): number {
  const plan = (source.quota?.planType ?? "").toLowerCase();
  if (source.provider === "openai") {
    if (/\bpro\b/.test(plan) && !/plus/.test(plan)) {
      if (/20|200/.test(plan)) return 6990;
      if (/5|100/.test(plan)) return 3300;
      return 3300;
    }
    return 690; // ChatGPT Plus
  }
  if (source.provider === "gemini") {
    if (/ultra/.test(plan)) {
      if (/20/.test(plan)) return 6500;
      return 3300;
    }
    return 650; // Google AI Pro
  }
  if (source.provider === "xai") {
    if (/pro|heavy|premium/.test(plan)) return 3300;
    return 700; // SuperGrok 量級參考
  }
  if (source.provider === "anthropic") return 650;
  return 690;
}

function estimateNodePayoutNtd(source: SourceStatus): {
  allocatablePct: number;
  estWeeklyRemNtd: number;
  estMonthlyCapNtd: number;
  planMonthlyNtd: number;
} {
  const planMonthlyNtd = resolvePlanMonthlyNtd(source);
  const used = source.quota?.primaryUsedPercent ?? 0;
  // 本週在夥伴設定的 shareLimitPct 內還能被平台調度的淨百分比
  const allocatablePct = Math.max(
    0,
    Math.min(source.quota?.primaryRemainingPercent ?? source.shareLimitPct, source.shareLimitPct - used),
  );
  const estMonthlyCapNtd = Math.round((source.shareLimitPct / 100) * planMonthlyNtd);
  const share = Math.max(source.shareLimitPct, 1);
  const estWeeklyRemNtd = Math.round(
    estMonthlyCapNtd * (allocatablePct / share) / WEEKS_PER_MONTH,
  );
  return { allocatablePct, estWeeklyRemNtd, estMonthlyCapNtd, planMonthlyNtd };
}

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

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [ledgerData, setLedgerData] = useState<SupplierUsage[]>([]);
  const [localCli, setLocalCli] = useState<{ provider: "gemini" | "openai" | "xai"; path: string; hint: string }[]>([]);

  // 串接新模型狀態
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
  const [submittingCode, setSubmittingCode] = useState(false);
  /** 同步鎖：避免貼上自動送出與手動送出同 tick 各打一次 */
  const submittingCodeRef = useRef(false);
  /** 同碼只允許送一次；失敗後也擋重送（Google 碼只能換一次） */
  const lastSubmittedCodeRef = useRef<string | null>(null);

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

  // 單一節點即時滑桿草稿（拖動時即時換算金額，放開寫入後端）
  const [draftLimits, setDraftLimits] = useState<Record<string, number>>({});
  const [draftCaps, setDraftCaps] = useState<Record<string, number>>({});
  const [claudeQuickOpen, setClaudeQuickOpen] = useState(false);
  const [claudeQuickKey, setClaudeQuickKey] = useState("");
  const [claudeQuickCap, setClaudeQuickCap] = useState(2000);

  // 進階 Token / API Key
  const [rawProvider, setRawProvider] = useState<"gemini" | "openai" | "xai">("gemini");
  const [rawAccess, setRawAccess] = useState("");
  const [rawRefresh, setRawRefresh] = useState("");
  const [rawExtraId, setRawExtraId] = useState("");

  const [form, setForm] = useState({
    label: "",
    kind: "supplier" as "supplier" | "platform",
    provider: "gemini" as "gemini" | "openai" | "anthropic" | "xai" | "openrouter",
    apiKey: "",
    priority: "",
    monthlyCapPoints: "",
  });
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [srcRes, ledRes] = await Promise.all([
        fetch("/api/sources", { cache: "no-store" }),
        fetch("/api/supplier-usage", { cache: "no-store" }),
      ]);
      if (srcRes.ok) {
        const list = (await srcRes.json()) as SourceStatus[];
        setSources(Array.isArray(list) ? list : []);
      }
      if (ledRes.ok) {
        const led = (await ledRes.json()) as SupplierUsage[];
        setLedgerData(Array.isArray(led) ? led : []);
      }
    } catch {
      // ignore
    }
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
      .then((d) => {
        setLocalCli(d.localCli ?? []);
      })
      .catch(() => {});
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search);
      if (q.get("oauth") === "ok") {
        setOauthMsg({ ok: true, text: "✓ Google 模組串接成功！已自動讀取剩餘容量並納入分配試算" });
        window.history.replaceState({}, "", "/sources");
      }
    }
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [syncAndRefresh, refresh]);

  // 輪詢 ChatGPT／Grok 裝置碼驗證狀態
  useEffect(() => {
    if (!deviceFlow) return;
    let finished = false;
    const timer = setInterval(async () => {
      if (finished) return;
      try {
        const action = deviceFlow.kind === "grok" ? "poll_grok_device" : "poll_chatgpt_device";
        const res = await fetch("/api/oauth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, state: deviceFlow.state }),
        });
        const data = await res.json();
        if (data.status === "completed") {
          finished = true;
          setDeviceFlow(null);
          setOauthMsg({
            ok: true,
            text:
              deviceFlow.kind === "grok"
                ? "✓ Grok 模組串接成功！已自動讀取剩餘容量並納入分配試算"
                : "✓ ChatGPT 模組串接成功！已自動讀取剩餘容量並納入分配試算",
          });
          // 訪客首次串接會發 session cookie → 整頁重整進入已登入 /sources
          if (data.sessionBootstrapped) {
            window.location.assign("/sources?oauth=ok");
            return;
          }
          void refresh();
        } else if (data.error) {
          // 成功後併發輪詢常會噴「找不到驗證狀態」——不可蓋掉已成功的綠字
          if (finished) return;
          finished = true;
          setOauthMsg({ ok: false, text: data.error });
          setDeviceFlow(null);
        }
      } catch {
        // ignore transient network; keep polling
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [deviceFlow, refresh]);

  /** 必須在 await 前記得開窗，否則瀏覽器會當非使用者手勢而封鎖彈窗 */
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

  async function startBrowserOAuth(action: "start_gemini" | "start_chatgpt_browser") {
    setOauthMsg(null);
    setDeviceFlow(null);
    lastSubmittedCodeRef.current = null;
    setCallbackInput("");
    const popup = openAuthPopup();
    const res = await fetch("/api/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      try {
        popup?.close();
      } catch {
        // ignore
      }
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setActiveOAuthState(data.state);
    setActiveAuthUrl(data.authUrl);
    if (action === "start_gemini") {
      try {
        sessionStorage.setItem(OAUTH_STATE_KEY, data.state);
        sessionStorage.setItem(OAUTH_URL_KEY, data.authUrl);
      } catch {
        // ignore
      }
    }
    if (!navigateAuthPopup(popup, data.authUrl)) {
      setOauthMsg({
        ok: false,
        text: "瀏覽器封鎖了彈窗。請點下方「前往 Google 授權」連結繼續（或允許本站彈窗後重試）。",
      });
    }
  }

  async function startChatGptDevice() {
    setOauthMsg(null);
    setActiveAuthUrl(null);
    const popup = openAuthPopup();
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
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setDeviceFlow({ kind: "chatgpt", state: data.state, userCode: data.userCode, verifyUrl: data.verifyUrl });
    if (!navigateAuthPopup(popup, data.verifyUrl)) {
      setOauthMsg({
        ok: false,
        text: "瀏覽器封鎖了彈窗。請點下方官方授權頁連結，並輸入顯示的裝置碼。",
      });
    }
  }

  async function startGrokDevice() {
    setOauthMsg(null);
    setActiveAuthUrl(null);
    const popup = openAuthPopup();
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
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    const verifyUrl = data.verifyUrlComplete || data.verifyUrl;
    setDeviceFlow({ kind: "grok", state: data.state, userCode: data.userCode, verifyUrl });
    if (!navigateAuthPopup(popup, verifyUrl)) {
      setOauthMsg({
        ok: false,
        text: "瀏覽器封鎖了彈窗。請點下方官方授權頁連結，並輸入顯示的裝置碼。",
      });
    }
  }

  async function submitCallbackUrl(overrideValue?: string) {
    const raw = (overrideValue ?? callbackInput).trim();
    if (!raw || submittingCode || submittingCodeRef.current) return;
    if (lastSubmittedCodeRef.current === raw) {
      setOauthMsg({
        ok: false,
        text: "這個授權碼剛送過了。Google 授權碼只能換一次；請重新點上方 Gemini 模組開一輪新授權後再貼。",
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
        text: "找不到本次授權狀態。請在本分頁重新點啟動授權後再貼上（勿重用舊 code）。",
      });
      return;
    }
    submittingCodeRef.current = true;
    lastSubmittedCodeRef.current = raw;
    setSubmittingCode(true);
    setOauthMsg(null);
    try {
      const res = await fetch("/api/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete_code",
          codeOrUrl: raw,
          state,
          label: subLabel,
          shareLimitPct,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOauthMsg({ ok: false, text: data.error });
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
      setOauthMsg({ ok: true, text: `✓ Google 算力節點綁定完成！已即時同步容量${pctNote}` });
      setCallbackInput("");
      setActiveAuthUrl(null);
      setActiveOAuthState(null);
      setSubLabel("");
      lastSubmittedCodeRef.current = null;
      // 訪客首次串接會發 session cookie → 整頁重整進入已登入 /sources
      if (data.sessionBootstrapped) {
        window.location.assign("/sources?oauth=ok");
        return;
      }
      // 本機無 DB 時列表讀不到雲端資料，導向線上 /sources
      goToSourcesAfterBind(() => {
        void refresh();
      });
    } finally {
      submittingCodeRef.current = false;
      setSubmittingCode(false);
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
        setOauthMsg({ ok: false, text: "剪貼簿是空的，請先在 Google 頁面點「Copy to Clipboard」按鈕" });
        return;
      }
      setCallbackInput(txt);
      await submitCallbackUrl(txt);
    } catch {
      setOauthMsg({ ok: false, text: "瀏覽器請允許讀取剪貼簿，或直接在下方框內長按貼上" });
    }
  }

  async function importCli(provider: "gemini" | "openai" | "xai") {
    setOauthMsg(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "import_local_cli", provider, label: subLabel, shareLimitPct }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOauthMsg({ ok: false, text: data.error });
      return;
    }
    setOauthMsg({ ok: true, text: "✓ 已匯入本機登入節點並同步容量" });
    void refresh();
  }

  async function submitRawToken() {
    if (!rawAccess.trim()) return;
    setOauthMsg(null);
    const res = await fetch("/api/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    setOauthMsg({ ok: true, text: "✓ OAuth Token 已加入並同步容量！" });
    setRawAccess("");
    setRawRefresh("");
    setRawExtraId("");
    void refresh();
  }

  async function syncQuotas(sourceId?: string) {
    setSyncing(true);
    await fetch("/api/oauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
    setKeyMsg({ ok: true, text: "✓ 已驗證並加入 API Key 節點" });
    setForm((f) => ({ ...f, label: "", apiKey: "" }));
    void refresh();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/sources/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    void refresh();
  }

  async function remove(id: string) {
    if (
      !confirm(
        "確定移除此算力節點？\n\n節點會停止派發，但已產生的分潤／用量對帳會保留，不會因移除而歸零。",
      )
    ) {
      return;
    }
    await fetch(`/api/sources/${id}`, { method: "DELETE" });
    void refresh();
  }

  const oauthSources = useMemo(() => sources.filter((s) => s.authType === "oauth_sub"), [sources]);

  // 統計 7 天實際已產生分潤 & 全節點預估可領金額（含 OAuth 訂閱池與 Claude / API 分配池）
  const summaryStats = useMemo(() => {
    const weekBuyerPoints = ledgerData.reduce((acc, s) => acc + (s.chargedPoints ?? 0), 0);
    const weekMessages = ledgerData.reduce((acc, s) => acc + (s.messages ?? 0), 0);
    const weekEarnedNtd = Math.round(weekBuyerPoints * NTD_PER_BUYER_POINT_AT_80_PCT);

    let estWeeklyRemTotal = 0;
    let estMonthlyCapTotal = 0;
    for (const s of sources) {
      if (!s.enabled) continue;
      if (s.authType === "oauth_sub") {
        const effectivePct = draftLimits[s.id] ?? s.shareLimitPct;
        const calc = estimateNodePayoutNtd({ ...s, shareLimitPct: effectivePct });
        estWeeklyRemTotal += calc.estWeeklyRemNtd;
        estMonthlyCapTotal += calc.estMonthlyCapNtd;
      } else {
        const cap = draftCaps[s.id] ?? s.monthlyCapPoints ?? 2000;
        const remPts = Math.max(0, cap - s.usedThisMonthPoints);
        estWeeklyRemTotal += Math.round((remPts / 4.3) * NTD_PER_BUYER_POINT_AT_80_PCT);
        estMonthlyCapTotal += Math.round(cap * NTD_PER_BUYER_POINT_AT_80_PCT);
      }
    }
    return {
      weekBuyerPoints,
      weekMessages,
      weekEarnedNtd,
      estWeeklyRemTotal,
      estMonthlyCapTotal,
    };
  }, [ledgerData, sources, draftLimits, draftCaps]);

  // 新增模組試算：預設以 ChatGPT Plus 月費錨（實際接入後會依方案自動對齊）
  const newNodeEstMonthlyNtd = Math.round((shareLimitPct / 100) * 690);

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="points-badge badge-brand" style={{ marginBottom: 6 }}>
            算力節點夥伴控制台（Node Partner）
          </div>
          <h1 style={{ margin: 0 }}>分配用量設定・80% 創作者分潤試算・多模型串接</h1>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => void syncQuotas()} disabled={syncing}>
            {syncing ? "同步中…" : "🔄 同步最新節點容量"}
          </button>
          <Link href="/vendor">夥伴條款說明（/vendor）</Link>
          <Link href="/">← 返回雲端工作台（聊天首頁）</Link>
        </div>
      </div>

      <p className="muted" style={{ lineHeight: 1.6 }}>
        在此自由調整各個已授權節點的<strong>託管分配比例</strong>，即時查看預估可領回的{" "}
        <strong>AI 工作流／Agent 創作者上架分潤（80% 回饋）</strong>；同時可繼續串接{" "}
        <strong>Google Gemini、OpenAI ChatGPT、xAI Grok、Anthropic Claude</strong> 四大模型模組，參與多節點智慧路由託管與負載平衡測試。
      </p>

      {/* === 1. 總覽指標卡：已產出回饋 + 本週剩餘可轉化回饋 + 滿載月估 === */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div className="card" style={{ marginBottom: 0, borderColor: "var(--ok)" }}>
          <div className="muted" style={{ fontSize: 12 }}>
            近 7 天已產生分潤（實績・移除節點不歸零）
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "var(--ok)", margin: "6px 0 4px" }}>
            NT$ {summaryStats.weekEarnedNtd.toLocaleString("zh-TW")}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            共 {summaryStats.weekMessages} 筆任務（{summaryStats.weekBuyerPoints.toFixed(1)} 額度 × 80%）。出金結算上線前以此為對帳口徑。
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            現行節點・剩餘產能預估（非錢包餘額）
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, margin: "6px 0 4px" }}>
            約 NT$ {summaryStats.estWeeklyRemTotal.toLocaleString("zh-TW")}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            依目前已綁節點剩餘 % 試算；移除節點後此欄會下降，不代表已賺金額被清掉。
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            現行配置・滿載月估（產能潛力）
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "var(--accent)", margin: "6px 0 4px" }}>
            約 NT$ {summaryStats.estMonthlyCapTotal.toLocaleString("zh-TW")} / 月
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            訂閱月費 × 分配%。實際可提領＝已產生分潤累計 − 已出金（出金流程即將接上）。
          </div>
        </div>
      </div>

      {/* === 2. 已接入節點：拉滑桿設定分配比例 + 即時換算多少錢回來 === */}
      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>步驟 A：設定已串接節點的分配用量＆回饋金額換算（{sources.length} 組）</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            預估錨定官方訂閱月費（如 Plus NT$690）；實際入帳看買家消耗額度 × 80%。達上限自動停派。
          </span>
        </div>

        {sources.length === 0 ? (
          <div
            style={{
              padding: "18px 16px",
              borderRadius: 10,
              background: "var(--panel-2)",
              border: "1px dashed var(--border)",
            }}
          >
            <strong>尚未偵測到已綁定的算力節點。</strong>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
              請從下方「步驟 B：串接其他模型模組」點選 Google Gemini、ChatGPT 或 Grok 完成授權，節點就會出現在這裡讓您拉動分配比例並換算回饋金額！
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {[...sources]
              .sort((a, b) => {
                if (a.authType !== b.authType) return a.authType === "oauth_sub" ? -1 : 1;
                return a.priority - b.priority;
              })
              .map((s) => {
                const currentLimit = draftLimits[s.id] ?? s.shareLimitPct;
                const est = estimateNodePayoutNtd({ ...s, shareLimitPct: currentLimit });
                const expiryLabel = formatSubscriptionExpiry(s.quota);
                return (
                  <div
                    key={s.id}
                    style={{
                      padding: 16,
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "var(--panel-2)",
                    }}
                  >
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                      <div>
                        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <strong style={{ fontSize: 16 }}>{s.label}</strong>
                          <span className={`tag ${s.kind}`}>
                            {PROVIDER_LABEL[s.provider] ?? s.provider}
                          </span>
                          {!s.enabled ? (
                            <span className="muted">
                              （已暫停
                              {s.quota?.subscriptionStatus === "inactive"
                                ? "・偵測到退訂／失效"
                                : s.quota?.subscriptionStatus === "auth_failed"
                                  ? "・授權失效"
                                  : ""}
                              ）
                            </span>
                          ) : s.cooldownUntil ? (
                            <span className="notice">冷卻保護中（{Math.ceil((s.cooldownUntil - Date.now()) / 1000)}s）</span>
                          ) : (
                            <span style={{ color: "var(--ok)", fontSize: 12, fontWeight: 600 }}>● 智慧路由待命／派發中</span>
                          )}
                          {s.authType === "oauth_sub" &&
                            s.quota?.subscriptionExpiresAt &&
                            (() => {
                              const days =
                                (Date.parse(s.quota.subscriptionExpiresAt) - Date.now()) / 86_400_000;
                              if (days >= 0 && days <= 7) {
                                return (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      color: "var(--warn, #d4a017)",
                                      border: "1px solid var(--warn, #d4a017)",
                                      borderRadius: 6,
                                      padding: "1px 6px",
                                    }}
                                  >
                                    即將到期・優先派發
                                  </span>
                                );
                              }
                              return null;
                            })()}
                        </div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          {s.quota?.email ? `${s.quota.email} · ` : ""}識別：{s.keyHint}
                          {expiryLabel ? (
                            <>
                              <br />
                              {expiryLabel}
                            </>
                          ) : s.authType === "oauth_sub" ? (
                            <>
                              <br />
                              訂閱到期日：
                              {s.provider === "gemini"
                                ? "Gemini／Antigravity 通常不回傳帳單日（僅能偵測授權失效）"
                                : "同步後顯示（請按「重抓容量」）"}
                            </>
                          ) : null}
                        </div>
                      </div>

                      {!s.fromEnv && (
                        <div className="row" style={{ gap: 8 }}>
                          {s.authType === "oauth_sub" && (
                            <button type="button" onClick={() => void syncQuotas(s.id)} disabled={syncing}>
                              重抓容量
                            </button>
                          )}
                          <button type="button" onClick={() => void patch(s.id, { enabled: !s.enabled })}>
                            {s.enabled ? "暫停託管" : "恢復託管"}
                          </button>
                          <button type="button" onClick={() => void remove(s.id)}>
                            移除
                          </button>
                        </div>
                      )}
                    </div>

                    {s.authType === "oauth_sub" ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                          gap: 16,
                          marginTop: 14,
                          alignItems: "center",
                        }}
                      >
                        {/* 左：官方即時各模型池剩餘 % */}
                        <div>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                            官方即時剩餘容量（對齊 Models &amp; Usage）：
                          </div>
                          {s.quota ? (
                            <div style={{ display: "grid", gap: 6 }}>
                              {s.quota.windows.map((w, i) => {
                                const isClaudePool = /claude/i.test(w.label);
                                return (
                                  <div key={i}>
                                    <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                                      <span>
                                        {isClaudePool ? <strong>◈ {w.label}（Claude 分配池）</strong> : w.label}
                                      </span>
                                      <span>
                                        剩餘 <strong>{w.uiRemainingPercent ?? Math.round(w.remainingPercent)}%</strong>
                                        <span className="muted">（已用 {w.usedPercent.toFixed(1)}%）</span>
                                      </span>
                                    </div>
                                    <div
                                      style={{
                                        height: 7,
                                        background: "var(--bg)",
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
                                            w.usedPercent >= currentLimit
                                              ? "var(--warn)"
                                              : w.remainingPercent > 30
                                                ? "var(--ok)"
                                                : "var(--danger)",
                                        }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>尚無容量快照，請點「重抓容量」</span>
                          )}
                        </div>

                        {/* 右：分配比例拉桿 + 即時換算台幣回饋 */}
                        <div
                          style={{
                            padding: "12px 14px",
                            borderRadius: 10,
                            background: "var(--panel)",
                            border: "1px solid var(--border)",
                          }}
                        >
                          <div className="row" style={{ justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                            <span>
                              願意分配託管上限：<strong>{currentLimit}%</strong>
                            </span>
                            <span className="muted">
                              為自己保留 {100 - Math.min(currentLimit, MAX_SUPPLIER_SHARE_LIMIT_PCT)}%（平台上限{" "}
                              {MAX_SUPPLIER_SHARE_LIMIT_PCT}%）
                            </span>
                          </div>
                          <input
                            type="range"
                            min={10}
                            max={MAX_SUPPLIER_SHARE_LIMIT_PCT}
                            step={5}
                            value={Math.min(currentLimit, MAX_SUPPLIER_SHARE_LIMIT_PCT)}
                            style={{ width: "100%" }}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setDraftLimits((prev) => ({ ...prev, [s.id]: v }));
                            }}
                            onMouseUp={() => {
                              const v = draftLimits[s.id];
                              if (v !== undefined && v !== s.shareLimitPct) {
                                void patch(s.id, { shareLimitPct: v });
                              }
                            }}
                            onTouchEnd={() => {
                              const v = draftLimits[s.id];
                              if (v !== undefined && v !== s.shareLimitPct) {
                                void patch(s.id, { shareLimitPct: v });
                              }
                            }}
                          />
                          <div
                            style={{
                              marginTop: 8,
                              paddingTop: 8,
                              borderTop: "1px solid var(--border)",
                              display: "flex",
                              justifyContent: "space-between",
                              flexWrap: "wrap",
                              gap: 8,
                              fontSize: 13,
                            }}
                          >
                            <div>
                              本週剩餘可轉化（{est.allocatablePct.toFixed(0)}%）：{" "}
                              <strong style={{ color: "var(--ok)", fontSize: 15 }}>
                                約 NT$ {est.estWeeklyRemNtd.toLocaleString("zh-TW")}
                              </strong>
                            </div>
                            <div className="muted" style={{ textAlign: "right" }}>
                              滿載月估（訂閱 {est.planMonthlyNtd.toLocaleString("zh-TW")} × {currentLimit}%）：
                              <strong style={{ color: "var(--text)" }}>
                                {" "}
                                NT$ {est.estMonthlyCapNtd.toLocaleString("zh-TW")} / 月
                              </strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      (() => {
                        const cap = draftCaps[s.id] ?? s.monthlyCapPoints ?? 2000;
                        const remPts = Math.max(0, cap - s.usedThisMonthPoints);
                        const estMonthNtd = Math.round(cap * NTD_PER_BUYER_POINT_AT_80_PCT);
                        const estRemNtd = Math.round(remPts * NTD_PER_BUYER_POINT_AT_80_PCT);
                        return (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                              gap: 16,
                              marginTop: 14,
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                                {s.provider === "anthropic" ? "◈ Claude 模組分配額度使用狀況：" : "API 模組分配額度使用狀況："}
                              </div>
                              <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                                <span>本月已調度 {s.usedThisMonthPoints.toFixed(1)} 額度</span>
                                <span>
                                  剩餘可分配 <strong>{remPts.toFixed(0)}</strong> / {cap.toLocaleString("zh-TW")} 額度
                                </span>
                              </div>
                              <div
                                style={{
                                  height: 7,
                                  background: "var(--bg)",
                                  borderRadius: 4,
                                  overflow: "hidden",
                                  marginTop: 4,
                                }}
                              >
                                <div
                                  style={{
                                    width: `${Math.min(100, (100 * remPts) / Math.max(1, cap))}%`,
                                    height: "100%",
                                    background: remPts > cap * 0.2 ? "var(--ok)" : "var(--warn)",
                                  }}
                                />
                              </div>
                            </div>

                            {!s.fromEnv && (
                              <div
                                style={{
                                  padding: "12px 14px",
                                  borderRadius: 10,
                                  background: "var(--panel)",
                                  border: "1px solid var(--border)",
                                }}
                              >
                                <div className="row" style={{ justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                                  <span>
                                    每月分配額度上限：<strong>{cap.toLocaleString("zh-TW")} 額度</strong>
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min={500}
                                  max={10000}
                                  step={500}
                                  value={cap}
                                  style={{ width: "100%" }}
                                  onChange={(e) => {
                                    const v = Number(e.target.value);
                                    setDraftCaps((prev) => ({ ...prev, [s.id]: v }));
                                  }}
                                  onMouseUp={() => {
                                    const v = draftCaps[s.id];
                                    if (v !== undefined && v !== s.monthlyCapPoints) {
                                      void patch(s.id, { monthlyCapPoints: v });
                                    }
                                  }}
                                  onTouchEnd={() => {
                                    const v = draftCaps[s.id];
                                    if (v !== undefined && v !== s.monthlyCapPoints) {
                                      void patch(s.id, { monthlyCapPoints: v });
                                    }
                                  }}
                                />
                                <div
                                  style={{
                                    marginTop: 8,
                                    paddingTop: 8,
                                    borderTop: "1px solid var(--border)",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    flexWrap: "wrap",
                                    gap: 8,
                                    fontSize: 13,
                                  }}
                                >
                                  <div>
                                    剩餘可轉化分潤：{" "}
                                    <strong style={{ color: "var(--ok)", fontSize: 15 }}>
                                      約 NT$ {estRemNtd.toLocaleString("zh-TW")}
                                    </strong>
                                  </div>
                                  <div className="muted">
                                    滿載月估：<strong style={{ color: "var(--text)" }}>NT$ {estMonthNtd.toLocaleString("zh-TW")} / 月</strong>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* === 3. 串接其他模型模組（Gemini / ChatGPT / Grok / API Key） === */}
      <div className="card" style={{ borderColor: "var(--ok)" }}>
        <h3 style={{ marginTop: 0, color: "var(--ok)" }}>
          步驟 B：繼續串接其他 AI 模型模組（擴大算力池與 80% 創作者分潤）
        </h3>
        <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
          您可以同時串接 <strong>Google Gemini + OpenAI ChatGPT + xAI Grok</strong>，或綁定第 2 個同廠牌帳號無縫接力。當第 1 個節點達到您設定的分配上限時，智慧路由會自動切換下一個節點繼續賺取分潤。
        </p>

        <div className="form-grid" style={{ marginBottom: 14 }}>
          <label>
            新節點別名（選填，方便分辨多組帳號）
            <input
              value={subLabel}
              placeholder="例如：我的 ChatGPT Plus #1 或 Grok 節點"
              onChange={(e) => setSubLabel(e.target.value)}
            />
          </label>
          <label>
            預設託管分配比例：{shareLimitPct}%（最多 {MAX_SUPPLIER_SHARE_LIMIT_PCT}%；滿載月估回饋約 NT${" "}
            {newNodeEstMonthlyNtd.toLocaleString("zh-TW")}）
            <input
              type="range"
              min={20}
              max={MAX_SUPPLIER_SHARE_LIMIT_PCT}
              step={5}
              value={Math.min(shareLimitPct, MAX_SUPPLIER_SHARE_LIMIT_PCT)}
              onChange={(e) => setShareLimitPct(Number(e.target.value))}
            />
          </label>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <button
            type="button"
            className="primary"
            style={{ padding: "12px 14px", textAlign: "left" }}
            onClick={() => void startBrowserOAuth("start_gemini")}
          >
            <div style={{ fontWeight: 700 }}>✦ Google Gemini 模組（AI Pro / Ultra，含 Claude & GPT 池）</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 3 }}>
              官方認證頁複製代碼 · 回本頁輸入欄按「貼上」完成
            </div>
          </button>

          <button
            type="button"
            className="primary"
            style={{ padding: "12px 14px", textAlign: "left" }}
            onClick={() => void startChatGptDevice()}
          >
            <div style={{ fontWeight: 700 }}>◎ OpenAI ChatGPT 模組（Plus / Pro）</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 3 }}>網頁／手機裝置碼 OAuth · 自動輪詢</div>
          </button>

          <button
            type="button"
            className="primary"
            style={{ padding: "12px 14px", textAlign: "left" }}
            onClick={() => void startGrokDevice()}
          >
            <div style={{ fontWeight: 700 }}>𝕏 xAI Grok 模組（SuperGrok）</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 3 }}>網頁／手機裝置碼 OAuth · 自動輪詢</div>
          </button>

          <button
            type="button"
            className="primary"
            style={{ padding: "12px 14px", textAlign: "left" }}
            onClick={() => setClaudeQuickOpen((v) => !v)}
          >
            <div style={{ fontWeight: 700 }}>◈ Anthropic Claude 模組（Sonnet / Opus）</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 3 }}>Google OAuth 同步 Claude 池 或 API Key</div>
          </button>
        </div>

        {claudeQuickOpen && (
          <div className="card" style={{ marginTop: 10, marginBottom: 12, background: "var(--panel-2)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>◈ 串接 Anthropic Claude 分配額度</div>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.5 }}>
              方式 A：若您的 Claude 額度來自 Google AI Pro / Ultra（Antigravity 訂閱內含獨立 Claude 5.5 池），直接點{" "}
              <button type="button" onClick={() => void startBrowserOAuth("start_gemini")}>
                Google OAuth 同步 Claude 池
              </button>{" "}
              即可自動帶入剩餘 %。
              <br />
              方式 B：直接綁定 Anthropic 官方 API Key 並設定每月願意分配的額度上限：
            </p>
            <div className="form-grid">
              <label>
                Anthropic Claude API Key
                <input
                  type="password"
                  placeholder="sk-ant-..."
                  value={claudeQuickKey}
                  onChange={(e) => setClaudeQuickKey(e.target.value)}
                />
              </label>
              <label>
                每月分配額度上限：{claudeQuickCap.toLocaleString("zh-TW")} 額度（預估分潤約 NT${" "}
                {Math.round(claudeQuickCap * NTD_PER_BUYER_POINT_AT_80_PCT).toLocaleString("zh-TW")} / 月）
                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={500}
                  value={claudeQuickCap}
                  onChange={(e) => setClaudeQuickCap(Number(e.target.value))}
                />
              </label>
              <div className="full">
                <button
                  type="button"
                  className="primary"
                  disabled={savingKey || !claudeQuickKey.trim()}
                  onClick={async () => {
                    setSavingKey(true);
                    setOauthMsg(null);
                    const res = await fetch("/api/sources", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        label: subLabel.trim() || "Claude 算力節點",
                        kind: "supplier",
                        provider: "anthropic",
                        apiKey: claudeQuickKey.trim(),
                        monthlyCapPoints: claudeQuickCap,
                      }),
                    });
                    const data = await res.json();
                    setSavingKey(false);
                    if (!res.ok) {
                      setOauthMsg({ ok: false, text: data.error || "Claude Key 驗證失敗" });
                      return;
                    }
                    setClaudeQuickKey("");
                    setClaudeQuickOpen(false);
                    setOauthMsg({ ok: true, text: "✓ Claude 算力模組已加入上方分配額度清單！" });
                    void refresh();
                  }}
                >
                  {savingKey ? "驗證中…" : "驗證並加入 Claude 分配額度"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button type="button" onClick={() => void startBrowserOAuth("start_chatgpt_browser")}>
            💻 ChatGPT 本機瀏覽器 OAuth（備選）
          </button>
          {localCli.map((c) => (
            <button type="button" key={c.path} onClick={() => void importCli(c.provider)}>
              ⚡ 一鍵匯入本機已登入{" "}
              {c.provider === "gemini" ? "Gemini" : c.provider === "xai" ? "Grok" : "ChatGPT"} ({c.hint})
            </button>
          ))}
        </div>

        {deviceFlow && (
          <div className="card" style={{ marginTop: 14, background: "var(--panel-2)" }}>
            <div style={{ fontSize: 13 }}>
              請在開啟的 {deviceFlow.kind === "grok" ? "xAI／Grok" : "OpenAI"} 官方授權頁（
              <a href={deviceFlow.verifyUrl} target="_blank" rel="noreferrer">
                {deviceFlow.verifyUrl}
              </a>
              ）輸入以下驗證碼：
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 3, margin: "10px 0", color: "var(--ok)" }}>
              {deviceFlow.userCode}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              在官方頁面按下允許後，本頁將自動偵測完成並加入上方分配清單…
            </div>
          </div>
        )}

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
            <div style={{ marginBottom: 10, fontSize: 13, lineHeight: 1.7 }}>
              ① 在授權分頁登入並按「允許」，於官方頁點 <strong>Copy to Clipboard</strong>。
              <br />
              ② 回到本頁，在下方輸入欄點 <strong>貼上</strong>（或直接貼上授權碼）即可綁定。
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <input
                style={{ flex: 1, minWidth: 220 }}
                value={callbackInput}
                disabled={submittingCode}
                placeholder="貼上授權碼（4/0A...）即自動綁定"
                onChange={(e) => onCallbackInputChange(e.target.value)}
              />
              <button
                type="button"
                className="primary"
                disabled={submittingCode}
                onClick={() => void pasteFromClipboardAndSubmit()}
              >
                {submittingCode ? "綁定中…" : "貼上"}
              </button>
              <button
                type="button"
                disabled={submittingCode || !callbackInput.trim()}
                onClick={() => void submitCallbackUrl()}
              >
                {submittingCode ? "綁定中…" : "送出"}
              </button>
            </div>
          </div>
        )}

        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
            進階：直接貼上 OAuth Access / Refresh Token 或串接傳統 API Key
          </summary>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>
              OAuth 平台
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
              {rawProvider === "gemini" ? "Project ID（選填）" : "ChatGPT Account ID（選填）"}
              <input value={rawExtraId} onChange={(e) => setRawExtraId(e.target.value)} />
            </label>
            <label>
              OAuth Access Token
              <input type="password" value={rawAccess} onChange={(e) => setRawAccess(e.target.value)} />
            </label>
            <label>
              OAuth Refresh Token（選填，自動續期）
              <input type="password" value={rawRefresh} onChange={(e) => setRawRefresh(e.target.value)} />
            </label>
            <div className="full">
              <button type="button" onClick={() => void submitRawToken()} disabled={!rawAccess.trim()}>
                加入 OAuth Token 節點
              </button>
            </div>
          </div>

          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />

          <div className="form-grid">
            <label>
              API Key 類型
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "supplier" | "platform" })}>
                <option value="supplier">夥伴託管 API Key</option>
                <option value="platform">平台保底 API Key</option>
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
                <option value="anthropic">Anthropic Claude API</option>
                <option value="xai">xAI Grok API</option>
                <option value="openrouter">OpenRouter（全模型）</option>
              </select>
            </label>
            <label>
              節點名稱
              <input value={form.label} placeholder="例如：Anthropic Claude 備援節點" onChange={(e) => setForm({ ...form, label: e.target.value })} />
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
              <button type="button" onClick={() => void addApiKey()} disabled={savingKey || !form.apiKey.trim()}>
                {savingKey ? "驗證中…" : "驗證並加入 API Key"}
              </button>
              {keyMsg && <span className={keyMsg.ok ? "" : "error"}>{keyMsg.text}</span>}
            </div>
          </div>
        </details>

        {oauthMsg && (
          <div style={{ marginTop: 10, fontWeight: 600, color: oauthMsg.ok ? "var(--ok)" : "var(--danger)" }}>
            {oauthMsg.text}
          </div>
        )}
      </div>

      {/* === 4. 每筆任務透明扣量與分潤對帳明細 === */}
      {ledgerData.length > 0 && (
        <div className="card" style={{ borderColor: "var(--warn)" }}>
          <h3 style={{ marginTop: 0 }}>節點任務與 80% 創作者分潤對帳明細（近 7 天）</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.6 }}>
            每筆工作流任務前後皆讀取官方即時剩餘容量，透明記錄實際使用比例與對應之 <strong>80% 創作者上架分潤</strong>。
          </p>
          {ledgerData.map((s) => {
            const nodeNtd = Math.round((s.chargedPoints ?? 0) * NTD_PER_BUYER_POINT_AT_80_PCT);
            return (
              <div key={s.sourceId} style={{ marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <strong>{s.label}</strong>
                  <span>
                    近 7 天調度 <strong style={{ color: "var(--warn)" }}>{s.totalUsedPct.toFixed(3)}%</strong>
                    ・{s.messages} 筆任務・累計 80% 分潤{" "}
                    <strong style={{ color: "var(--ok)", fontSize: 16 }}>NT$ {nodeNtd.toLocaleString("zh-TW")}</strong>
                    <span className="muted">（對應 {s.chargedPoints.toFixed(2)} 額度）</span>
                  </span>
                </div>
                {s.rows.length > 0 && (
                  <table style={{ marginTop: 8, fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>時間</th>
                        <th>執行模型</th>
                        <th>容量池</th>
                        <th>本筆耗用容量</th>
                        <th>80% 創作者分潤</th>
                        <th>Token (進/出)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.slice(0, 20).map((r, i) => {
                        const rowNtd = (r.chargedPoints ?? 0) * NTD_PER_BUYER_POINT_AT_80_PCT;
                        return (
                          <tr key={i}>
                            <td className="muted">{new Date(r.createdAt).toLocaleTimeString("zh-TW")}</td>
                            <td>
                              <code>{r.upstreamModelVersion || r.model}</code>
                            </td>
                            <td>{r.quotaLabel ?? "—"}</td>
                            <td style={{ color: "var(--warn)", fontWeight: 600 }}>
                              {r.quotaUsedPct != null ? `-${r.quotaUsedPct.toFixed(3)}%` : "—"}
                            </td>
                            <td style={{ color: "var(--ok)", fontWeight: 600 }}>
                              +NT$ {rowNtd.toFixed(2)}
                            </td>
                            <td className="muted">
                              {r.inputTokens ?? 0} / {r.outputTokens ?? 0}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
