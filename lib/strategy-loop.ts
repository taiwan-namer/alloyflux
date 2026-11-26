import { randomUUID } from "node:crypto";
import { db } from "./db";
import { findModel } from "./models";
import {
  BUILTIN_STRATEGY_TEMPLATES,
  TEMPLATE_ID_RE,
  type RecommendedModelSlot,
  type StrategyTemplate,
} from "./strategy-templates";

export type StrategyPlanStatus =
  | "pending_code"
  | "coding"
  | "needs_review"
  | "accepted"
  | "rejected"
  | "blocked";

export type StrategySessionStatus =
  | "discovery"
  | "designing"
  | "ready_to_run"
  | "running"
  | "collecting"
  | "reviewing"
  | "await_code"
  | "ready_next_run"
  | "closed";

export const STRATEGY_SESSION_STATUSES: StrategySessionStatus[] = [
  "discovery",
  "designing",
  "ready_to_run",
  "running",
  "collecting",
  "reviewing",
  "await_code",
  "ready_next_run",
  "closed",
];

export type PauseState = "none" | "pausing" | "paused";
export type PauseAction = "graceful_pause" | "force_pause" | "resume";

export const PAUSE_ACTIONS: PauseAction[] = ["graceful_pause", "force_pause", "resume"];

function normalizePauseState(raw: unknown): PauseState {
  const s = String(raw ?? "");
  if (s === "pausing" || s === "paused") return s;
  return "none";
}

/**
 * 會議室每回合送上游的字數預算。歷史會被 slideMessagesForUpstream 再裁（8 輪、舊 assistant ≤1800 字），
 * 所以長期記憶放 dossier，大數據由 Cursor 本機彙總成報告再上傳。
 * 4A：模型上下文改 bounded history（預設 12＋字元 budget）；API 歷史改分頁／游標，不再以 40 為永久完整歷史。
 */
export const STRATEGY_LIMITS = {
  messageMaxChars: 8000,
  reportMaxChars: 30000,
  dossierMaxChars: 12000,
  reportsInjectMaxChars: 24000,
  reportInjectEachMaxChars: 8000,
  runsInjectMaxChars: 6000,
  /** 送入模型的訊息則數上限（bounded；再受 historyCharBudget 裁切） */
  historyMessages: 12,
  /** 無精確 token 計算器時的保守字元預算（約略對應數 k tokens） */
  historyCharBudget: 24000,
  /** 為 bounded 裁切多撈一些再裁 */
  historyFetchLimit: 40,
  /** 單頁歷史預設／最大 */
  messagesPageSize: 100,
  messagesPageMax: 200,
  /** 單次開房／sync 合併硬頂（超過則 hasMore） */
  messagesHardCap: 2000,
  summaryMaxChars: 800,
  roomQueryMaxChars: 2000,
  roomQueriesPerTurn: 3,
  workspaceMemoryMaxChars: 4000,
  workspaceBriefMaxChars: 6000,
  /** 主持人歷史視窗：至少保留則數；起點對齊 historyWindowStep 的倍數（前綴穩定才吃得到 prompt cache） */
  historyMinMessages: 8,
  historyWindowStep: 4,
  strategyHistoryCharBudget: 14000,
  /** 歷史中較舊主持人回覆的固定壓縮上限（與聊天的舊回覆相同；使用者原文不裁） */
  historyOlderAssistantMaxChars: 1800,
  /** 同一系列報告（_p1/_p2…）合併後的注入上限 */
  reportSeriesInjectMaxChars: 12000,
  reportsIndexMaxChars: 1500,
  reportFocusMax: 3,
  /** 未觸發回合的 Cursor 通知：注入則數／單則字數 */
  notesInjectMax: 6,
  noteInjectMaxChars: 600,
  /** 精簡會議室：像一般聊天只讀對話；回報可整份貼上 */
  leanMessageMaxChars: 30000,
  leanHistoryMinMessages: 10,
  leanHistoryCharBudget: 40000,
  leanOlderAssistantMaxChars: 1800,
  /** 使用者每提出一次需求後，Cursor 最多能觸發幾次主持人回合 */
  leanCursorTurnsPerTask: 4,
} as const;

export type StrategyRoomMode = "classic" | "lean";
export type LeanTurnType = "align" | "report";

export function readRoomMode(meta: Record<string, unknown> | null | undefined): StrategyRoomMode {
  return meta?.mode === "lean" ? "lean" : "classic";
}

export function parseLeanTurnType(raw: unknown): LeanTurnType | null {
  return raw === "align" || raw === "report" ? raw : null;
}

/** 從最後一則網頁訊息（使用者提出需求）之後，Cursor 已觸發幾次主持人回合 */
export function countCursorTurnsSinceWeb(
  messages: { role: string; structured?: Record<string, unknown> | null }[],
): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || isHistoryExcluded(m.structured)) continue;
    if (m.structured?.source === "web") break;
    n += 1;
  }
  return n;
}

export type StrategyMessageCompletionStatus =
  | "ok"
  | "degraded"
  | "partial"
  | "aborted"
  | "failed";

export type StrategySessionMessageRow = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  structured: Record<string, unknown>;
  createdAt: number;
  speakerModel: string | null;
  speakerRole: string | null;
  speakerLabel: string | null;
  turnId: string | null;
  completionStatus: StrategyMessageCompletionStatus | null;
};

/** 編碼／解碼歷史游標：`${createdAt}:${id}`（較舊方向） */
export function encodeMessageCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`;
}

export function decodeMessageCursor(raw: string | null | undefined): { createdAt: number; id: string } | null {
  if (!raw || !raw.trim()) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const createdAt = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1).trim();
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

/** partial 是否應寫入 lead assistant 列（空字串禁止，避免前端空氣泡） */
export function shouldPersistPartialAssistant(visibleText: string): boolean {
  return Boolean(visibleText?.trim());
}

/** idempotent 命中時是否允許以較完整狀態覆寫（串流快照／done-after-abort／retry） */
export function shouldUpgradeTurnCompletion(
  prev: StrategyMessageCompletionStatus | null | undefined,
  next: StrategyMessageCompletionStatus | null | undefined,
): boolean {
  // 收尾（ok／degraded）永遠可寫入：分隔線曾標 ok 後，仍要補上 instructions
  if (next === "ok" || next === "degraded") return true;
  // 已收尾的不降回 partial／aborted／failed
  if (prev === "ok" || prev === "degraded") return false;
  // 未完成的快照可越寫越長，並可收成 aborted／failed；已中斷的不再退回 partial
  if (prev == null || prev === "partial") {
    return next === "partial" || next === "aborted" || next === "failed";
  }
  return false;
}

/**
 * 從較新往較舊裁切，保留最新輪次；優先維持 user/assistant 成對；受 maxMessages＋maxChars 雙閘。
 * 無精確 token 計算器 → 以字元數作保守 fallback。
 */
export function selectBoundedHistory<T extends { role: string; content: string }>(
  messages: T[],
  opts?: { maxMessages?: number; maxChars?: number },
): T[] {
  const maxMessages = Math.max(1, opts?.maxMessages ?? STRATEGY_LIMITS.historyMessages);
  const maxChars = Math.max(500, opts?.maxChars ?? STRATEGY_LIMITS.historyCharBudget);
  const usable = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!usable.length) return [];

  let slice = usable.slice(-maxMessages);
  while (slice.length && slice[0]!.role !== "user") slice = slice.slice(1);

  const totalChars = () => slice.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  while (slice.length > 2 && totalChars() > maxChars) {
    // 從最舊成對移除（user + 其後 assistant），否則只移一則
    if (slice[0]?.role === "user" && slice[1]?.role === "assistant") {
      slice = slice.slice(2);
    } else {
      slice = slice.slice(1);
    }
    while (slice.length && slice[0]!.role !== "user") slice = slice.slice(1);
  }
  if (totalChars() > maxChars && slice.length) {
    // 仍超標：裁最舊一則 content 尾端保留頭（極保守，通常不會走到）
    const first = slice[0]!;
    const budget = Math.max(200, maxChars - totalChars() + first.content.length);
    slice = [{ ...first, content: first.content.slice(0, budget) }, ...slice.slice(1)];
  }
  return slice;
}

function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.62);
  const tail = Math.max(0, max - head);
  return `${text.slice(0, head)}\n…[中略]…\n${text.slice(-tail)}`;
}

/** Cursor 通知（noReply）與顧問發言不進主持人歷史 */
export function isHistoryExcluded(structured: Record<string, unknown> | null | undefined): boolean {
  const kind = structured?.kind;
  return kind === "note" || kind === "advisor";
}

/**
 * 主持人歷史：起點對齊格線（每 historyWindowStep 則才前移），超出字數也按格線前移；
 * 較舊訊息依自身內容固定壓縮。連續幾回合送出的開頭完全相同，才命中 prompt cache。
 */
export function selectStrategyHistory<
  T extends { role: string; content: string; structured?: Record<string, unknown> | null },
>(
  messages: T[],
  opts?: {
    minKeep?: number;
    step?: number;
    maxChars?: number;
    offset?: number;
    olderAssistantMaxChars?: number;
  },
): T[] {
  const minKeep = Math.max(2, opts?.minKeep ?? STRATEGY_LIMITS.historyMinMessages);
  const step = Math.max(1, opts?.step ?? STRATEGY_LIMITS.historyWindowStep);
  const maxChars = Math.max(500, opts?.maxChars ?? STRATEGY_LIMITS.strategyHistoryCharBudget);
  // offset＝這批訊息之前還有幾則（DB 只撈最新 N 則時）；格線以整房的絕對序號計算
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  if (!messages.length) return [];

  const total = offset + messages.length;
  let startAbs = total <= minKeep ? 0 : Math.floor((total - minKeep) / step) * step;
  if (startAbs < offset) startAbs = Math.ceil(offset / step) * step;
  const counted = (m: T) => (isHistoryExcluded(m.structured) ? 0 : m.content?.length ?? 0);
  const charsFrom = (abs: number) => messages.slice(abs - offset).reduce((n, m) => n + counted(m), 0);
  while (startAbs + step < total && charsFrom(startAbs) > maxChars) startAbs += step;

  const localStart = Math.min(Math.max(0, startAbs - offset), Math.max(0, messages.length - 2));
  let slice = messages
    .slice(localStart)
    .filter((m) => (m.role === "user" || m.role === "assistant") && !isHistoryExcluded(m.structured));
  while (slice.length > 1 && slice[0]!.role !== "user") slice = slice.slice(1);
  if (!slice.length) return [];

  let lastAssistant = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const lastIdx = slice.length - 1;
  return slice.map((m, i) => {
    if (i === lastIdx || i === lastAssistant) return m;
    // 使用者原文保留。只壓縮較舊的主持人回覆。
    if (m.role !== "assistant") return m;
    const max = opts?.olderAssistantMaxChars ?? STRATEGY_LIMITS.historyOlderAssistantMaxChars;
    const content = headTail(m.content ?? "", max);
    return content === m.content ? m : { ...m, content };
  });
}

export type InjectableReport = {
  id: string;
  requestId: string;
  title: string;
  content: string;
  chars: number;
  createdAt: number;
};

/** `xxx_p2`、`xxx-p3` 視為同一系列 */
export function reportSeriesKey(title: string): string {
  return title.trim().replace(/[_\-\s]+p\d+$/i, "").toLowerCase() || title.trim().toLowerCase();
}

function oneLine(content: string, max = 60): string {
  const line = content.replace(/\s+/g, " ").trim();
  if (!line) return "（空）";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * 報告注入：放「上一回合之後新上傳」、目前工作包開始後上傳（驗收前）與主持人指名（reportFocus）的報告正文，
 * 同系列分段合併；其餘只進索引。
 */
export function buildReportInjection(
  reports: InjectableReport[],
  opts: { lastHostTurnAt: number; focusIds: string[]; packageSince?: number },
): { bodies: string; index: string; injectedIds: string[] } {
  const L = STRATEGY_LIMITS;
  const focus = new Set(opts.focusIds.slice(0, L.reportFocusMax));
  const since = opts.packageSince ?? 0;
  const picked = reports.filter(
    (r) => r.createdAt > opts.lastHostTurnAt || (since > 0 && r.createdAt >= since) || focus.has(r.id),
  );
  const pickedIds = new Set(picked.map((r) => r.id));

  const groups = new Map<string, InjectableReport[]>();
  for (const r of picked) {
    const key = reportSeriesKey(r.title);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const ordered = [...groups.values()]
    .map((parts) => parts.sort((a, b) => a.createdAt - b.createdAt))
    .sort((a, b) => b[b.length - 1]!.createdAt - a[a.length - 1]!.createdAt);

  let bodies = "";
  const injectedIds: string[] = [];
  for (const parts of ordered) {
    const head = parts
      .map((r) => `${r.id}${r.requestId ? ` [${r.requestId}]` : ""}`)
      .join("、");
    const merged = parts.map((r) => r.content).join("\n");
    const body = merged.length > L.reportSeriesInjectMaxChars
      ? `${merged.slice(0, L.reportSeriesInjectMaxChars)}\n…[截斷]`
      : merged;
    const block = `\n### 報告 ${head}：${parts[0]!.title}${parts.length > 1 ? `（${parts.length} 段已合併）` : ""}\n${body}\n`;
    if (bodies.length + block.length > L.reportsInjectMaxChars) continue;
    bodies += block;
    injectedIds.push(...parts.map((r) => r.id));
  }

  const injectedSet = new Set(injectedIds);
  let index = "";
  for (const r of reports) {
    if (injectedSet.has(r.id)) continue;
    const skipped = pickedIds.has(r.id) ? "（超出注入上限）" : "";
    const line = `- ${r.id}：${r.title}（${r.chars} 字）${skipped} ${oneLine(r.content)}\n`;
    if (index.length + line.length > L.reportsIndexMaxChars) {
      index += "- …（更早的報告略）\n";
      break;
    }
    index += line;
  }
  return { bodies, index: index.trimEnd(), injectedIds };
}

