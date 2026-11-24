import { randomUUID } from "node:crypto";
import { db } from "./db";

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
 */
export const STRATEGY_LIMITS = {
  messageMaxChars: 8000,
  reportMaxChars: 30000,
  dossierMaxChars: 12000,
  reportsInjectMaxChars: 24000,
  reportInjectEachMaxChars: 8000,
  runsInjectMaxChars: 6000,
  historyMessages: 6,
  summaryMaxChars: 800,
  roomQueryMaxChars: 2000,
  roomQueriesPerTurn: 3,
  workspaceMemoryMaxChars: 4000,
  workspaceBriefMaxChars: 6000,
} as const;

export type StrategyDossier = {
  strategies: Record<string, string>;
  findings: string[];
  decisions: string[];
  fPlan: Record<string, unknown> | null;
};

let tablesReady: Promise<void> | null = null;

function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = createTables().catch((e) => {
      tablesReady = null;
      throw e;
    });
  }
  return tablesReady;
}

async function createTables(): Promise<void> {
  // postgres.js unsafe 對多語句不穩，逐句執行
  const stmts = [
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_runs_user
      ON strategy_loop_runs(user_id, created_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_plans_user_status
      ON strategy_loop_plans(user_id, status, created_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_code_results_plan
      ON strategy_loop_code_results(plan_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS strategy_loop_retros (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      window_hours INT NOT NULL DEFAULT 12,
      summary_json TEXT NOT NULL DEFAULT '{}',
      next_hypotheses_json TEXT NOT NULL DEFAULT '[]',
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_retros_user
      ON strategy_loop_retros(user_id, created_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_sessions_user
      ON strategy_sessions(user_id, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS strategy_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      structured_json TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_session_messages_sess
      ON strategy_session_messages(session_id, created_at ASC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_session_reports_sess
      ON strategy_session_reports(session_id, created_at DESC)`,
    `ALTER TABLE strategy_loop_runs ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_loop_runs_session
      ON strategy_loop_runs(session_id, created_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_workspaces_user
      ON strategy_workspaces(user_id, updated_at DESC)`,
    // 舊會議室（Cursor 主導的 F、G）預設 auto_dispatch=1，行為與改版前一致
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS topic TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS summary_updated_at BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS auto_dispatch INT NOT NULL DEFAULT 1`,
    `ALTER TABLE strategy_sessions ADD COLUMN IF NOT EXISTS pause_state TEXT NOT NULL DEFAULT 'none'`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_sessions_workspace
      ON strategy_sessions(workspace_id, updated_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_strategy_dispatch_session
      ON strategy_dispatch_items(session_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_dispatch_user_status
      ON strategy_dispatch_items(user_id, status, created_at ASC)`,
  ];
  for (const sql of stmts) {
    await db().exec(sql);
  }
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
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = nowMs();
  const status =
    input.status && STRATEGY_SESSION_STATUSES.includes(input.status) ? input.status : "collecting";
  let workspaceId = input.workspaceId?.trim() || "";
  if (workspaceId) {
    const ws = await getStrategyWorkspace(input.userId, workspaceId);
    if (!ws) throw new Error("workspace not found");
  } else {
    workspaceId = (await ensureDefaultWorkspace(input.userId)).id;
  }
  await db()
    .prepare(
      `INSERT INTO strategy_sessions
        (id, user_id, name, profile_id, strategy_version, status, model, pending_instructions_json, meta_json,
         workspace_id, topic, auto_dispatch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.name.trim() || "strategy-session",
      input.profileId ?? "",
      input.strategyVersion ?? "",
      status,
      input.model ?? "",
      JSON.stringify(input.meta ?? {}),
      workspaceId,
      clip((input.topic ?? "").trim(), 500),
      input.autoDispatch === false ? 0 : 1,
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

export async function listSessionReports(userId: string, sessionId: string, limit = 30) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_session_reports
       WHERE session_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, userId, Math.min(Math.max(limit, 1), 100))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id ?? ""),
    kind: String(row.kind ?? ""),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    chars: Number(row.chars ?? 0),
    createdAt: Number(row.created_at),
  }));
}

export async function listStrategySessions(userId: string, limit = 20) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 50))) as Record<string, unknown>[];
  return rows.map(mapSession);
}

export async function getStrategySession(userId: string, sessionId: string) {
  await ensureTables();
  const row = (await db()
    .prepare(`SELECT * FROM strategy_sessions WHERE id = ? AND user_id = ?`)
    .get(sessionId, userId)) as Record<string, unknown> | undefined;
  return row ? mapSession(row) : null;
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
  },
): Promise<boolean> {
  await ensureTables();
  const cur = await getStrategySession(userId, sessionId);
  if (!cur) return false;
  const status = patch.status ?? cur.status;
  const pending = patch.pendingInstructions ?? cur.pendingInstructions;
  const meta = patch.meta ?? cur.meta;
  const model = patch.model ?? cur.model;
  const name = patch.name?.trim() ? clip(patch.name.trim(), 120) : cur.name;
  const topic = patch.topic !== undefined ? clip(patch.topic.trim(), 500) : cur.topic;
  const summaryChanged = patch.summary !== undefined && patch.summary.trim() !== "";
  const summary = summaryChanged
    ? clip(patch.summary!.trim(), STRATEGY_LIMITS.summaryMaxChars)
    : cur.summary;
  const summaryAt = summaryChanged ? nowMs() : cur.summaryUpdatedAt;
  const autoDispatch = patch.autoDispatch ?? cur.autoDispatch;
  const pauseState = patch.pauseState !== undefined ? normalizePauseState(patch.pauseState) : cur.pauseState;
  const ts = nowMs();
  await db()
    .prepare(
      `UPDATE strategy_sessions
       SET status = ?, pending_instructions_json = ?, meta_json = ?, model = ?, name = ?, topic = ?,
           summary = ?, summary_updated_at = ?, auto_dispatch = ?, pause_state = ?,
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
      `SELECT * FROM strategy_workspaces WHERE user_id = ? AND deleted_at IS NULL
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
  await db()
    .prepare(`UPDATE strategy_sessions SET workspace_id = ? WHERE user_id = ? AND workspace_id = ''`)
    .run(ws.id, userId);
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
      `SELECT * FROM strategy_sessions WHERE user_id = ? AND workspace_id = ?
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

export async function getSessionSyncMeta(
  userId: string,
  sessionId: string,
): Promise<{
  sessionUpdatedAt: number;
  workspaceId: string;
  workspaceUpdatedAt: number;
  workspaceMemoryNotes: string;
  maxUpdatedAt: number;
} | null> {
  await ensureTables();
  const sess = await getStrategySession(userId, sessionId);
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
  return {
    sessionUpdatedAt,
    workspaceId,
    workspaceUpdatedAt,
    workspaceMemoryNotes,
    maxUpdatedAt: Math.max(sessionUpdatedAt, workspaceUpdatedAt),
  };
}

export async function addSessionMessage(input: {
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  structured?: Record<string, unknown>;
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `smsg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db()
    .prepare(
      `INSERT INTO strategy_session_messages
        (id, session_id, user_id, role, content, structured_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.userId,
      input.role,
      input.content,
      JSON.stringify(input.structured ?? {}),
      nowMs(),
    );
  await touchSessionUpdatedAt(input.userId, input.sessionId);
  return { id };
}

export async function listSessionMessages(userId: string, sessionId: string, limit = 40) {
  await ensureTables();
  const rows = (await db()
    .prepare(
      `SELECT * FROM strategy_session_messages
       WHERE session_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, userId, Math.min(Math.max(limit, 1), 100))) as Record<string, unknown>[];
  return rows
    .map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as "user" | "assistant" | "system",
      content: String(row.content ?? ""),
      structured: safeJson(row.structured_json, {} as Record<string, unknown>),
      createdAt: Number(row.created_at),
    }))
    .reverse();
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
