/**
 * 會議室記憶：比照聊天的狀態筆記＋滑出視窗的歷史摘要。
 * 存在 session.meta.roomMemory，不寫進 conversation_states（那張表綁著聊天對話）。
 */
import {
  buildHistorySummaryText,
  extractStatePatchesFromMessages,
  formatConversationStateForInject,
  formatHistorySummariesForInject,
  mergeStateNote,
  planStateAbsorbBatch,
  STATE_ABSORB_FULL_RATIO,
  STATE_ABSORB_TOKEN_TARGET,
  type ConversationStateNote,
  type HistorySummaryBlock,
} from "@/lib/conversation-state";
import { newId } from "@/lib/db";
import { estimateTokensApprox } from "@/lib/research-v2/token-budget";
import {
  listSessionMessagesBetween,
  listSessionMessagesPage,
  selectStrategyHistory,
  STRATEGY_LIMITS,
  type StrategySessionMessageRow,
} from "@/lib/strategy-loop";

const SUMMARY_KEEP = 12;
const ABSORB_PAGE = 40;
const USER_SPEC_KEEP = 3;
const USER_SPEC_CHARS = 2800;
const USER_SPEC_INJECT_CHARS = 4500;

export type UserSpec = {
  messageId: string;
  createdAt: number;
  text: string;
};

type RoomMemory = {
  note: ConversationStateNote;
  summaries: HistorySummaryBlock[];
  userSpecs: UserSpec[];
};

function emptyNote(sessionId: string): ConversationStateNote {
  return {
    conversationId: sessionId,
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function entries(raw: unknown): ConversationStateNote["hardConstraints"] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ConversationStateNote["hardConstraints"][number] =>
      !!e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string",
  );
}

function readRoomMemory(meta: Record<string, unknown>, sessionId: string): RoomMemory {
  const raw = asRecord(meta.roomMemory);
  const noteRaw = asRecord(raw?.note);
  const note = emptyNote(sessionId);
  if (noteRaw) {
    note.goal = typeof noteRaw.goal === "string" ? noteRaw.goal : "";
    note.hardConstraints = entries(noteRaw.hardConstraints);
    note.decisions = entries(noteRaw.decisions);
    note.progress = entries(noteRaw.progress);
    note.openQuestions = entries(noteRaw.openQuestions);
    note.sourceMessageIds = Array.isArray(noteRaw.sourceMessageIds) ? noteRaw.sourceMessageIds.map(String) : [];
    note.coveredThroughCreatedAt = Number(noteRaw.coveredThroughCreatedAt) || 0;
    note.revision = Number(noteRaw.revision) || 0;
  }
  const summaries: HistorySummaryBlock[] = [];
  if (Array.isArray(raw?.summaries)) {
    for (const item of raw.summaries) {
      const s = asRecord(item);
      if (!s || typeof s.summaryText !== "string" || !s.summaryText.trim()) continue;
      summaries.push({
        id: typeof s.id === "string" ? s.id : newId(),
        conversationId: sessionId,
        fromCreatedAt: Number(s.fromCreatedAt) || 0,
        toCreatedAt: Number(s.toCreatedAt) || 0,
        fromMessageId: typeof s.fromMessageId === "string" ? s.fromMessageId : null,
        toMessageId: typeof s.toMessageId === "string" ? s.toMessageId : null,
        summaryText: s.summaryText,
        tokenEst: Number(s.tokenEst) || 0,
        sourceMessageIds: Array.isArray(s.sourceMessageIds) ? s.sourceMessageIds.map(String) : [],
        createdAt: Number(s.createdAt) || 0,
      });
    }
  }
  const userSpecs = readUserSpecs(raw?.userSpecs);
  return { note, summaries, userSpecs };
}

function readUserSpecs(raw: unknown): UserSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: UserSpec[] = [];
  for (const item of raw) {
    const s = asRecord(item);
    if (!s || typeof s.text !== "string" || !s.text.trim()) continue;
    if (typeof s.messageId !== "string" || !s.messageId) continue;
    out.push({
      messageId: s.messageId,
      createdAt: Number(s.createdAt) || 0,
      text: s.text.slice(0, USER_SPEC_CHARS),
    });
  }
  return out.slice(-USER_SPEC_KEEP);
}

/** 網頁上使用者跟主持人談的規格：長文、表格、必須保存。短句確認不算。 */
export function isUserSpecMessage(content: string): boolean {
  const text = content.trim();
  if (text.length < 80) return false;
  if (text.length >= 400) return true;
  return /必須保存|規格|模組|驗收|主軸|目標|項目／|項目\/|解決這次/.test(text);
}

export function mergeUserSpecs(existing: UserSpec[], incoming: UserSpec[]): UserSpec[] {
  const byId = new Map(existing.map((s) => [s.messageId, s]));
  for (const spec of incoming) {
    const prev = byId.get(spec.messageId);
    if (!prev || spec.text.length >= prev.text.length) byId.set(spec.messageId, spec);
  }
  return [...byId.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-USER_SPEC_KEEP);
}