export type StrategyDossier = {
  strategies: Record<string, string>;
  findings: string[];
  decisions: string[];
  fPlan: Record<string, unknown> | null;
};

let tablesReady: Promise<void> | null = null;
/** 生產庫多半已建表；probe 成功即可服務側欄，DDL 背景補齊 */
let schemaMigrated = false;

function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = prepareTables().catch((e) => {
      tablesReady = null;
      throw e;
    });
  }
  return tablesReady;
}

async function prepareTables(): Promise<void> {
  // 熱路徑：一查就知道表在，側欄不必等 40+ 句 DDL
  try {
    await db().prepare(`SELECT 1 AS ok FROM strategy_workspaces LIMIT 1`).get();
    // 側欄軟刪依賴此欄：probe 成功也同步補上，避免背景 migrate 尚未完成就 WHERE 爆掉
    await db().exec(`ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
    if (!schemaMigrated) {
      schemaMigrated = true;
      void createTables().catch((e) => {
        schemaMigrated = false;
        console.warn("[strategy] background schema migrate failed", e);
      });
    }
    return;
  } catch {
    // 表不存在或連線失敗 → 同步建表
  }
  await createTables();
  schemaMigrated = true;
}

async function execAll(stmts: string[]): Promise<void> {
  await Promise.all(stmts.map((sql) => db().exec(sql)));
}

async function createTables(): Promise<void> {
  // 分階段平行：先建表 → 再 ALTER／INDEX（IF NOT EXISTS，可重入）
  await execAll([
    `CREATE TABLE IF NOT EXISTS strategy_loop_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL DEFAULT '',
      strategy_version TEXT NOT NULL DEFAULT '',
      git_commit TEXT NOT NULL DEFAULT '',
      summary_json TEXT NOT NULL DEFAULT '{}',
      review_excerpt TEXT NOT NULL DEFAULT '',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      session_id TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_loop_plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_code',
      hypotheses_json TEXT NOT NULL DEFAULT '[]',
      change_requests_json TEXT NOT NULL DEFAULT '[]',
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      raw_analysis TEXT NOT NULL DEFAULT '',
      round_index INT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_loop_code_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      files_changed_json TEXT NOT NULL DEFAULT '[]',
      checks_ok INT NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_loop_retros (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      window_hours INT NOT NULL DEFAULT 12,
      summary_json TEXT NOT NULL DEFAULT '{}',
      next_hypotheses_json TEXT NOT NULL DEFAULT '[]',
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      profile_id TEXT NOT NULL DEFAULT '',
      strategy_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'collecting',
      model TEXT NOT NULL DEFAULT '',
      pending_instructions_json TEXT NOT NULL DEFAULT '[]',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      structured_json TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_session_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'analysis',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      chars INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      template_id TEXT NOT NULL DEFAULT 'automax',
      memory_json TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_dispatch_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      instruction_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      dispatched_at BIGINT,
      done_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS strategy_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      stages_json TEXT NOT NULL DEFAULT '[]',
      quick_prompts_json TEXT NOT NULL DEFAULT '[]',
      recommended_models_json TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT NOT NULL DEFAULT '',
      stream_lead_preface TEXT NOT NULL DEFAULT '',
      enabled INT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 100,
      is_builtin INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
  ]);

  await execAll([
    `ALTER TABLE strategy_loop_runs ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS topic TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS summary_updated_at BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS auto_dispatch INT NOT NULL DEFAULT 1`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS pause_state TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS models_json TEXT`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS template_id TEXT`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS deleted_at BIGINT`,
    `ALTER TABLE strategy_session_messages ADD COLUMN IF NOT EXISTS speaker_model TEXT`,
    `ALTER TABLE strategy_session_messages ADD COLUMN IF NOT EXISTS speaker_role TEXT`,
    `ALTER TABLE strategy_session_messages ADD COLUMN IF NOT EXISTS speaker_label TEXT`,
    `ALTER TABLE strategy_session_messages ADD COLUMN IF NOT EXISTS turn_id TEXT`,
    `ALTER TABLE strategy_session_messages ADD COLUMN IF NOT EXISTS completion_status TEXT`,
  ]);

  await execAll([
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_runs_user
      ON strategy_loop_runs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_plans_user_status
      ON strategy_loop_plans(user_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_code_results_plan
      ON strategy_loop_code_results(plan_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_retros_user
      ON strategy_loop_retros(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_sessions_user
      ON strategy_sessions(user_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_session_messages_sess
      ON strategy_session_messages(session_id, created_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_session_reports_sess
      ON strategy_session_reports(session_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_runs_session
      ON strategy_loop_runs(session_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_workspaces_user
      ON strategy_workspaces(user_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_session_messages_turn
      ON strategy_session_messages(session_id, turn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_sessions_workspace
      ON strategy_sessions(workspace_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_sessions_user_active
      ON strategy_sessions(user_id, updated_at DESC)
      WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_dispatch_session
      ON strategy_dispatch_items(session_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_dispatch_user_status
      ON strategy_dispatch_items(user_id, status, created_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_templates_enabled
      ON strategy_templates(enabled, sort_order ASC, id ASC)`,
  ]);

  await seedBuiltinStrategyTemplates();
}

async function seedBuiltinStrategyTemplates(): Promise<void> {
  // 多數實例已有內建範本：先探針，避免每次冷啟連插 N 筆
  try {
    const hit = await db()
      .prepare(`SELECT 1 AS ok FROM strategy_templates WHERE is_builtin = 1 LIMIT 1`)
      .get();
    if (hit) return;
  } catch {
    /* 表剛建好也可能尚無列 → 繼續 seed */
  }
  const ts = nowMs();
  await Promise.all(
    BUILTIN_STRATEGY_TEMPLATES.map((t) =>
      db()
        .prepare(
          `INSERT INTO strategy_templates (
            id, name, description, stages_json, quick_prompts_json, recommended_models_json,
            system_prompt, stream_lead_preface, enabled, sort_order, is_builtin, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
          ON CONFLICT (id) DO NOTHING`,
        )
        .run(
          t.id,
          t.name,
          t.description,
          JSON.stringify(t.stages),
          JSON.stringify(t.quickPrompts),
          JSON.stringify(t.recommendedModels),
          t.systemPrompt,
          t.streamLeadPreface,
          t.sortOrder ?? 100,
          ts,
          ts,
        ),
    ),
  );
}

function nowMs(): number {
  return Date.now();
}

/** 單調遞增 updated_at，避免同毫秒雙寫導致 /sync 漏訊。 */
export async function touchSessionUpdatedAt(userId: string, sessionId: string): Promise<void> {
  await ensureTables();
  const ts = nowMs();
  await db()
    .prepare(
      `UPDATE strategy_sessions
       SET updated_at = GREATEST(updated_at + 1, ?)
       WHERE id = ? AND user_id = ?`,
    )
    .run(ts, sessionId, userId);
}

export async function createStrategyRun(input: {
  userId: string;
  profileId?: string;
  strategyVersion?: string;
  gitCommit?: string;
  summary?: Record<string, unknown>;
  reviewExcerpt?: string;
  metrics?: Record<string, unknown>;
  sessionId?: string;
}): Promise<{ id: string; createdAt: number }> {
  await ensureTables();
  const id = `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const createdAt = nowMs();
  await db()
    .prepare(
      `INSERT INTO strategy_loop_runs
        (id, user_id, profile_id, strategy_version, git_commit, summary_json, review_excerpt, metrics_json, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.profileId ?? "",
      input.strategyVersion ?? "",
      input.gitCommit ?? "",
      JSON.stringify(input.summary ?? {}),
      input.reviewExcerpt ?? "",
      JSON.stringify(input.metrics ?? {}),
      input.sessionId ?? "",
      createdAt,
    );
  return { id, createdAt };
}

export async function getStrategyRun(userId: string, runId: string) {
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT * FROM strategy_loop_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId)) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export async function listStrategyRuns(userId: string, limit = 20) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_loop_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 100))) as Record<string, unknown>[];
  return rows.map(mapRun);
}

function mapRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    profileId: String(row.profile_id ?? ""),
    strategyVersion: String(row.strategy_version ?? ""),
    gitCommit: String(row.git_commit ?? ""),
    summary: safeJson(row.summary_json, {}),
    reviewExcerpt: String(row.review_excerpt ?? ""),
    metrics: safeJson(row.metrics_json, {}),
    sessionId: String(row.session_id ?? ""),
    createdAt: Number(row.created_at),
  };
}

export async function createStrategyPlan(input: {
  userId: string;
  runId: string;
  hypotheses?: unknown[];
  changeRequests?: unknown[];
  acceptance?: unknown[];
  rawAnalysis?: string;
  roundIndex?: number;
  status?: StrategyPlanStatus;
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `plan_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = nowMs();
  await db()
    .prepare(
      `INSERT INTO strategy_loop_plans
        (id, user_id, run_id, status, hypotheses_json, change_requests_json, acceptance_json, raw_analysis, round_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.runId,
      input.status ?? "pending_code",
      JSON.stringify(input.hypotheses ?? []),
      JSON.stringify(input.changeRequests ?? []),
      JSON.stringify(input.acceptance ?? []),
      input.rawAnalysis ?? "",
      input.roundIndex ?? 1,
      ts,
      ts,
    );
  return { id };
}

export async function listStrategyPlans(
  userId: string,
  opts?: { status?: StrategyPlanStatus; limit?: number },
) {
  await ensureTables();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  if (opts?.status) {
    const rows = (await db()
      .prepare(
        `SELECT * FROM strategy_loop_plans WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, opts.status, limit)) as Record<string, unknown>[];
    return rows.map(mapPlan);
  }
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_loop_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit)) as Record<string, unknown>[];
  return rows.map(mapPlan);
}

export async function getStrategyPlan(userId: string, planId: string) {
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT * FROM strategy_loop_plans WHERE id = ? AND user_id = ?`)
    .get(planId, userId)) as Record<string, unknown> | undefined;
  return row ? mapPlan(row) : null;
}

export async function updateStrategyPlanStatus(
  userId: string,
  planId: string,
  status: StrategyPlanStatus,
): Promise<boolean> {
  await ensureTables();
  const r = await db()
    .prepare(
      `UPDATE strategy_loop_plans SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .run(status, nowMs(), planId, userId);
  return (r.changes ?? 0) > 0;
}

function mapPlan(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    runId: String(row.run_id),
    status: String(row.status) as StrategyPlanStatus,
    hypotheses: safeJson(row.hypotheses_json, [] as unknown[]),
    changeRequests: safeJson(row.change_requests_json, [] as unknown[]),
    acceptance: safeJson(row.acceptance_json, [] as unknown[]),
    rawAnalysis: String(row.raw_analysis ?? ""),
    roundIndex: Number(row.round_index ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function createCodeResult(input: {
  userId: string;
  planId: string;
  summary?: string;
  filesChanged?: string[];
  checksOk?: boolean;
  notes?: string;
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `code_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db()
    .prepare(
      `INSERT INTO strategy_loop_code_results
        (id, user_id, plan_id, summary, files_changed_json, checks_ok, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.planId,
      input.summary ?? "",
      JSON.stringify(input.filesChanged ?? []),
      input.checksOk ? 1 : 0,
      input.notes ?? "",
      nowMs(),
    );
  await updateStrategyPlanStatus(input.userId, input.planId, "needs_review");
  return { id };
}

export async function createRetro(input: {
  userId: string;
  windowHours?: number;
  summary?: Record<string, unknown>;
  nextHypotheses?: unknown[];
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `retro_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db()
    .prepare(
      `INSERT INTO strategy_loop_retros
        (id, user_id, window_hours, summary_json, next_hypotheses_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.windowHours ?? 12,
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(input.nextHypotheses ?? []),
      nowMs(),
    );
  return { id };
}

export async function listRetros(userId: string, limit = 10) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_loop_retros WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 50))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    windowHours: Number(row.window_hours ?? 12),
    summary: safeJson(row.summary_json, {}),
    nextHypotheses: safeJson(row.next_hypotheses_json, [] as unknown[]),
    createdAt: Number(row.created_at),
  }));
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type SessionMemberRole = "lead" | "critic" | "engineer" | "custom";

export type SessionMember = {
  modelId: string;
  role: SessionMemberRole;
  label: string;
};

const MEMBER_ROLES: SessionMemberRole[] = ["lead", "critic", "engineer", "custom"];

export function parseSessionModels(raw: unknown): SessionMember[] | null {
  if (raw == null || raw === "") return null;
  const arr = typeof raw === "string" ? safeJson(raw, null as unknown) : raw;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const modelId = String(o.modelId ?? "").trim();
      const role = String(o.role ?? "custom") as SessionMemberRole;
      if (!modelId || !MEMBER_ROLES.includes(role)) return null;
      const label = clip(String(o.label ?? role).trim() || role, 80);
      return { modelId, role, label } satisfies SessionMember;
    })
    .filter((m): m is SessionMember => !!m);
}

/** 驗證 1–4 位成員、剛好 1 位 lead、modelId 存在於目錄 */
export function validateSessionModels(input: unknown): { ok: true; models: SessionMember[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "models must be an array" };
  if (input.length < 1 || input.length > 4) return { ok: false, error: "models must have 1..4 members" };
  const models: SessionMember[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return { ok: false, error: "invalid member" };
    const o = item as Record<string, unknown>;
    const modelId = String(o.modelId ?? "").trim();
    const role = String(o.role ?? "") as SessionMemberRole;
    if (!MEMBER_ROLES.includes(role)) return { ok: false, error: `invalid role: ${role}` };
    if (!findModel(modelId)) return { ok: false, error: `unknown modelId: ${modelId}` };
    models.push({
      modelId,
      role,
      label: clip(String(o.label ?? role).trim() || role, 80),
    });
  }
  const leads = models.filter((m) => m.role === "lead");
  if (leads.length !== 1) return { ok: false, error: "models must contain exactly one lead" };
  return { ok: true, models };
}

export function resolveSessionMembers(session: {
  models: SessionMember[] | null;
  model: string;
}): SessionMember[] {
  if (session.models && session.models.length > 0) return session.models;
  const modelId = session.model?.trim() || "gemini-4-neon-high";
  return [{ modelId, role: "lead", label: "主導" }];
}

export async function createStrategySession(input: {
  userId: string;
  name: string;
  profileId?: string;
  strategyVersion?: string;
  model?: string;
  meta?: Record<string, unknown>;
  status?: StrategySessionStatus;
  workspaceId?: string;
  topic?: string;
  autoDispatch?: boolean;
  templateId?: string;
  models?: SessionMember[];
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = nowMs();
  const status =
    input.status && STRATEGY_SESSION_STATUSES.includes(input.status) ? input.status : "collecting";
  let workspaceId = input.workspaceId?.trim() || "";
  let wsTemplate = "automax";
  if (workspaceId) {
    const ws = await getStrategyWorkspace(input.userId, workspaceId);
    if (!ws) throw new Error("workspace not found");
    wsTemplate = ws.templateId || "automax";
  } else {
    const ws = await ensureDefaultWorkspace(input.userId);
    workspaceId = ws.id;
    wsTemplate = ws.templateId || "automax";
  }
  const templateId =
    input.templateId && (await templateIdExists(input.templateId)) ? input.templateId : wsTemplate;
  const modelsJson = input.models && input.models.length ? JSON.stringify(input.models) : null;
  await db()
    .prepare(
      `INSERT INTO strategy_sessions
        (id, user_id, name, profile_id, strategy_version, status, model, pending_instructions_json, meta_json,
         workspace_id, topic, auto_dispatch, template_id, models_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.name.trim() || "strategy-session",
      input.profileId ?? "",
      input.strategyVersion ?? "",
      status,
      input.model ?? (input.models?.find((m) => m.role === "lead")?.modelId || ""),
      JSON.stringify(input.meta ?? {}),
      workspaceId,
      clip((input.topic ?? "").trim(), 500),
      input.autoDispatch === false ? 0 : 1,
      templateId,
      modelsJson,
      ts,
      ts,
    );
  await touchWorkspace(input.userId, workspaceId);
  return { id };
}

export function readDossier(meta: Record<string, unknown>): StrategyDossier {
  const raw = (meta?.dossier ?? {}) as Partial<StrategyDossier>;
  return {
    strategies:
      raw.strategies && typeof raw.strategies === "object" ? { ...raw.strategies } : {},
    findings: Array.isArray(raw.findings) ? raw.findings.map(String) : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions.map(String) : [],
    fPlan: raw.fPlan && typeof raw.fPlan === "object" ? (raw.fPlan as Record<string, unknown>) : null,
  };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 合併模型回傳的 memoryUpdates；超過 dossierMaxChars 時先丟最舊的 findings／decisions。 */
export function mergeDossier(cur: StrategyDossier, updates: unknown): StrategyDossier {
  const next: StrategyDossier = {
    strategies: { ...cur.strategies },
    findings: [...cur.findings],
    decisions: [...cur.decisions],
    fPlan: cur.fPlan,
  };
  if (updates && typeof updates === "object") {
    const u = updates as Record<string, unknown>;
    if (u.strategies && typeof u.strategies === "object") {
      for (const [k, v] of Object.entries(u.strategies as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) next.strategies[k] = clip(v.trim(), 1200);
      }
    }
    for (const key of ["findings", "decisions"] as const) {
      const arr = u[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const s = clip(String(item ?? "").trim(), 400);
        if (s && !next[key].includes(s)) next[key].push(s);
      }
      next[key] = next[key].slice(-20);
    }
    if (u.fPlan && typeof u.fPlan === "object") {
      next.fPlan = u.fPlan as Record<string, unknown>;
    }
  }
  while (JSON.stringify(next).length > STRATEGY_LIMITS.dossierMaxChars) {
    if (next.findings.length > 3) next.findings.shift();
    else if (next.decisions.length > 3) next.decisions.shift();
    else break;
  }
  return next;
}

export async function addSessionReport(input: {
  sessionId: string;
  userId: string;
  title: string;
  content: string;
  kind?: string;
  requestId?: string;
}): Promise<{ id: string; chars: number }> {
  await ensureTables();
  const id = `srep_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const chars = input.content.length;
  await db()
    .prepare(
      `INSERT INTO strategy_session_reports
        (id, session_id, user_id, request_id, kind, title, content, chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.userId,
      input.requestId ?? "",
      input.kind ?? "analysis",
      input.title.trim() || "report",
      input.content,
      chars,
      nowMs(),
    );
  await touchSessionUpdatedAt(input.userId, input.sessionId);
  return { id, chars };
}

export async function listSessionReports(
  userId: string,
  sessionId: string,
  limit = 30,
  opts?: { includeContent?: boolean },
) {
  await ensureTables();
  const includeContent = opts?.includeContent !== false;
  const cols = includeContent
    ? `id, request_id, kind, title, content, chars, created_at`
    : `id, request_id, kind, title, chars, created_at`;
  const rows = (await db()
    .prepare(
      `SELECT ${cols} FROM strategy_session_reports
       WHERE session_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, userId, Math.min(Math.max(limit, 1), 100))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id ?? ""),
    kind: String(row.kind ?? ""),
    title: String(row.title ?? ""),
    content: includeContent ? String(row.content ?? "") : "",
    chars: Number(row.chars ?? 0),
    createdAt: Number(row.created_at),
  }));
}

export async function listStrategySessions(userId: string, limit = 20) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_sessions
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 50))) as Record<string, unknown>[];
  return rows.map(mapSession);
}

export async function getStrategySession(
  userId: string,
  sessionId: string,
  opts?: { omitMeta?: boolean },
) {
  await ensureTables();
  // 點開對話不讀 meta_json／待派送：那兩欄很大，會拖住訊息出現
  const sql = opts?.omitMeta
    ? `SELECT id, user_id, name, profile_id, strategy_version, status, model, models_json,
              template_id, workspace_id, topic, summary, summary_updated_at, auto_dispatch,
              pause_state, created_at, updated_at
       FROM strategy_sessions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    : `SELECT * FROM strategy_sessions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`;
  const row = (await db().prepare(sql).get(sessionId, userId)) as Record<string, unknown> | undefined;
  return row ? mapSession(row) : null;
}

/** 只取出 meta 裡的路線圖。跟訊息查詢分開，避免資訊讀取拖住對話更新 */
export async function readSessionLedgerRaw(
  userId: string,
  sessionId: string,
): Promise<{ found: boolean; ledger: unknown }> {
  await ensureTables();
  try {
    const row = (await db()
      .prepare(
        `SELECT (meta_json::jsonb -> 'ledger') AS ledger
         FROM strategy_sessions
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(sessionId, userId)) as { ledger?: unknown } | undefined;
    if (!row) return { found: false, ledger: null };
    let ledger: unknown = row.ledger ?? null;
    if (typeof ledger === "string") {
      try {
        ledger = JSON.parse(ledger) as unknown;
      } catch {
        ledger = null;
      }
    }
    return { found: true, ledger };
  } catch {
    return { found: false, ledger: null };
  }
}

/** 側欄刪除會議室（軟刪；列表不再顯示） */
export async function softDeleteStrategySession(userId: string, sessionId: string): Promise<boolean> {
  await ensureTables();
  const r = await db()
    .prepare(
      `UPDATE strategy_sessions
       SET deleted_at = ?, updated_at = GREATEST(updated_at + 1, ?)
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(nowMs(), nowMs(), sessionId, userId);
  return (r.changes ?? 0) > 0;
}

export async function updateStrategySession(
  userId: string,
  sessionId: string,
  patch: {
    status?: StrategySessionStatus;
    pendingInstructions?: unknown[];
    meta?: Record<string, unknown>;
    model?: string;
    name?: string;
    topic?: string;
    summary?: string;
    autoDispatch?: boolean;
    pauseState?: PauseState;
    models?: SessionMember[] | null;
    templateId?: string | null;
  },
): Promise<boolean> {
  await ensureTables();
  const cur = await getStrategySession(userId, sessionId);
  if (!cur) return false;
  const status = patch.status ?? cur.status;
  const pending = patch.pendingInstructions ?? cur.pendingInstructions;
  const meta = patch.meta ?? cur.meta;
  const models = patch.models !== undefined ? patch.models : cur.models;
  const leadModel = models?.find((m) => m.role === "lead")?.modelId;
  const model = patch.model ?? leadModel ?? cur.model;
  const name = patch.name?.trim() ? clip(patch.name.trim(), 120) : cur.name;
  const topic = patch.topic !== undefined ? clip(patch.topic.trim(), 500) : cur.topic;
  const summaryChanged = patch.summary !== undefined && patch.summary.trim() !== "";
  const summary = summaryChanged
    ? clip(patch.summary!.trim(), STRATEGY_LIMITS.summaryMaxChars)
    : cur.summary;
  const summaryAt = summaryChanged ? nowMs() : cur.summaryUpdatedAt;
  const autoDispatch = patch.autoDispatch ?? cur.autoDispatch;
  const pauseState = patch.pauseState !== undefined ? normalizePauseState(patch.pauseState) : cur.pauseState;
  let templateId = cur.templateId;
  if (patch.templateId !== undefined) {
    if (patch.templateId && (await templateIdExists(patch.templateId))) {
      templateId = patch.templateId;
    } else if (patch.templateId === "" || patch.templateId === null) {
      templateId = cur.templateId;
    }
  }
  const ts = nowMs();
  await db()
    .prepare(
      `UPDATE strategy_sessions
       SET status = ?, pending_instructions_json = ?, meta_json = ?, model = ?, name = ?, topic = ?,
           summary = ?, summary_updated_at = ?, auto_dispatch = ?, pause_state = ?,
           models_json = ?, template_id = ?,
           updated_at = GREATEST(updated_at + 1, ?)
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      status,
      JSON.stringify(pending),
      JSON.stringify(meta),
      model,
      name,
      topic,
      summary,
      summaryAt,
      autoDispatch ? 1 : 0,
      pauseState,
      models && models.length ? JSON.stringify(models) : null,
      templateId,
      ts,
      sessionId,
      userId,
    );
  if (cur.workspaceId) await touchWorkspace(userId, cur.workspaceId);
  return true;
}

function mapSession(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name ?? ""),
    profileId: String(row.profile_id ?? ""),
    strategyVersion: String(row.strategy_version ?? ""),
    status: String(row.status) as StrategySessionStatus,
    model: String(row.model ?? ""),
    models: parseSessionModels(row.models_json),
    templateId: row.template_id == null || row.template_id === "" ? null : String(row.template_id),
    pendingInstructions: safeJson(row.pending_instructions_json, [] as unknown[]),
    meta: safeJson(row.meta_json, {} as Record<string, unknown>),
    workspaceId: String(row.workspace_id ?? ""),
    topic: String(row.topic ?? ""),
    summary: String(row.summary ?? ""),
    summaryUpdatedAt: Number(row.summary_updated_at ?? 0),
    autoDispatch: Number(row.auto_dispatch ?? 1) !== 0,
    pauseState: normalizePauseState(row.pause_state),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export type StrategySession = ReturnType<typeof mapSession>;

// ─── 主體（workspace）────────────────────────────────────────────

export type StrategyWorkspaceMemory = { notes: string };

function mapWorkspace(row: Record<string, unknown>) {
  const mem = safeJson(row.memory_json, {} as Record<string, unknown>);
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    templateId: String(row.template_id ?? "automax"),
    memory: { notes: typeof mem.notes === "string" ? mem.notes : "" } as StrategyWorkspaceMemory,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

export type StrategyWorkspace = ReturnType<typeof mapWorkspace>;

export async function createStrategyWorkspace(input: {
  userId: string;
  name: string;
  templateId?: string;
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `ws_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = nowMs();
  await db()
    .prepare(
      `INSERT INTO strategy_workspaces (id, user_id, name, template_id, memory_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(id, input.userId, clip(input.name.trim() || "未命名主體", 120), input.templateId?.trim() || "automax", ts, ts);
  return { id };
}

export async function getStrategyWorkspace(userId: string, workspaceId: string, includeDeleted = false) {
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT * FROM strategy_workspaces WHERE id = ? AND user_id = ?`)
    .get(workspaceId, userId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const ws = mapWorkspace(row);
  if (ws.deletedAt != null && !includeDeleted) return null;
  return ws;
}

/** 取得（或建立）使用者的預設主體，並把尚未歸屬的舊會議室掛進去。 */
export async function ensureDefaultWorkspace(userId: string): Promise<StrategyWorkspace> {
  await ensureTables();
  const existing = (await db()
    .prepare(
      `SELECT id, user_id, name, template_id, memory_json, created_at, updated_at, deleted_at
       FROM strategy_workspaces WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(userId)) as Record<string, unknown> | undefined;
  let ws: StrategyWorkspace;
  if (existing) {
    ws = mapWorkspace(existing);
  } else {
    const { id } = await createStrategyWorkspace({ userId, name: "automax 交易策略" });
    ws = (await getStrategyWorkspace(userId, id))!;
  }
  // 只在真有孤兒房時才 UPDATE，避免每次側欄列表掃全表
  const orphan = await db()
    .prepare(
      `SELECT 1 AS ok FROM strategy_sessions
       WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = '')
       LIMIT 1`,
    )
    .get(userId);
  if (orphan) {
    await db()
      .prepare(`UPDATE strategy_sessions SET workspace_id = ? WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = '')`)
      .run(ws.id, userId);
  }
  return ws;
}

export async function listStrategyWorkspaces(userId: string, opts: { trash?: boolean } = {}) {
  await ensureTables();
  if (!opts.trash) await ensureDefaultWorkspace(userId);
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_workspaces WHERE user_id = ? AND deleted_at IS ${opts.trash ? "NOT NULL" : "NULL"}
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(userId)) as Record<string, unknown>[];
  return rows.map(mapWorkspace);
}

async function fetchWorkspacesBrief(userId: string, trash: boolean) {
  const rows = (await db()
    .prepare(
      `SELECT id, name, template_id, memory_json, created_at, updated_at, deleted_at
       FROM strategy_workspaces
       WHERE user_id = ? AND deleted_at IS ${trash ? "NOT NULL" : "NULL"}
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(userId)) as Record<string, unknown>[];
  return rows.map(mapWorkspace);
}

/** 側欄用：不撈完整 memory／summary 大欄；已有主體時不擋 ensureDefault */
export async function listStrategyWorkspacesBrief(userId: string, opts: { trash?: boolean } = {}) {
  await ensureTables();
  const trash = Boolean(opts.trash);
  let rows = await fetchWorkspacesBrief(userId, trash);
  if (!trash && rows.length === 0) {
    await ensureDefaultWorkspace(userId);
    rows = await fetchWorkspacesBrief(userId, trash);
  }
  return rows;
}

const SESSION_BRIEF_COLS = `id, user_id, name, profile_id, strategy_version, status, model, models_json, template_id,
              workspace_id, topic, auto_dispatch, pause_state, created_at, updated_at,
              '' AS summary, 0 AS summary_updated_at,
              '[]' AS pending_instructions_json, '{}' AS meta_json`;

/** 側欄房間清單：不含 summary／meta／pending 大欄 */
export async function listWorkspaceSessionsBrief(userId: string, workspaceId: string) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT ${SESSION_BRIEF_COLS}
       FROM strategy_sessions
       WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(userId, workspaceId)) as Record<string, unknown>[];
  return rows.map(mapSession);
}

/** 側欄一次撈多主體房間，避免 1+N */
export async function listWorkspaceSessionsBriefMany(userId: string, workspaceIds: string[]) {
  await ensureTables();
  const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  const byWs = new Map<string, ReturnType<typeof mapSession>[]>();
  for (const id of ids) byWs.set(id, []);
  if (!ids.length) return byWs;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await db()
    .prepare(
      `SELECT ${SESSION_BRIEF_COLS}
       FROM strategy_sessions
       WHERE user_id = ? AND workspace_id IN (${placeholders}) AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all(userId, ...ids)) as Record<string, unknown>[];
  for (const row of rows) {
    const wsId = String(row.workspace_id ?? "");
    const list = byWs.get(wsId);
    if (!list || list.length >= 50) continue;
    list.push(mapSession(row));
  }
  return byWs;
}

export async function updateStrategyWorkspace(
  userId: string,
  workspaceId: string,
  patch: { name?: string; memoryNotes?: string; restore?: boolean },
): Promise<boolean> {
  await ensureTables();
  const cur = await getStrategyWorkspace(userId, workspaceId, true);
  if (!cur) return false;
  const name = patch.name?.trim() ? clip(patch.name.trim(), 120) : cur.name;
  const notes =
    patch.memoryNotes !== undefined
      ? clip(patch.memoryNotes, STRATEGY_LIMITS.workspaceMemoryMaxChars)
      : cur.memory.notes;
  const deletedAt = patch.restore ? null : cur.deletedAt;
  await db()
    .prepare(
      `UPDATE strategy_workspaces SET name = ?, memory_json = ?, deleted_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(name, JSON.stringify({ notes }), deletedAt, nowMs(), workspaceId, userId);
  return true;
}

export async function softDeleteStrategyWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  await ensureTables();
  const r = await db()
    .prepare(
      `UPDATE strategy_workspaces SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(nowMs(), workspaceId, userId);
  return (r.changes ?? 0) > 0;
}

async function touchWorkspace(userId: string, workspaceId: string): Promise<void> {
  await db()
    .prepare(`UPDATE strategy_workspaces SET updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(nowMs(), workspaceId, userId);
}

export async function listWorkspaceSessions(userId: string, workspaceId: string) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_sessions
       WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 50`,
    )
    .all(userId, workspaceId)) as Record<string, unknown>[];
  return rows.map(mapSession);
}

/**
 * 主體共用記憶＋各會議室摘要，供會議室與一般對話注入。
 * excludeSessionId：會議室自己的摘要不必重複注入。
 */
export async function buildWorkspaceBrief(
  userId: string,
  workspaceId: string,
  opts: { excludeSessionId?: string; maxChars?: number } = {},
): Promise<{ text: string; workspace: StrategyWorkspace | null }> {
  const ws = await getStrategyWorkspace(userId, workspaceId);
  if (!ws) return { text: "", workspace: null };
  const rooms = (await listWorkspaceSessions(userId, workspaceId)).filter(
    (s) => s.id !== opts.excludeSessionId,
  );
  const parts: string[] = [`# 主體「${ws.name}」（${ws.id}）`];
  if (ws.memory.notes.trim()) parts.push(`## 主體共用記憶\n${ws.memory.notes.trim()}`);
  const roomLines = rooms.map((s) => {
    const head = `### ${s.name}（${s.id}）｜${s.status}${s.topic ? `｜主題：${s.topic}` : ""}`;
    const body = s.summary.trim() ? clip(s.summary.trim(), STRATEGY_LIMITS.summaryMaxChars) : "（尚無摘要）";
    return `\n${head}\n${body}\n`;
  });
  if (roomLines.length) {
    parts.push(`## ${opts.excludeSessionId ? "其他" : "各"}會議室摘要${budgetJoin(roomLines, opts.maxChars ?? STRATEGY_LIMITS.workspaceBriefMaxChars)}`);
  }
  return { text: parts.join("\n\n"), workspace: ws };
}

function budgetJoin(parts: string[], max: number): string {
  let out = "";
  for (const p of parts) {
    if (out.length + p.length > max) break;
    out += p;
  }
  return out;
}

// ─── 跨會議室查詢 ────────────────────────────────────────────────

function queryTerms(question: string): string[] {
  const terms = new Set<string>();
  const lower = question.toLowerCase();
  for (const w of lower.match(/[a-z0-9_.%]{2,}/g) ?? []) terms.add(w);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/** 依關鍵字重疊挑出最相關的段落，總長不超過 maxChars；保持原本順序。 */
export function pickRelevantSnippets(chunks: string[], question: string, maxChars: number): string {
  const terms = queryTerms(question);
  if (!terms.length) return "";
  const scored = chunks
    .map((text, idx) => {
      const lower = text.toLowerCase();
      let score = 0;
      for (const t of terms) if (lower.includes(t)) score += t.length >= 3 ? 2 : 1;
      return { text, idx, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.idx - a.idx);
  const picked: { text: string; idx: number }[] = [];
  let used = 0;
  for (const c of scored) {
    const piece = c.text.length > maxChars ? `${c.text.slice(0, maxChars - 1)}…` : c.text;
    if (used + piece.length + 2 > maxChars) continue;
    picked.push({ text: piece, idx: c.idx });
    used += piece.length + 2;
  }
  return picked
    .sort((a, b) => a.idx - b.idx)
    .map((p) => p.text)
    .join("\n…\n");
}

function splitChunks(text: string, size = 600): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
  }
  return out;
}

/** 在同主體的另一間會議室裡找與問題相關的片段（dossier、報告、對話）。 */
export async function queryRoomContent(
  userId: string,
  fromSession: { id: string; workspaceId: string },
  roomId: string,
  question: string,
): Promise<{ roomId: string; roomName: string; question: string; snippet: string } | null> {
  const room = await getStrategySession(userId, roomId);
  if (!room || room.id === fromSession.id || room.workspaceId !== fromSession.workspaceId) return null;
  const dossier = readDossier(room.meta);
  const chunks: string[] = [];
  if (room.summary) chunks.push(`[摘要] ${room.summary}`);
  for (const [k, v] of Object.entries(dossier.strategies)) chunks.push(`[策略 ${k}] ${v}`);
  for (const d of dossier.decisions) chunks.push(`[決策] ${d}`);
  for (const f of dossier.findings) chunks.push(`[發現] ${f}`);
  if (dossier.fPlan) chunks.push(`[定案方案] ${JSON.stringify(dossier.fPlan)}`);
  for (const r of await listSessionReports(userId, roomId, 20)) {
    for (const c of splitChunks(r.content)) chunks.push(`[報告 ${r.title}] ${c}`);
  }
  for (const m of await listSessionMessages(userId, roomId, 100)) {
    for (const c of splitChunks(m.content)) chunks.push(`[${m.role === "assistant" ? "主持人" : "發言"}] ${c}`);
  }
  const snippet = pickRelevantSnippets(chunks, question, STRATEGY_LIMITS.roomQueryMaxChars);
  return { roomId: room.id, roomName: room.name, question: clip(question, 300), snippet: snippet || "（查無相關內容）" };
}

// ─── 待派送清單 ──────────────────────────────────────────────────

export type DispatchStatus = "pending" | "dispatched" | "done" | "rejected";

function mapDispatch(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    instruction: safeJson(row.instruction_json, {} as unknown),
    status: String(row.status) as DispatchStatus,
    note: String(row.note ?? ""),
    createdAt: Number(row.created_at),
    dispatchedAt: row.dispatched_at == null ? null : Number(row.dispatched_at),
    doneAt: row.done_at == null ? null : Number(row.done_at),
  };
}

export type DispatchItem = ReturnType<typeof mapDispatch>;

export async function addDispatchItems(input: {
  userId: string;
  sessionId: string;
  items: unknown[];
  dispatched: boolean;
}): Promise<string[]> {
  await ensureTables();
  const ts = nowMs();
  const ids: string[] = [];
  for (const item of input.items) {
    const id = `dsp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db()
      .prepare(
        `INSERT INTO strategy_dispatch_items (id, session_id, user_id, instruction_json, status, created_at, dispatched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.userId,
        JSON.stringify(item ?? null),
        input.dispatched ? "dispatched" : "pending",
        ts,
        input.dispatched ? ts : null,
      );
    ids.push(id);
  }
  return ids;
}

export async function listSessionDispatch(userId: string, sessionId: string, limit = 50) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_dispatch_items WHERE user_id = ? AND session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, sessionId, Math.min(Math.max(limit, 1), 200))) as Record<string, unknown>[];
  return rows.map(mapDispatch);
}

export async function listDispatchByStatus(
  userId: string,
  status: DispatchStatus,
  opts: { sessionId?: string; workspaceId?: string; limit?: number } = {},
) {
  await ensureTables();
  const where = ["d.user_id = ?", "d.status = ?"];
  const params: unknown[] = [userId, status];
  if (opts.sessionId) {
    where.push("d.session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.workspaceId) {
    where.push("s.workspace_id = ?");
    params.push(opts.workspaceId);
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = (await db()
    .prepare(
      `SELECT d.*, s.name AS session_name, s.workspace_id AS session_workspace_id
       FROM strategy_dispatch_items d JOIN strategy_sessions s ON s.id = d.session_id
       WHERE ${where.join(" AND ")}
       ORDER BY d.created_at ASC LIMIT ?`,
    )
    .all(...params)) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...mapDispatch(row),
    sessionName: String(row.session_name ?? ""),
    workspaceId: String(row.session_workspace_id ?? ""),
  }));
}

/** 使用者在網頁勾選後派送或駁回；派送的指令同時併入會議室的 pendingInstructions。 */
export async function decideDispatchItems(
  userId: string,
  sessionId: string,
  ids: string[],
  action: "dispatch" | "reject",
): Promise<number> {
  await ensureTables();
  const pending = (await listSessionDispatch(userId, sessionId, 200)).filter(
    (d) => d.status === "pending" && ids.includes(d.id),
  );
  if (!pending.length) return 0;
  const ts = nowMs();
  for (const d of pending) {
    await db()
      .prepare(
        `UPDATE strategy_dispatch_items SET status = ?, dispatched_at = ? WHERE id = ? AND user_id = ?`,
      )
      .run(action === "dispatch" ? "dispatched" : "rejected", action === "dispatch" ? ts : null, d.id, userId);
  }
  if (action === "dispatch") {
    const sess = await getStrategySession(userId, sessionId);
    if (sess) {
      await updateStrategySession(userId, sessionId, {
        pendingInstructions: [...sess.pendingInstructions, ...pending.map((d) => d.instruction)],
      });
    } else {
      await touchSessionUpdatedAt(userId, sessionId);
    }
  } else {
    await touchSessionUpdatedAt(userId, sessionId);
  }
  return pending.length;
}

export async function countDispatchedItems(userId: string, sessionId: string): Promise<number> {
  await ensureTables();
  const row = await db()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM strategy_dispatch_items
       WHERE user_id = ? AND session_id = ? AND status = 'dispatched'`,
    )
    .get(userId, sessionId);
  return Number(row?.n ?? 0);
}

export async function closeAllDispatched(
  userId: string,
  sessionId: string,
  note = "forced pause close",
): Promise<number> {
  await ensureTables();
  const ts = nowMs();
  const tag = clip(note.trim() || "forced pause close", 500);
  const r = await db()
    .prepare(
      `UPDATE strategy_dispatch_items
       SET status = 'done',
           done_at = ?,
           note = CASE
             WHEN COALESCE(note, '') = '' THEN ?
             ELSE LEFT(note || ' | ' || ?, 2000)
           END
       WHERE user_id = ? AND session_id = ? AND status = 'dispatched'`,
    )
    .run(ts, tag, tag, userId, sessionId);
  return r.changes ?? 0;
}

export async function applySessionPauseAction(
  userId: string,
  sessionId: string,
  action: PauseAction,
): Promise<{
  session: StrategySession | null;
  closedCount: number;
  remainingDispatched: number;
} | null> {
  await ensureTables();
  const cur = await getStrategySession(userId, sessionId);
  if (!cur) return null;

  let closedCount = 0;
  let nextPause: PauseState = cur.pauseState;

  if (action === "graceful_pause") {
    const n = await countDispatchedItems(userId, sessionId);
    nextPause = n > 0 ? "pausing" : "paused";
    await updateStrategySession(userId, sessionId, { pauseState: nextPause });
  } else if (action === "force_pause") {
    closedCount = await closeAllDispatched(userId, sessionId, "forced pause close");
    nextPause = "paused";
    await updateStrategySession(userId, sessionId, {
      pauseState: "paused",
      pendingInstructions: [],
    });
  } else {
    nextPause = "none";
    await updateStrategySession(userId, sessionId, { pauseState: "none" });
  }

  const remainingDispatched = await countDispatchedItems(userId, sessionId);
  const session = await getStrategySession(userId, sessionId);
  return { session, closedCount, remainingDispatched };
}

export async function markDispatchDone(
  userId: string,
  dispatchId: string,
  note: string,
): Promise<{ ok: boolean; sessionId?: string; pauseState?: PauseState }> {
  await ensureTables();
  const existing = await db()
    .prepare(
      `SELECT session_id FROM strategy_dispatch_items
       WHERE id = ? AND user_id = ? AND status = 'dispatched'`,
    )
    .get(dispatchId, userId);
  if (!existing) return { ok: false };

  const sessionId = String(existing.session_id);
  const r = await db()
    .prepare(
      `UPDATE strategy_dispatch_items SET status = 'done', done_at = ?, note = ?
       WHERE id = ? AND user_id = ? AND status = 'dispatched'`,
    )
    .run(nowMs(), clip(note.trim(), 2000), dispatchId, userId);
  if ((r.changes ?? 0) <= 0) return { ok: false };

  const sess = await getStrategySession(userId, sessionId);
  const remaining = await countDispatchedItems(userId, sessionId);
  if (sess?.pauseState === "pausing" && remaining === 0) {
    await updateStrategySession(userId, sessionId, { pauseState: "paused" });
  } else {
    await touchSessionUpdatedAt(userId, sessionId);
  }
  const updated = await getStrategySession(userId, sessionId);
  return { ok: true, sessionId, pauseState: updated?.pauseState ?? "none" };
}

/** 主持人回合鎖閒置逾時：沒有心跳就失效。活著的回合會持續刷新，中斷的約一分鐘可再送 */
export const TURN_LOCK_TTL_MS = 70_000;

/** 整段主持串流的軟截止。沒有新事件時也要檢查，不能等下一個 token */
export const LEAD_STREAM_SOFT_DEADLINE_MS = 270_000;

/** 可見文字已經結束後，上游再沉默這麼久就收尾放鎖 */
export const LEAD_STREAM_STALL_AFTER_VISIBLE_MS = 12_000;

export type LeadStreamWatchdog = "continue" | "deadline" | "idle";

/** 串流停住時決定要不要自己收尾。可見文字已結束卻不再來事件，就不要繼續佔著回合鎖 */
export function leadStreamWatchdog(opts: {
  now: number;
  startedAt: number;
  lastEventAt: number;
  inputReleased: boolean;
  softDeadlineMs?: number;
  stallAfterVisibleMs?: number;
}): LeadStreamWatchdog {
  const soft = opts.softDeadlineMs ?? LEAD_STREAM_SOFT_DEADLINE_MS;
  const stall = opts.stallAfterVisibleMs ?? LEAD_STREAM_STALL_AFTER_VISIBLE_MS;
  if (opts.now - opts.startedAt > soft) return "deadline";
  if (opts.inputReleased && opts.now - opts.lastEventAt >= stall) return "idle";
  return "continue";
}

let turnLockColumnsReady: Promise<void> | null = null;

/** 既有正式庫走背景遷移，鎖欄位可能還沒建；第一次用到時同步補上 */
function ensureTurnLockColumns(): Promise<void> {
  if (!turnLockColumnsReady) {
    turnLockColumnsReady = (async () => {
      await ensureTables();
      await db().exec(`ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS turn_lock TEXT`);
      await db().exec(`ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS turn_lock_at BIGINT`);
    })().catch((e) => {
      turnLockColumnsReady = null;
      throw e;
    });
  }
  return turnLockColumnsReady;
}

/** 同一房間一次只跑一個主持人回合；拿到回傳 true */
export async function acquireTurnLock(
  userId: string,
  sessionId: string,
  token: string,
  now = nowMs(),
): Promise<boolean> {
  await ensureTurnLockColumns();
  const r = await db()
    .prepare(
      `UPDATE strategy_sessions SET turn_lock = ?, turn_lock_at = ?
       WHERE id = ? AND user_id = ? AND (turn_lock_at IS NULL OR turn_lock_at < ?)`,
    )
    .run(token, now, sessionId, userId, now - TURN_LOCK_TTL_MS);
  return (r.changes ?? 0) > 0;
}

/** 回合還在跑就刷新時間，避免長回覆被當成過期鎖 */
export async function refreshTurnLock(
  userId: string,
  sessionId: string,
  token: string,
  now = nowMs(),
): Promise<void> {
  await ensureTurnLockColumns();
  await db()
    .prepare(
      `UPDATE strategy_sessions SET turn_lock_at = ?
       WHERE id = ? AND user_id = ? AND turn_lock = ?`,
    )
    .run(now, sessionId, userId, token);
}

/** 只釋放自己拿的鎖；逾時後被別人接手的不動 */
export async function releaseTurnLock(userId: string, sessionId: string, token: string): Promise<void> {
  await ensureTurnLockColumns();
  await db()
    .prepare(
      `UPDATE strategy_sessions SET turn_lock = NULL, turn_lock_at = NULL
       WHERE id = ? AND user_id = ? AND turn_lock = ?`,
    )
    .run(sessionId, userId, token);
}

export async function countSessionMessages(userId: string, sessionId: string): Promise<number> {
  await ensureTables();
  const row = (await db()
    .prepare(
      `SELECT COUNT(*) AS c FROM strategy_session_messages
       WHERE session_id = ? AND user_id = ?`,
    )
    .get(sessionId, userId)) as { c?: number | string } | undefined;
  return Number(row?.c ?? 0);
}

export type LiveHostTail = {
  id: string;
  content: string;
  createdAt: number;
  speakerModel: string | null;
  speakerRole: string | null;
  speakerLabel: string | null;
  completionStatus: "ok" | "degraded" | "partial" | "aborted" | "failed" | null;
};

/** 只讀最新一則主持人回覆。給畫面跟上 Cursor 回合，不走整包同步。 */
export async function readLiveHostTail(userId: string, sessionId: string): Promise<LiveHostTail | null> {
  await ensureTables();
  const row = (await db()
    .prepare(
      `SELECT id, content, created_at, speaker_model, speaker_role, speaker_label, completion_status
       FROM strategy_session_messages
       WHERE session_id = ? AND user_id = ? AND role = 'assistant'
         AND (speaker_role IS NULL OR speaker_role <> 'advisor')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId, userId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const createdAt = Number(row.created_at);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 5 * 60 * 1000) return null;
  const rawStatus = row.completion_status == null ? null : String(row.completion_status);
  const completionStatus =
    rawStatus === "ok" ||
    rawStatus === "degraded" ||
    rawStatus === "partial" ||
    rawStatus === "aborted" ||
    rawStatus === "failed"
      ? rawStatus
      : null;
  const freshDone =
    (completionStatus === "ok" || completionStatus === "degraded") && Date.now() - createdAt < 30_000;
  if (completionStatus !== "partial" && !freshDone) return null;
  return {
    id: String(row.id),
    content: String(row.content ?? ""),
    createdAt,
    speakerModel: row.speaker_model == null ? null : String(row.speaker_model),
    speakerRole: row.speaker_role == null ? null : String(row.speaker_role),
    speakerLabel: row.speaker_label == null ? null : String(row.speaker_label),
    completionStatus,
  };
}

export async function getSessionSyncMeta(
  userId: string,
  sessionId: string,
): Promise<{
  sessionUpdatedAt: number;
  workspaceId: string;
  workspaceUpdatedAt: number;
  workspaceMemoryNotes: string;
  maxUpdatedAt: number;
  messageCount: number;
} | null> {
  await ensureTables();
  const sess = await getStrategySession(userId, sessionId, { omitMeta: true });
  if (!sess) return null;

  let workspaceUpdatedAt = 0;
  let workspaceMemoryNotes = "";
  const workspaceId = sess.workspaceId || "";
  if (workspaceId) {
    const ws = await getStrategyWorkspace(userId, workspaceId);
    if (ws) {
      workspaceUpdatedAt = ws.updatedAt;
      workspaceMemoryNotes = ws.memory.notes;
    }
  }

  const sessionUpdatedAt = sess.updatedAt;
  const messageCount = await countSessionMessages(userId, sessionId);
  return {
    sessionUpdatedAt,
    workspaceId,
    workspaceUpdatedAt,
    workspaceMemoryNotes,
    maxUpdatedAt: Math.max(sessionUpdatedAt, workspaceUpdatedAt),
    messageCount,
  };
}

/** 畫面只需要 source／kind。整包 structured_json 含 dossier，讀回來再丟掉會拖住「載入更早」。 */
function sessionMessageSelect(display: boolean): string {
  if (!display) {
    return `id, session_id, user_id, role, content, structured_json, created_at,
            speaker_model, speaker_role, speaker_label, turn_id, completion_status`;
  }
  return `id, session_id, user_id, role, content,
          (structured_json::jsonb ->> 'source') AS msg_source,
          (structured_json::jsonb ->> 'kind') AS msg_kind,
          created_at, speaker_model, speaker_role, speaker_label, turn_id, completion_status`;
}

function structuredFromMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  if (row.structured_json != null && row.structured_json !== "") {
    return safeJson(row.structured_json, {} as Record<string, unknown>);
  }
  const structured: Record<string, unknown> = {};
  if (typeof row.msg_source === "string" && row.msg_source) structured.source = row.msg_source;
  if (typeof row.msg_kind === "string" && row.msg_kind) structured.kind = row.msg_kind;
  return structured;
}

function mapSessionMessageRow(row: Record<string, unknown>): StrategySessionMessageRow {
  const rawStatus = row.completion_status == null ? null : String(row.completion_status);
  const completionStatus =
    rawStatus === "ok" ||
    rawStatus === "degraded" ||
    rawStatus === "partial" ||
    rawStatus === "aborted" ||
    rawStatus === "failed"
      ? rawStatus
      : null;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as "user" | "assistant" | "system",
    content: String(row.content ?? ""),
    structured: structuredFromMessageRow(row),
    createdAt: Number(row.created_at),
    speakerModel: row.speaker_model == null ? null : String(row.speaker_model),
    speakerRole: row.speaker_role == null ? null : String(row.speaker_role),
    speakerLabel: row.speaker_label == null ? null : String(row.speaker_label),
    turnId: row.turn_id == null || row.turn_id === "" ? null : String(row.turn_id),
    completionStatus,
  };
}

export async function findSessionMessageByTurn(
  userId: string,
  sessionId: string,
  turnId: string,
  role: "user" | "assistant" | "system",
  speakerRole?: string | null,
): Promise<StrategySessionMessageRow | null> {
  await ensureTables();
  const rows = (await db()
    .prepare(
      speakerRole
        ? `SELECT * FROM strategy_session_messages
           WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = ? AND speaker_role = ?
           ORDER BY created_at ASC, id ASC LIMIT 1`
        : `SELECT * FROM strategy_session_messages
           WHERE session_id = ? AND user_id = ? AND turn_id = ? AND role = ?
           ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .all(
      ...(speakerRole
        ? [sessionId, userId, turnId, role, speakerRole]
        : [sessionId, userId, turnId, role]),
    )) as Record<string, unknown>[];
  return rows[0] ? mapSessionMessageRow(rows[0]) : null;
}

export async function addSessionMessage(input: {
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  structured?: Record<string, unknown>;
  createdAt?: number;
  speakerModel?: string | null;
  speakerRole?: string | null;
  speakerLabel?: string | null;
  turnId?: string | null;
  completionStatus?: StrategyMessageCompletionStatus | null;
  /** 同 turnId＋role（＋speakerRole）已存在則不重複寫入 */
  idempotent?: boolean;
}): Promise<{ id: string; deduped: boolean }> {
  await ensureTables();
  const turnId = input.turnId?.trim() || null;
  if (input.idempotent && turnId) {
    const existing = await findSessionMessageByTurn(
      input.userId,
      input.sessionId,
      turnId,
      input.role,
      input.role === "assistant" ? input.speakerRole ?? null : null,
    );
    if (existing) {
      const prev = existing.completionStatus;
      const next = input.completionStatus ?? null;
      const canUpgrade = shouldUpgradeTurnCompletion(prev, next);
      const nextStructured = input.structured ?? existing.structured;
      const structuredChanged =
        input.structured != null &&
        JSON.stringify(input.structured) !== JSON.stringify(existing.structured);
      if (
        canUpgrade &&
        (input.content !== existing.content || next !== prev || structuredChanged)
      ) {
        await db()
          .prepare(
            `UPDATE strategy_session_messages
             SET content = ?, structured_json = ?, completion_status = ?,
                 created_at = COALESCE(?, created_at),
                 speaker_model = COALESCE(?, speaker_model),
                 speaker_role = COALESCE(?, speaker_role),
                 speaker_label = COALESCE(?, speaker_label)
             WHERE id = ? AND session_id = ? AND user_id = ?`,
          )
          .run(
            input.content,
            JSON.stringify(nextStructured),
            next,
            input.createdAt ?? null,
            input.speakerModel ?? null,
            input.speakerRole ?? null,
            input.speakerLabel ?? null,
            existing.id,
            input.sessionId,
            input.userId,
          );
        await touchSessionUpdatedAt(input.userId, input.sessionId);
        return { id: existing.id, deduped: true };
      }
      return { id: existing.id, deduped: true };
    }
  }

  const id = `smsg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db()
    .prepare(
      `INSERT INTO strategy_session_messages
        (id, session_id, user_id, role, content, structured_json, created_at,
         speaker_model, speaker_role, speaker_label, turn_id, completion_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.userId,
      input.role,
      input.content,
      JSON.stringify(input.structured ?? {}),
      input.createdAt ?? nowMs(),
      input.speakerModel ?? null,
      input.speakerRole ?? null,
      input.speakerLabel ?? null,
      turnId,
      input.completionStatus ?? null,
    );
  await touchSessionUpdatedAt(input.userId, input.sessionId);
  return { id, deduped: false };
}

/** 相容舊呼叫：取最新 N 則（升序）；上限 messagesPageMax */
export async function listSessionMessages(
  userId: string,
  sessionId: string,
  limit: number = STRATEGY_LIMITS.messagesPageSize,
) {
  const page = await listSessionMessagesPage(userId, sessionId, { limit });
  return page.messages;
}

/** 比 afterCreatedAt 新、比 beforeCreatedAt 舊的訊息（升序）。用來吸收已滑出視窗的歷史。 */
export async function listSessionMessagesBetween(
  userId: string,
  sessionId: string,
  afterCreatedAt: number,
  beforeCreatedAt: number,
  limit = 40,
): Promise<StrategySessionMessageRow[]> {
  await ensureTables();
  if (!(beforeCreatedAt > afterCreatedAt)) return [];
  const cap = Math.min(Math.max(limit, 1), STRATEGY_LIMITS.messagesPageMax);
  const msgCols = `id, session_id, user_id, role, content, structured_json, created_at,
                   speaker_model, speaker_role, speaker_label, turn_id, completion_status`;
  const rows = (await db()
    .prepare(
      `SELECT ${msgCols} FROM strategy_session_messages
       WHERE session_id = ? AND user_id = ?
         AND created_at > ? AND created_at < ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(sessionId, userId, afterCreatedAt, beforeCreatedAt, cap)) as Record<string, unknown>[];
  return rows.map(mapSessionMessageRow);
}

export async function listSessionMessagesPage(
  userId: string,
  sessionId: string,
  opts?: {
    limit?: number;
    /** 載入比此游標更舊的訊息（createdAt:id） */
    before?: string | null;
    /** 開房 lite：跳過 COUNT(*)，total 以本頁估算 */
    skipTotal?: boolean;
    /** 畫面用：只取 source／kind，不把整包 structured_json 拉回 Node */
    display?: boolean;
  },
): Promise<{
  messages: StrategySessionMessageRow[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}> {
  await ensureTables();
  const limit = Math.min(
    Math.max(opts?.limit ?? STRATEGY_LIMITS.messagesPageSize, 1),
    STRATEGY_LIMITS.messagesPageMax,
  );
  const before = decodeMessageCursor(opts?.before ?? null);

  // 先 DESC 取 limit+1，再翻成 ASC；多出的一則用來判斷 hasMore（更舊方向）
  const msgCols = sessionMessageSelect(Boolean(opts?.display));
  const rawDesc = (
    before
      ? ((await db()
          .prepare(
            `SELECT ${msgCols} FROM strategy_session_messages
             WHERE session_id = ? AND user_id = ?
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionId, userId, before.createdAt, before.createdAt, before.id, limit + 1)) as Record<
          string,
          unknown
        >[])
      : ((await db()
          .prepare(
            `SELECT ${msgCols} FROM strategy_session_messages
             WHERE session_id = ? AND user_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionId, userId, limit + 1)) as Record<string, unknown>[])
  );

  const hasMore = rawDesc.length > limit;
  const pageDesc = hasMore ? rawDesc.slice(0, limit) : rawDesc;
  const messages = pageDesc
    .slice()
    .reverse()
    .map(mapSessionMessageRow);
  const oldest = messages[0];
  const nextCursor =
    hasMore && oldest ? encodeMessageCursor(oldest.createdAt, oldest.id) : null;
  const total = opts?.skipTotal
    ? messages.length + (hasMore ? 1 : 0)
    : await countSessionMessages(userId, sessionId);
  return { messages, hasMore, nextCursor, total };
}

/** sync：取游標（createdAt:id）之後的訊息，舊到新；truncated=true 表示超過 limit 還有更新的 */
export async function listSessionMessagesAfter(
  userId: string,
  sessionId: string,
  after: string,
  limit: number,
): Promise<{ messages: StrategySessionMessageRow[]; truncated: boolean }> {
  const cur = decodeMessageCursor(after);
  if (!cur) return { messages: [], truncated: false };
  await ensureTables();
  const cap = Math.min(Math.max(limit, 1), STRATEGY_LIMITS.messagesPageMax);
  const rows = (await db()
    .prepare(
      `SELECT id, session_id, user_id, role, content, structured_json, created_at,
              speaker_model, speaker_role, speaker_label, turn_id, completion_status
       FROM strategy_session_messages
       WHERE session_id = ? AND user_id = ?
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(sessionId, userId, cur.createdAt, cur.createdAt, cur.id, cap + 1)) as Record<string, unknown>[];
  const truncated = rows.length > cap;
  return { messages: (truncated ? rows.slice(0, cap) : rows).map(mapSessionMessageRow), truncated };
}

/** 開房／sync：自最新往舊合併直到 hardCap；超過則 hasMore=true（還有更舊） */
export async function collectSessionMessages(
  userId: string,
  sessionId: string,
  hardCap = STRATEGY_LIMITS.messagesHardCap,
): Promise<{
  messages: StrategySessionMessageRow[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}> {
  const total = await countSessionMessages(userId, sessionId);
  const cap = Math.min(Math.max(hardCap, 1), STRATEGY_LIMITS.messagesHardCap);
  const pageSize = STRATEGY_LIMITS.messagesPageMax;
  let before: string | null = null;
  const acc: StrategySessionMessageRow[] = [];
  let guard = 0;
  let lastHasMore = false;
  let lastCursor: string | null = null;

  while (acc.length < cap && guard < 60) {
    guard += 1;
    const need = Math.min(pageSize, cap - acc.length);
    const page = await listSessionMessagesPage(userId, sessionId, { limit: need, before });
    if (!page.messages.length) {
      lastHasMore = false;
      lastCursor = null;
      break;
    }
    if (!before) acc.push(...page.messages);
    else acc.unshift(...page.messages);
    lastHasMore = page.hasMore;
    lastCursor = page.nextCursor;
    if (!page.hasMore || !page.nextCursor) break;
    before = page.nextCursor;
  }

  if (acc.length > cap) {
    const sliced = acc.slice(acc.length - cap);
    return {
      messages: sliced,
      hasMore: true,
      nextCursor: encodeMessageCursor(sliced[0]!.createdAt, sliced[0]!.id),
      total,
    };
  }
  return {
    messages: acc,
    hasMore: lastHasMore,
    nextCursor: lastHasMore ? lastCursor : null,
    total,
  };
}

export async function listRunsForSession(userId: string, sessionId: string, limit = 10) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_loop_runs
       WHERE user_id = ? AND session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, sessionId, Math.min(Math.max(limit, 1), 50))) as Record<string, unknown>[];
  return rows.map(mapRun);
}

/** 開房 UI 只需 id／profile／時間，不撈 summary／metrics 大 JSON */
export async function listRunsForSessionBrief(userId: string, sessionId: string, limit = 10) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT id, user_id, profile_id, strategy_version, git_commit, session_id, created_at,
              '{}' AS summary_json, '' AS review_excerpt, '{}' AS metrics_json
       FROM strategy_loop_runs
       WHERE user_id = ? AND session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, sessionId, Math.min(Math.max(limit, 1), 50))) as Record<string, unknown>[];
  return rows.map(mapRun);
}

export async function attachRunToSession(userId: string, sessionId: string, runId: string): Promise<boolean> {
  await ensureTables();
  const sess = await getStrategySession(userId, sessionId);
  if (!sess) return false;
  const run = await getStrategyRun(userId, runId);
  if (!run) return false;
  const r = await db()
    .prepare(`UPDATE strategy_loop_runs SET session_id = ? WHERE id = ? AND user_id = ?`)
    .run(sessionId, runId, userId);
  await touchSessionUpdatedAt(userId, sessionId);
  return (r.changes ?? 0) > 0;
}

// ─── SOP 範本（strategy_templates）────────────────────────────────

function mapTemplateRow(row: Record<string, unknown>): StrategyTemplate {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    stages: safeJson(row.stages_json, [] as string[]),
    quickPrompts: safeJson(row.quick_prompts_json, [] as string[]),
    recommendedModels: safeJson(row.recommended_models_json, [] as RecommendedModelSlot[]),
    systemPrompt: String(row.system_prompt ?? ""),
    streamLeadPreface: String(row.stream_lead_preface ?? ""),
    enabled: Number(row.enabled ?? 1) !== 0,
    sortOrder: Number(row.sort_order ?? 100),
    isBuiltin: Number(row.is_builtin ?? 0) !== 0,
  };
}

export async function listStrategyTemplatesFromDb(opts: {
  includeDisabled?: boolean;
} = {}): Promise<StrategyTemplate[]> {
  await ensureTables();
  const rows = opts.includeDisabled
    ? ((await db()
        .prepare(`SELECT * FROM strategy_templates ORDER BY sort_order ASC, id ASC`)
        .all()) as Record<string, unknown>[])
    : ((await db()
        .prepare(
          `SELECT * FROM strategy_templates WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`,
        )
        .all()) as Record<string, unknown>[]);
  if (rows.length) return rows.map(mapTemplateRow);
  return BUILTIN_STRATEGY_TEMPLATES.filter((t) => t.enabled !== false);
}

export async function getStrategyTemplateById(id: string | null | undefined): Promise<StrategyTemplate> {
  await ensureTables();
  const tid = (id || "").trim();
  if (tid) {
    const row = (await db()
      .prepare(`SELECT * FROM strategy_templates WHERE id = ?`)
      .get(tid)) as Record<string, unknown> | undefined;
    if (row) return mapTemplateRow(row);
    const builtin = BUILTIN_STRATEGY_TEMPLATES.find((t) => t.id === tid);
    if (builtin) return builtin;
  }
  return BUILTIN_STRATEGY_TEMPLATES[0]!;
}

export async function templateIdExists(id: string): Promise<boolean> {
  const tid = id.trim();
  if (!tid || !TEMPLATE_ID_RE.test(tid)) return false;
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT id FROM strategy_templates WHERE id = ?`)
    .get(tid)) as { id: string } | undefined;
  if (row) return true;
  return BUILTIN_STRATEGY_TEMPLATES.some((t) => t.id === tid);
}

export async function createStrategyTemplate(input: {
  id: string;
  name: string;
  description?: string;
  stages?: string[];
  quickPrompts?: string[];
  recommendedModels?: RecommendedModelSlot[];
  systemPrompt?: string;
  streamLeadPreface?: string;
  enabled?: boolean;
  sortOrder?: number;
}): Promise<StrategyTemplate> {
  await ensureTables();
  const id = input.id.trim();
  if (!TEMPLATE_ID_RE.test(id)) {
    throw Object.assign(new Error("id 須符合 /^[a-z0-9_-]{2,48}$/"), { status: 400 });
  }
  const exists = await db().prepare(`SELECT id FROM strategy_templates WHERE id = ?`).get(id);
  if (exists) {
    throw Object.assign(new Error("template id 已存在"), { status: 409 });
  }
  const ts = nowMs();
  const name = clip(input.name.trim() || id, 120);
  const description = clip((input.description ?? "").trim(), 500);
  const stages = Array.isArray(input.stages) ? input.stages.map(String) : [];
  const quickPrompts = Array.isArray(input.quickPrompts) ? input.quickPrompts.map(String) : [];
  const recommendedModels = Array.isArray(input.recommendedModels) ? input.recommendedModels : [];
  const systemPrompt = String(input.systemPrompt ?? "");
  const streamLeadPreface = String(input.streamLeadPreface ?? "");
  const enabled = input.enabled === false ? 0 : 1;
  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 100;
  await db()
    .prepare(
      `INSERT INTO strategy_templates (
        id, name, description, stages_json, quick_prompts_json, recommended_models_json,
        system_prompt, stream_lead_preface, enabled, sort_order, is_builtin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      id,
      name,
      description,
      JSON.stringify(stages),
      JSON.stringify(quickPrompts),
      JSON.stringify(recommendedModels),
      systemPrompt,
      streamLeadPreface,
      enabled,
      sortOrder,
      ts,
      ts,
    );
  return getStrategyTemplateById(id);
}

export async function updateStrategyTemplate(
  id: string,
  patch: {
    name?: string;
    description?: string;
    stages?: string[];
    quickPrompts?: string[];
    recommendedModels?: RecommendedModelSlot[];
    systemPrompt?: string;
    streamLeadPreface?: string;
    enabled?: boolean;
    sortOrder?: number;
  },
): Promise<StrategyTemplate | null> {
  await ensureTables();
  const cur = await getStrategyTemplateById(id);
  const row = (await db()
    .prepare(`SELECT id FROM strategy_templates WHERE id = ?`)
    .get(id)) as { id: string } | undefined;
  if (!row) {
    // 尚未 seed 的內建：先插入再更新
    if (!BUILTIN_STRATEGY_TEMPLATES.some((t) => t.id === id)) return null;
    await seedBuiltinStrategyTemplates();
  }
  const name = patch.name !== undefined ? clip(patch.name.trim() || cur.name, 120) : cur.name;
  const description =
    patch.description !== undefined ? clip(patch.description.trim(), 500) : cur.description;
  const stages = patch.stages !== undefined ? patch.stages.map(String) : cur.stages;
  const quickPrompts =
    patch.quickPrompts !== undefined ? patch.quickPrompts.map(String) : cur.quickPrompts;
  const recommendedModels =
    patch.recommendedModels !== undefined ? patch.recommendedModels : cur.recommendedModels;
  const systemPrompt = patch.systemPrompt !== undefined ? String(patch.systemPrompt) : cur.systemPrompt;
  const streamLeadPreface =
    patch.streamLeadPreface !== undefined ? String(patch.streamLeadPreface) : cur.streamLeadPreface;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled === false ? 0 : 1;
  const sortOrder =
    patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)
      ? Number(patch.sortOrder)
      : (cur.sortOrder ?? 100);
  const ts = nowMs();
  await db()
    .prepare(
      `UPDATE strategy_templates SET
        name = ?, description = ?, stages_json = ?, quick_prompts_json = ?, recommended_models_json = ?,
        system_prompt = ?, stream_lead_preface = ?, enabled = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      name,
      description,
      JSON.stringify(stages),
      JSON.stringify(quickPrompts),
      JSON.stringify(recommendedModels),
      systemPrompt,
      streamLeadPreface,
      enabled,
      sortOrder,
      ts,
      id,
    );
  return getStrategyTemplateById(id);
}

export async function deleteStrategyTemplate(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT id, is_builtin FROM strategy_templates WHERE id = ?`)
    .get(id)) as { id: string; is_builtin: number } | undefined;
  if (!row) {
    if (BUILTIN_STRATEGY_TEMPLATES.some((t) => t.id === id)) {
      return { ok: false, error: "內建範本不可刪除" };
    }
    return { ok: false, error: "not found" };
  }
  if (Number(row.is_builtin) !== 0) {
    return { ok: false, error: "內建範本不可刪除（可停用）" };
  }
  await db().prepare(`DELETE FROM strategy_templates WHERE id = ?`).run(id);
  return { ok: true };
}

/** 從模型回覆抽出 JSON 物件 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    /* continue */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as Record<string, unknown>;
    } catch {
      /* continue */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}
