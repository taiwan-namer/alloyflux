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
} as const;

export type StrategyDossier = {
  strategies: Record<string, string>;
  findings: string[];
  decisions: string[];
  fPlan: Record<string, unknown> | null;
};

async function ensureTables(): Promise<void> {
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
  ];
  for (const sql of stmts) {
    await db().exec(sql);
  }
}

function nowMs(): number {
  return Date.now();
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
}): Promise<{ id: string }> {
  await ensureTables();
  const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = nowMs();
  const status =
    input.status && STRATEGY_SESSION_STATUSES.includes(input.status) ? input.status : "collecting";
  await db()
    .prepare(
      `INSERT INTO strategy_sessions
        (id, user_id, name, profile_id, strategy_version, status, model, pending_instructions_json, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
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
      ts,
      ts,
    );
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
  await db()
    .prepare(`UPDATE strategy_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(nowMs(), input.sessionId, input.userId);
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
  },
): Promise<boolean> {
  await ensureTables();
  const cur = await getStrategySession(userId, sessionId);
  if (!cur) return false;
  const status = patch.status ?? cur.status;
  const pending = patch.pendingInstructions ?? cur.pendingInstructions;
  const meta = patch.meta ?? cur.meta;
  const model = patch.model ?? cur.model;
  await db()
    .prepare(
      `UPDATE strategy_sessions
       SET status = ?, pending_instructions_json = ?, meta_json = ?, model = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(status, JSON.stringify(pending), JSON.stringify(meta), model, nowMs(), sessionId, userId);
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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
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
  await db()
    .prepare(`UPDATE strategy_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(nowMs(), input.sessionId, input.userId);
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
  await db()
    .prepare(`UPDATE strategy_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(nowMs(), sessionId, userId);
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