export function formatUserSpecBlock(goal: string, specs: UserSpec[]): string {
  if (!specs.length && !goal.trim()) return "";
  const lines = [
    "# 使用者規格（優先於路線圖結案口徑）",
    "這是使用者跟主持人談定、要做出來的內容。路線圖只代表階段進度與限縮結論。",
    "被問「做完了嗎」時：先對這份規格說明哪些能確認、哪些不能宣稱，再用路線圖補階段狀態。不要把路線圖全數結案說成規格逐欄通過或已實際啟用。",
  ];
  if (goal.trim()) lines.push(`原初目標：${goal.trim()}`);
  let budget = USER_SPEC_INJECT_CHARS;
  const newestFirst = [...specs].reverse();
  for (const spec of newestFirst) {
    if (budget < 200) break;
    const body = spec.text.length > budget ? `${spec.text.slice(0, budget)}…` : spec.text;
    lines.push(`--- 使用者規格 ---\n${body}`);
    budget -= body.length;
  }
  return lines.join("\n");
}

/** 注入模型的會議室記憶。沒有內容就回空字串。 */
export function formatStrategyRoomMemory(meta: Record<string, unknown> | null | undefined, sessionId: string): string {
  if (!meta) return "";
  const memory = readRoomMemory(meta, sessionId);
  const spec = formatUserSpecBlock(memory.note.goal, memory.userSpecs);
  const note = formatConversationStateForInject(memory.note);
  const summaries = formatHistorySummariesForInject(memory.summaries.slice(-2));
  return [spec, note, summaries].filter((s) => s.trim()).join("\n\n");
}

function historyOpts(lean: boolean, offset: number) {
  return lean
    ? {
        offset,
        minKeep: STRATEGY_LIMITS.leanHistoryMinMessages,
        maxChars: STRATEGY_LIMITS.leanHistoryCharBudget,
        olderAssistantMaxChars: STRATEGY_LIMITS.leanOlderAssistantMaxChars,
      }
    : { offset };
}

/**
 * 本輪結束後更新記憶：視窗內最新一則使用者訊息寫進狀態筆記；
 * 滑出視窗、且尚未吸收的訊息，比照聊天整批收成摘要。
 */
export async function absorbStrategyRoomMemory(input: {
  userId: string;
  sessionId: string;
  meta: Record<string, unknown>;
  lean: boolean;
}): Promise<Record<string, unknown>> {
  const memory = readRoomMemory(input.meta, input.sessionId);
  let note = memory.note;
  const summaries = [...memory.summaries];
  let userSpecs = memory.userSpecs;

  const page = await listSessionMessagesPage(input.userId, input.sessionId, {
    limit: STRATEGY_LIMITS.historyFetchLimit,
  });
  const offset = Math.max(0, page.total - page.messages.length);
  const bounded = selectStrategyHistory(page.messages, historyOpts(input.lean, offset));
  const windowStartAt = bounded[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;

  const webUsers = page.messages.filter(
    (m) => m.role === "user" && m.structured?.source === "web" && isUserSpecMessage(m.content),
  );
  userSpecs = mergeUserSpecs(
    userSpecs,
    webUsers.map((m) => ({
      messageId: m.id,
      createdAt: m.createdAt,
      text: m.content.trim().slice(0, USER_SPEC_CHARS),
    })),
  );

  const latestWeb = [...page.messages]
    .reverse()
    .find((m) => m.role === "user" && m.structured?.source === "web" && m.createdAt >= windowStartAt);
  const latestUser =
    latestWeb ??
    [...page.messages].reverse().find((m) => m.role === "user" && m.createdAt >= windowStartAt);
  if (latestUser) {
    note = mergeStateNote(note, extractStatePatchesFromMessages([toPatchMessage(latestUser)]));
  }

  const pending = await listSessionMessagesBetween(
    input.userId,
    input.sessionId,
    note.coveredThroughCreatedAt,
    windowStartAt,
    ABSORB_PAGE,
  );
  if (pending.length) {
    const batch = planStateAbsorbBatch(pending.map(toPatchMessage));
    if (batch.take.length) {
      const patch = extractStatePatchesFromMessages(batch.take);
      const maxCreated = Math.max(...batch.take.map((m) => m.createdAt));
      const minCreated = Math.min(...batch.take.map((m) => m.createdAt));
      note = mergeStateNote(note, { ...patch, coveredThroughCreatedAt: maxCreated });
      if (
        batch.takeTokens >= STATE_ABSORB_TOKEN_TARGET * STATE_ABSORB_FULL_RATIO ||
        batch.take.length >= 8
      ) {
        summaries.push({
          id: newId(),
          conversationId: input.sessionId,
          fromCreatedAt: minCreated,
          toCreatedAt: maxCreated,
          fromMessageId: batch.take[0]?.id ?? null,
          toMessageId: batch.take[batch.take.length - 1]?.id ?? null,
          summaryText: buildHistorySummaryText(batch.take),
          tokenEst: batch.takeTokens || estimateTokensApprox(batch.take.map((m) => m.content).join("\n")),
          sourceMessageIds: batch.take.map((m) => m.id),
          createdAt: Date.now(),
        });
      }
    }
  }

  return {
    ...input.meta,
    roomMemory: {
      note,
      summaries: summaries.slice(-SUMMARY_KEEP),
      userSpecs,
    },
  };
}

function toPatchMessage(m: StrategySessionMessageRow): {
  id: string;
  role: string;
  content: string;
  createdAt: number;
} {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}
