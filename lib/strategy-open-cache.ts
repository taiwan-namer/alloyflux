import type { StrategySessionDetail, StrategySessionMessage } from "@/components/strategy-types";

const COMPLETION_RANK: Record<string, number> = {
  failed: 0,
  aborted: 1,
  partial: 2,
  degraded: 3,
  ok: 4,
};

/** `createdAt:id` 游標比較；較新為正 */
export function compareStrategyMessageCursor(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const [atA, idA = ""] = a.split(":");
  const [atB, idB = ""] = b.split(":");
  const nA = Number(atA) || 0;
  const nB = Number(atB) || 0;
  if (nA !== nB) return nA - nB;
  return String(idA).localeCompare(String(idB));
}

export function strategyMessageCursor(m: Pick<StrategySessionMessage, "id" | "createdAt">): string {
  return `${m.createdAt || 0}:${m.id}`;
}

export function newestStrategyMessageCursor(messages: StrategySessionMessage[] | undefined): string {
  let newest = "";
  for (const m of messages ?? []) {
    const c = strategyMessageCursor(m);
    if (!newest || compareStrategyMessageCursor(c, newest) > 0) newest = c;
  }
  return newest;
}

function completionRank(status: StrategySessionMessage["completionStatus"]): number {
  if (!status) return 3; // 無狀態視為接近完成（舊資料）
  return COMPLETION_RANK[status] ?? 2;
}

/** 同 id：保留較完整／較長的那一則，避免 partial 蓋掉 ok */
export function preferStrategyMessage(
  a: StrategySessionMessage,
  b: StrategySessionMessage,
): StrategySessionMessage {
  const ra = completionRank(a.completionStatus);
  const rb = completionRank(b.completionStatus);
  if (ra !== rb) return ra >= rb ? a : b;
  const la = (a.content || "").length;
  const lb = (b.content || "").length;
  if (la !== lb) return la >= lb ? a : b;
  return a;
}

export function mergeStrategyMessages(
  previous: StrategySessionMessage[],
  incoming: StrategySessionMessage[],
): StrategySessionMessage[] {
  const byId = new Map<string, StrategySessionMessage>();
  for (const m of previous) byId.set(m.id, m);
  for (const m of incoming) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev ? preferStrategyMessage(m, prev) : m);
  }
  return [...byId.values()].sort((a, b) => {
    const dt = (a.createdAt || 0) - (b.createdAt || 0);
    return dt !== 0 ? dt : String(a.id).localeCompare(String(b.id));
  });
}

export type StrategySnapshotFreshness = {
  newestCursor: string;
  messageTotal: number;
  updatedAt: number;
  contentChars: number;
};

export function strategySnapshotFreshness(detail: StrategySessionDetail): StrategySnapshotFreshness {
  const messages = detail.messages ?? [];
  return {
    newestCursor: newestStrategyMessageCursor(messages),
    messageTotal:
      typeof detail.messageTotal === "number" && Number.isFinite(detail.messageTotal)
        ? detail.messageTotal
        : messages.length,
    updatedAt: detail.session?.updatedAt ?? 0,
    contentChars: messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
  };
}

/**
 * incoming 是否至少與 existing 一樣新（可寫入快取）。
 * 拒絕「較舊 snapshot 覆寫較新快取」——手機重開常見根因。
 */
export function isStrategySnapshotAtLeastAsFresh(
  incoming: StrategySessionDetail,
  existing: StrategySessionDetail,
): boolean {
  const a = strategySnapshotFreshness(incoming);
  const b = strategySnapshotFreshness(existing);
  const cmp = compareStrategyMessageCursor(a.newestCursor, b.newestCursor);
  if (cmp !== 0) return cmp > 0;
  if (a.messageTotal !== b.messageTotal) return a.messageTotal >= b.messageTotal;
  if (a.contentChars !== b.contentChars) return a.contentChars >= b.contentChars;
  return a.updatedAt >= b.updatedAt;
}
