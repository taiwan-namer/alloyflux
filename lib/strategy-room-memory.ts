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

type RoomMemory = {
  note: ConversationStateNote;
  summaries: HistorySummaryBlock[];
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
  return { note, summaries };
}

/** 注入模型的會議室記憶。沒有內容就回空字串。 */
export function formatStrategyRoomMemory(meta: Record<string, unknown> | null | undefined, sessionId: string): string {
  if (!meta) return "";
  const memory = readRoomMemory(meta, sessionId);
  const note = formatConversationStateForInject(memory.note);
  const summaries = formatHistorySummariesForInject(memory.summaries.slice(-2));
  return [note, summaries].filter((s) => s.trim()).join("\n\n");
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

  const page = await listSessionMessagesPage(input.userId, input.sessionId, {
    limit: STRATEGY_LIMITS.historyFetchLimit,
  });
  const offset = Math.max(0, page.total - page.messages.length);
  const bounded = selectStrategyHistory(page.messages, historyOpts(input.lean, offset));
  const windowStartAt = bounded[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;

  const latestUser = [...page.messages]
    .reverse()
    .find((m) => m.role === "user" && m.createdAt >= windowStartAt);
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
