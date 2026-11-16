/**
 * 本串對話狀態筆記 + 歷史摘要塊。
 * - 筆記：每輪注入；條目含 provenance／status；決策可 supersede
 * - 摘要：視窗外內容整則批次（≈3500 tok）吸收後落庫；注入時只帶最近相關塊
 */
import { UPSTREAM_MAX_TURNS } from "./context-window";
import { db, newId } from "./db";
import { estimateTokensApprox } from "./research-v2/token-budget";
import type { StoredMessage } from "./store";

export const MAX_STATE_NOTE_CHARS = 2400;
export const MAX_HISTORY_SUMMARY_INJECT_CHARS = 1800;
export const STATE_ABSORB_TOKEN_TARGET = 3500;
export const STATE_ABSORB_TOKEN_HARD_CAP = 5000;
export const STATE_ABSORB_FULL_RATIO = 0.8;
const LIST_CAP = 12;
const LINE_MAX = 160;

export type MemoryProvenance = "user" | "assistant_inferred" | "system";
export type MemoryStatus = "confirmed" | "pending" | "superseded";

export type StateEntry = {
  id: string;
  text: string;
  provenance: MemoryProvenance;
  status: MemoryStatus;
  sourceMessageId?: string;
  createdAt: number;
  supersededBy?: string;
};

export type ConversationStateNote = {
  conversationId: string;
  goal: string;
  hardConstraints: StateEntry[];
  decisions: StateEntry[];
  progress: StateEntry[];
  openQuestions: StateEntry[];
  sourceMessageIds: string[];
  coveredThroughCreatedAt: number;
  revision: number;
  updatedAt: number;
};

export type HistorySummaryBlock = {
  id: string;
  conversationId: string;
  fromCreatedAt: number;
  toCreatedAt: number;
  fromMessageId: string | null;
  toMessageId: string | null;
  summaryText: string;
  tokenEst: number;
  sourceMessageIds: string[];
  createdAt: number;
};

export type StateAbsorbBatchDecision = {
  take: { id: string; role: string; content: string; createdAt: number }[];
  defer: { id: string; role: string; content: string; createdAt: number }[];
  takeTokens: number;
};

function entryId(): string {
  return newId();
}

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
}

function parseEntries(raw: string | null | undefined): StateEntry[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: StateEntry[] = [];
    for (const item of v) {
      if (typeof item === "string") {
        const text = normalizeText(item);
        if (text.length < 4) continue;
        out.push({
          id: entryId(),
          text,
          provenance: "user",
          status: "confirmed",
          createdAt: Date.now(),
        });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const o = item as Partial<StateEntry>;
      const text = normalizeText(String(o.text ?? ""));
      if (text.length < 4) continue;
      const provenance: MemoryProvenance =
        o.provenance === "assistant_inferred" || o.provenance === "system" || o.provenance === "user"
          ? o.provenance
          : "user";
      const status: MemoryStatus =
        o.status === "pending" || o.status === "superseded" || o.status === "confirmed"
          ? o.status
          : "confirmed";
      out.push({
        id: String(o.id || entryId()),
        text,
        provenance,
        status,
        sourceMessageId: o.sourceMessageId ? String(o.sourceMessageId) : undefined,
        createdAt: Number(o.createdAt) || Date.now(),
        supersededBy: o.supersededBy ? String(o.supersededBy) : undefined,
      });
    }
    return out;
  } catch {
    return raw
      .split(/\n/)
      .map((s) => normalizeText(s.replace(/^[-*•]\s*/, "")))
      .filter((t) => t.length >= 4)
      .map((text) => ({
        id: entryId(),
        text,
        provenance: "user" as const,
        status: "confirmed" as const,
        createdAt: Date.now(),
      }));
  }
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x)).filter(Boolean);
  } catch {
    return [];
  }
}

function activeEntries(list: StateEntry[]): StateEntry[] {
  return list.filter((e) => e.status !== "superseded");
}

/** 主題重疊粗判：英文詞或中文 bigram 共享 ≥2 視為同主題（供取代） */
function sameTopic(a: string, b: string): boolean {
  const tok = (s: string): string[] => {
    const cleaned = s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!cleaned) return [];
    const out: string[] = [];
    for (const part of cleaned.split(/\s+/).filter(Boolean)) {
      if (/[\u4e00-\u9fff]/.test(part)) {
        if (part.length <= 2) {
          if (part.length >= 2) out.push(part);
          continue;
        }
        for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
      } else if (part.length >= 2) {
        out.push(part);
      }
    }
    return out;
  };
  const A = new Set(tok(a));
  if (!A.size) return a.toLowerCase() === b.toLowerCase();
  let hits = 0;
  for (const t of tok(b)) {
    if (A.has(t)) hits += 1;
    if (hits >= 2) return true;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 合併條目：去重；新決策可 supersede 同主題舊決策。
 * 硬約束：assistant_inferred 不得覆蓋 user confirmed；user 新約束可取代同主題舊約束。
 */
export function mergeEntries(
  base: StateEntry[],
  incoming: StateEntry[],
  opts: { kind: "hardConstraints" | "decisions" | "progress" | "openQuestions" },
): StateEntry[] {
  let out = [...base];
  for (const item of incoming) {
    const text = normalizeText(item.text);
    if (text.length < 4) continue;
    const next: StateEntry = { ...item, text, id: item.id || entryId() };

    const dup = out.find(
      (e) => e.status !== "superseded" && e.text.toLowerCase() === text.toLowerCase(),
    );
    if (dup) continue;

    if (opts.kind === "decisions" || opts.kind === "hardConstraints") {
      for (const e of out) {
        if (e.status === "superseded") continue;
        if (!sameTopic(e.text, text)) continue;
        // 硬約束：推測不可取代使用者確認
        if (
          opts.kind === "hardConstraints" &&
          e.provenance === "user" &&
          e.status === "confirmed" &&
          next.provenance === "assistant_inferred"
        ) {
          continue;
        }
        e.status = "superseded";
        e.supersededBy = next.id;
      }
    }

    if (opts.kind === "openQuestions") {
      // 新決策若覆蓋待確認同主題 → 关掉待確認
      // （在 decisions merge 時處理較清楚；此處僅追加）
    }

    out.push(next);
  }

  // 硬約束優先保留 confirmed user
  if (opts.kind === "hardConstraints") {
    const active = activeEntries(out);
    const preferred = [
      ...active.filter((e) => e.provenance === "user" && e.status === "confirmed"),
      ...active.filter((e) => !(e.provenance === "user" && e.status === "confirmed")),
    ];
    const superseded = out.filter((e) => e.status === "superseded");
    out = [...preferred.slice(-LIST_CAP), ...superseded.slice(-LIST_CAP)];
  } else {
    const active = activeEntries(out).slice(-LIST_CAP);
    const superseded = out.filter((e) => e.status === "superseded").slice(-LIST_CAP);
    out = [...active, ...superseded];
  }
  return out;
}

function emptyNote(conversationId: string): ConversationStateNote {
  return {
    conversationId,
    goal: "",
    hardConstraints: [],
    decisions: [],
    progress: [],
    openQuestions: [],
    sourceMessageIds: [],
    coveredThroughCreatedAt: 0,
    revision: 0,
    updatedAt: 0,
  };
}

export async function getConversationState(
  conversationId: string,
): Promise<ConversationStateNote | null> {
  try {
    const row = (await db()
      .prepare(
        `SELECT conversation_id AS "conversationId",
                goal,
                hard_constraints AS "hardConstraints",
                decisions,
                progress,
                open_questions AS "openQuestions",
                source_message_ids AS "sourceMessageIds",
                covered_through_created_at AS "coveredThroughCreatedAt",
                revision,
                updated_at AS "updatedAt"
         FROM conversation_states WHERE conversation_id = ?`,
      )
      .get(conversationId)) as
      | {
          conversationId: string;
          goal: string;
          hardConstraints: string;
          decisions: string;
          progress: string;
          openQuestions: string;
          sourceMessageIds: string;
          coveredThroughCreatedAt: number;
          revision: number;
          updatedAt: number;
        }
      | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      goal: row.goal || "",
      hardConstraints: parseEntries(row.hardConstraints),
      decisions: parseEntries(row.decisions),
      progress: parseEntries(row.progress),
      openQuestions: parseEntries(row.openQuestions),
      sourceMessageIds: parseIdList(row.sourceMessageIds),
      coveredThroughCreatedAt: Number(row.coveredThroughCreatedAt) || 0,
      revision: Number(row.revision) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

export async function upsertConversationState(note: ConversationStateNote): Promise<void> {
  const now = Date.now();
  const revision = Math.max(1, note.revision || 1);
  try {
    await db()
      .prepare(
        `INSERT INTO conversation_states (
           conversation_id, goal, hard_constraints, decisions, progress, open_questions,
           source_message_ids, covered_through_created_at, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           goal = EXCLUDED.goal,
           hard_constraints = EXCLUDED.hard_constraints,
           decisions = EXCLUDED.decisions,
           progress = EXCLUDED.progress,
           open_questions = EXCLUDED.open_questions,
           source_message_ids = EXCLUDED.source_message_ids,
           covered_through_created_at = EXCLUDED.covered_through_created_at,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at`,
      )
      .run(
        note.conversationId,
        note.goal.slice(0, 400),
        JSON.stringify(note.hardConstraints),
        JSON.stringify(note.decisions),
        JSON.stringify(note.progress),
        JSON.stringify(note.openQuestions),
        JSON.stringify(note.sourceMessageIds.slice(-24)),
        note.coveredThroughCreatedAt,
        revision,
        now,
      );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/conversation_states|does not exist|relation/i.test(msg)) {
      console.warn("[conversation-state] table missing; skip upsert");
      return;
    }
    throw e;
  }
}

function formatEntryLine(e: StateEntry): string {
  const tag =
    e.status === "pending"
      ? "待確認"
      : e.provenance === "assistant_inferred"
        ? "推測"
        : e.provenance === "user"
          ? "使用者"
          : "系統";
  return `- （${tag}）${e.text}`;
}

/** 只注入現行（非 superseded）條目 */
export function formatConversationStateForInject(note: ConversationStateNote): string {
  const lines: string[] = [
    "【本串對話狀態筆記｜須遵守；與近期聊天衝突時以較新「已確認決策」為準；推測不可覆蓋使用者硬約束】",
  ];
  if (note.goal.trim()) lines.push(`目標：${note.goal.trim()}`);
  const hc = activeEntries(note.hardConstraints);
  if (hc.length) {
    lines.push("硬性約束：");
    for (const c of hc) lines.push(formatEntryLine(c));
  }
  const dec = activeEntries(note.decisions);
  if (dec.length) {
    lines.push("已確認決策：");
    for (const d of dec) lines.push(formatEntryLine(d));
  }
  const prog = activeEntries(note.progress);
  if (prog.length) {
    lines.push("進度：");
    for (const p of prog) lines.push(formatEntryLine(p));
  }
  const open = activeEntries(note.openQuestions);
  if (open.length) {
    lines.push("待確認：");
    for (const q of open) lines.push(formatEntryLine(q));
  }
  if (note.sourceMessageIds.length) {
    lines.push(`來源訊息：${note.sourceMessageIds.slice(-8).join(", ")}`);
  }
  if (lines.length <= 1) return "";
  let text = lines.join("\n").trim();
  if (text.length > MAX_STATE_NOTE_CHARS) {
    text = `${text.slice(0, MAX_STATE_NOTE_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

export async function listRecentHistorySummaries(
  conversationId: string,
  limit = 2,
): Promise<HistorySummaryBlock[]> {
  try {
    const rows = (await db()
      .prepare(
        `SELECT id,
                conversation_id AS "conversationId",
                from_created_at AS "fromCreatedAt",
                to_created_at AS "toCreatedAt",
                from_message_id AS "fromMessageId",
                to_message_id AS "toMessageId",
                summary_text AS "summaryText",
                token_est AS "tokenEst",
                source_message_ids AS "sourceMessageIds",
                created_at AS "createdAt"
         FROM conversation_history_summaries
         WHERE conversation_id = ?
         ORDER BY to_created_at DESC
         LIMIT ?`,
      )
      .all(conversationId, limit)) as {
      id: string;
      conversationId: string;
      fromCreatedAt: number;
      toCreatedAt: number;
      fromMessageId: string | null;
      toMessageId: string | null;
      summaryText: string;
      tokenEst: number;
      sourceMessageIds: string;
      createdAt: number;
    }[];
    return rows.map((r) => ({
      ...r,
      sourceMessageIds: parseIdList(r.sourceMessageIds),
    }));
  } catch {
    return [];
  }
}

export function formatHistorySummariesForInject(blocks: HistorySummaryBlock[]): string {
  if (!blocks.length) return "";
  const ordered = [...blocks].sort((a, b) => a.toCreatedAt - b.toCreatedAt);
  const lines = ["【較早對話摘要｜細節以原文為準；需精確內容時應回查來源】"];
  for (const b of ordered) {
    lines.push(`--- 摘要 ${b.id.slice(0, 8)}（訊息 ${b.sourceMessageIds.length} 則）---`);
    lines.push(b.summaryText.trim());
  }
  let text = lines.join("\n").trim();
  if (text.length > MAX_HISTORY_SUMMARY_INJECT_CHARS) {
    text = `${text.slice(0, MAX_HISTORY_SUMMARY_INJECT_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

export async function buildConversationStateContext(conversationId: string): Promise<string> {
  const [note, summaries] = await Promise.all([
    getConversationState(conversationId),
    listRecentHistorySummaries(conversationId, 2),
  ]);
  const parts = [
    note ? formatConversationStateForInject(note) : "",
    formatHistorySummariesForInject(summaries),
  ].filter((s) => s.trim());
  return parts.join("\n\n");
}

export function planStateAbsorbBatch(
  pending: { id: string; role: string; content: string; createdAt: number }[],
  targetTokens = STATE_ABSORB_TOKEN_TARGET,
): StateAbsorbBatchDecision {
  const take: StateAbsorbBatchDecision["take"] = [];
  const defer: StateAbsorbBatchDecision["defer"] = [];
  let tokens = 0;

  for (let i = 0; i < pending.length; i++) {
    const msg = pending[i];
    const n = Math.max(1, estimateTokensApprox(msg.content || ""));
    if (tokens === 0) {
      take.push(msg);
      tokens += n;
      if (tokens >= targetTokens) {
        defer.push(...pending.slice(i + 1));
        break;
      }
      continue;
    }
    if (tokens + n <= targetTokens) {
      take.push(msg);
      tokens += n;
      continue;
    }
    if (tokens >= targetTokens * STATE_ABSORB_FULL_RATIO) {
      defer.push(...pending.slice(i));
      break;
    }
    if (tokens + n <= STATE_ABSORB_TOKEN_HARD_CAP) {
      take.push(msg);
      tokens += n;
      defer.push(...pending.slice(i + 1));
      break;
    }
    defer.push(...pending.slice(i));
    break;
  }

  return { take, defer, takeTokens: tokens };
}

const GOAL_RE =
  /(?:^|\n)\s*(?:目標|目前目標|本次任務|我們要)\s*[：:]\s*([^\n。！？]{4,120})/i;
const CONSTRAINT_RE =
  /(?:不可|禁止|不要|不得|必須|一定要|硬性|約束|預算|上限|不能改|尚未獲准|不准部署|不部署)[^\n。！？]{0,100}/gi;
const DECISION_RE =
  /(?:決定|採用|選定|確認|就用|改成|定案)\s*[：:]?\s*([^\n。！？]{4,120})/gi;
const OPEN_RE =
  /(?:待確認|尚未決定|還在評估|待釐清|不確定)\s*[：:]?\s*([^\n。！？]{0,120})/gi;

function makeEntry(
  text: string,
  provenance: MemoryProvenance,
  status: MemoryStatus,
  sourceMessageId?: string,
): StateEntry {
  return {
    id: entryId(),
    text: normalizeText(text),
    provenance,
    status,
    sourceMessageId,
    createdAt: Date.now(),
  };
}

export function extractStatePatchesFromMessages(
  messages: { id: string; role: string; content: string }[],
): Partial<
  Pick<
    ConversationStateNote,
    "goal" | "hardConstraints" | "decisions" | "progress" | "openQuestions" | "sourceMessageIds"
  >
> {
  const hardConstraints: StateEntry[] = [];
  const decisions: StateEntry[] = [];
  const progress: StateEntry[] = [];
  const openQuestions: StateEntry[] = [];
  const sourceMessageIds: string[] = [];
  let goal = "";

  for (const m of messages) {
    const text = m.content?.trim() ?? "";
    if (!text) continue;
    sourceMessageIds.push(m.id);
    const provenance: MemoryProvenance = m.role === "user" ? "user" : "assistant_inferred";
    const status: MemoryStatus = m.role === "user" ? "confirmed" : "pending";

    const g = text.match(GOAL_RE);
    if (g?.[1] && m.role === "user") goal = g[1].trim().slice(0, LINE_MAX);

    const constraints = text.match(CONSTRAINT_RE) || [];
    for (const c of constraints) {
      hardConstraints.push(makeEntry(c, provenance, status === "confirmed" ? "confirmed" : "pending", m.id));
    }

    DECISION_RE.lastIndex = 0;
    for (const d of text.matchAll(DECISION_RE)) {
      const line = (d[1] || d[0] || "").trim();
      if (line) {
        decisions.push(
          makeEntry(line, provenance, m.role === "user" ? "confirmed" : "pending", m.id),
        );
      }
    }

    OPEN_RE.lastIndex = 0;
    for (const q of text.matchAll(OPEN_RE)) {
      const line = (q[1] || q[0] || "").trim();
      if (line) openQuestions.push(makeEntry(line, provenance, "pending", m.id));
    }

    if (m.role === "user" && text.length >= 24) {
      const first = text.split(/[。！？\n]/)[0]?.trim() ?? "";
      if (first.length >= 8 && first.length <= LINE_MAX) {
        progress.push(makeEntry(first, "user", "confirmed", m.id));
      }
    }
  }

  return {
    goal: goal || undefined,
    hardConstraints,
    decisions,
    progress,
    openQuestions,
    sourceMessageIds,
  };
}

export function mergeStateNote(
  base: ConversationStateNote,
  patch: Partial<ConversationStateNote>,
): ConversationStateNote {
  let decisions = mergeEntries(base.decisions, patch.decisions ?? [], { kind: "decisions" });
  // 新 confirmed 決策關掉同主題 openQuestions
  const activeDec = activeEntries(decisions);
  const openQuestions = mergeEntries(base.openQuestions, patch.openQuestions ?? [], {
    kind: "openQuestions",
  }).map((q) => {
    if (q.status === "superseded") return q;
    if (activeDec.some((d) => d.status === "confirmed" && sameTopic(d.text, q.text))) {
      return { ...q, status: "superseded" as const, supersededBy: activeDec[0]?.id };
    }
    return q;
  });

  return {
    ...base,
    goal: (patch.goal?.trim() || base.goal).slice(0, 400),
    hardConstraints: mergeEntries(base.hardConstraints, patch.hardConstraints ?? [], {
      kind: "hardConstraints",
    }),
    decisions,
    progress: mergeEntries(base.progress, patch.progress ?? [], { kind: "progress" }),
    openQuestions,
    sourceMessageIds: (() => {
      const out = [...base.sourceMessageIds];
      const seen = new Set(out);
      for (const id of patch.sourceMessageIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out.slice(-24);
    })(),
    coveredThroughCreatedAt:
      patch.coveredThroughCreatedAt != null
        ? Math.max(base.coveredThroughCreatedAt, patch.coveredThroughCreatedAt)
        : base.coveredThroughCreatedAt,
    revision: (base.revision || 0) + 1,
    updatedAt: Date.now(),
  };
}

/** 零成本：把一批舊訊壓成結構化摘要文字（非 LLM） */
export function buildHistorySummaryText(
  messages: { id: string; role: string; content: string }[],
): string {
  const patch = extractStatePatchesFromMessages(messages);
  const lines: string[] = [];
  if (patch.goal) lines.push(`目標線索：${patch.goal}`);
  for (const c of patch.hardConstraints ?? []) lines.push(`約束：${c.text}`);
  for (const d of patch.decisions ?? []) lines.push(`決策：${d.text}`);
  for (const q of patch.openQuestions ?? []) lines.push(`待確認：${q.text}`);
  // 每則首句線索（上限）
  let n = 0;
  for (const m of messages) {
    if (n >= 6) break;
    const first = (m.content || "").split(/[。！？\n]/)[0]?.trim() ?? "";
    if (first.length < 8) continue;
    lines.push(`${m.role === "user" ? "User" : "AI"}：${first.slice(0, 100)}`);
    n += 1;
  }
  if (!lines.length) {
    lines.push(`（${messages.length} 則較早訊息，未抽到結構化欄位）`);
  }
  return lines.join("\n").slice(0, 2000);
}

export async function insertHistorySummary(block: Omit<HistorySummaryBlock, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
}): Promise<void> {
  const id = block.id || newId();
  const createdAt = block.createdAt || Date.now();
  try {
    await db()
      .prepare(
        `INSERT INTO conversation_history_summaries (
           id, conversation_id, from_created_at, to_created_at,
           from_message_id, to_message_id, summary_text, token_est,
           source_message_ids, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        block.conversationId,
        block.fromCreatedAt,
        block.toCreatedAt,
        block.fromMessageId,
        block.toMessageId,
        block.summaryText,
        block.tokenEst,
        JSON.stringify(block.sourceMessageIds),
        createdAt,
      );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/conversation_history_summaries|does not exist|relation/i.test(msg)) {
      console.warn("[conversation-state] history summary table missing; skip insert");
      return;
    }
    throw e;
  }
}

export async function updateConversationStateAfterTurn(input: {
  conversationId: string;
  messages: StoredMessage[];
}): Promise<ConversationStateNote | null> {
  const { conversationId, messages } = input;
  if (!conversationId || !messages.length) return null;

  let note = (await getConversationState(conversationId)) ?? emptyNote(conversationId);
  note.conversationId = conversationId;

  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const windowMsgs = Math.max(2, UPSTREAM_MAX_TURNS * 2);
  const inWindow = sorted.slice(-windowMsgs);
  const windowStartAt = inWindow[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;

  const latestUser = [...inWindow].reverse().find((m) => m.role === "user");
  if (latestUser) {
    note = mergeStateNote(note, extractStatePatchesFromMessages([latestUser]));
  }

  const pending = sorted.filter(
    (m) => m.createdAt < windowStartAt && m.createdAt > note.coveredThroughCreatedAt,
  );
  if (pending.length) {
    const batch = planStateAbsorbBatch(
      pending.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    );
    if (batch.take.length) {
      const patch = extractStatePatchesFromMessages(batch.take);
      const maxCreated = Math.max(...batch.take.map((m) => m.createdAt));
      const minCreated = Math.min(...batch.take.map((m) => m.createdAt));
      note = mergeStateNote(note, {
        ...patch,
        coveredThroughCreatedAt: maxCreated,
      });

      // 達門檻或本批夠滿 → 落一筆歷史摘要塊
      if (
        batch.takeTokens >= STATE_ABSORB_TOKEN_TARGET * STATE_ABSORB_FULL_RATIO ||
        batch.take.length >= 8
      ) {
        const summaryText = buildHistorySummaryText(batch.take);
        await insertHistorySummary({
          conversationId,
          fromCreatedAt: minCreated,
          toCreatedAt: maxCreated,
          fromMessageId: batch.take[0]?.id ?? null,
          toMessageId: batch.take[batch.take.length - 1]?.id ?? null,
          summaryText,
          tokenEst: batch.takeTokens,
          sourceMessageIds: batch.take.map((m) => m.id),
        });
      }
    }
  }

  if (!note.coveredThroughCreatedAt && sorted.length > windowMsgs) {
    const older = sorted.slice(0, -windowMsgs);
    const lastOld = older[older.length - 1];
    if (lastOld) {
      note = mergeStateNote(note, { coveredThroughCreatedAt: lastOld.createdAt });
    }
  }

  const hasContent =
    note.goal ||
    activeEntries(note.hardConstraints).length ||
    activeEntries(note.decisions).length ||
    activeEntries(note.progress).length ||
    activeEntries(note.openQuestions).length ||
    note.coveredThroughCreatedAt;

  if (!hasContent) return note;

  await upsertConversationState(note);
  return note;
}
