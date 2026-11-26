/**
 * 會議室「主線帳本」：計畫項目、目前工作包、退回計數與上一輪指令。
 * 由程式保存與注入，不受 dossier 截斷影響；主持人只能透過結構化欄位修改。
 * 純函式（不碰 DB），方便測試。
 */

export type LedgerItemStatus = "todo" | "in_progress" | "done" | "parked" | "blocked";

export const LEDGER_ITEM_STATUSES: LedgerItemStatus[] = ["todo", "in_progress", "done", "parked", "blocked"];

export type LedgerItem = {
  id: string;
  title: string;
  status: LedgerItemStatus;
  parentId?: string;
  note?: string;
  parkedReason?: string;
  resumeTrigger?: string;
  /** 主持人驗收結案時寫的結論（做了什麼、結果、留給後續的事） */
  conclusion?: string;
  updatedAt: number;
};

/** 專案簡介：討論期結束後由主持人寫入，每回合固定注入 */
export type ProjectBrief = {
  topic: string;
  problems: string[];
  requirements: string[];
  constraints: string[];
  updatedAt: number;
};

export type WorkPackageStatus = "executing" | "reviewing" | "accepted" | "escalated";

export type WorkPackage = {
  id: string;
  itemId: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  stopConditions: string[];
  rejectCount: number;
  status: WorkPackageStatus;
  lastRejectReason?: string;
  createdAt: number;
  updatedAt: number;
};

export type HeldInstruction = { text: string; itemId: string | null; reason: string };

export type StrategyLedger = {
  brief: ProjectBrief | null;
  items: LedgerItem[];
  currentItemId: string | null;
  currentPackage: WorkPackage | null;
  lastHostTurn: {
    at: number;
    instructions: string[];
    reportRequests: string[];
    held: HeldInstruction[];
  } | null;
  /** 帳本變更紀錄（最新在後，保留 12 筆） */
  log: string[];
};

export const LEDGER_LIMITS = {
  maxItems: 40,
  titleMaxChars: 120,
  noteMaxChars: 300,
  conclusionMaxChars: 600,
  briefFieldMaxChars: 300,
  briefListMax: 8,
  opsPerTurnMax: 20,
  packageFieldMaxChars: 400,
  packageListMax: 8,
  logMax: 12,
  lastTurnEachMaxChars: 900,
  lastTurnMaxItems: 8,
  /** 同一工作包被退回幾次就進入僵局處置 */
  rejectEscalateAt: 2,
} as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]{0,47}$/;

/** 不可逆動作：只有真的上正式／push 才暫扣。本機改碼、測試寫入、持久化例外不要誤攔。 */
const IRREVERSIBLE_RE =
  /git\s+push|vercel\s+(--prod|deploy\s+--prod)|部署到正式|上線正式|正式環境\s*(部署|上線)|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|正式(資料庫|DB)\s*(寫入|刪除|修改|migrat)/i;

/** 禁令子句（「不包含部署」「禁止 push」）不是要執行的動作 */
const PROHIBITION_RE = /不包含|不包括|不含|不得|禁止|嚴禁|不要|不可|不准|不能|勿|未經.{0,12}(批准|驗收|同意)/;

/** 以逗號／句號／分號切子句，去掉禁令子句後仍提到不可逆動作才算 */
export function isIrreversibleInstruction(text: string): boolean {
  if (!IRREVERSIBLE_RE.test(text)) return false;
  return text
    .split(/[，,。；;！!？?\n]+/)
    .some((clause) => !PROHIBITION_RE.test(clause) && IRREVERSIBLE_RE.test(clause));
}

const STATUS_LABEL: Record<LedgerItemStatus, string> = {
  todo: "⬜ 未開始",
  in_progress: "🟡 進行中",
  done: "✅ 完成",
  parked: "⏸ 暫停",
  blocked: "⛔ 卡住",
};

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => clip(String(x ?? ""), maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function emptyLedger(): StrategyLedger {
  return { brief: null, items: [], currentItemId: null, currentPackage: null, lastHostTurn: null, log: [] };
}

function normalizeBrief(raw: unknown, now: number): ProjectBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const L = LEDGER_LIMITS;
  const topic = clip(str(r.topic), L.briefFieldMaxChars);
  if (!topic) return null;
  return {
    topic,
    problems: strList(r.problems, L.briefListMax, L.briefFieldMaxChars),
    requirements: strList(r.requirements, L.briefListMax, L.briefFieldMaxChars),
    constraints: strList(r.constraints, L.briefListMax, L.briefFieldMaxChars),
    updatedAt: Number(r.updatedAt) > 0 ? Number(r.updatedAt) : now,
  };
}

export function isLedgerActive(ledger: StrategyLedger): boolean {
  return ledger.items.length > 0;
}

function normalizeItem(raw: unknown, now: number): LedgerItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  if (!ID_RE.test(id) || !title) return null;
  const status = LEDGER_ITEM_STATUSES.includes(r.status as LedgerItemStatus)
    ? (r.status as LedgerItemStatus)
    : "todo";
  const item: LedgerItem = {
    id,
    title: clip(title, LEDGER_LIMITS.titleMaxChars),
    status,
    updatedAt: Number.isFinite(Number(r.updatedAt)) && Number(r.updatedAt) > 0 ? Number(r.updatedAt) : now,
  };
  const parentId = str(r.parentId);
  if (parentId && ID_RE.test(parentId)) item.parentId = parentId;
  const note = str(r.note);
  if (note) item.note = clip(note, LEDGER_LIMITS.noteMaxChars);
  const parkedReason = str(r.parkedReason);
  if (parkedReason) item.parkedReason = clip(parkedReason, LEDGER_LIMITS.noteMaxChars);
  const resumeTrigger = str(r.resumeTrigger);
  if (resumeTrigger) item.resumeTrigger = clip(resumeTrigger, LEDGER_LIMITS.noteMaxChars);
  const conclusion = str(r.conclusion);
  if (conclusion) item.conclusion = clip(conclusion, LEDGER_LIMITS.conclusionMaxChars);
  return item;
}

function normalizePackage(raw: unknown, now: number): WorkPackage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const itemId = str(r.itemId);
  const goal = str(r.goal);
  if (!ID_RE.test(id) || !ID_RE.test(itemId) || !goal) return null;
  const L = LEDGER_LIMITS;
  const status = (["executing", "reviewing", "accepted", "escalated"] as const).includes(
    r.status as WorkPackageStatus,
  )
    ? (r.status as WorkPackageStatus)
    : "executing";
  const pkg: WorkPackage = {
    id,
    itemId,
    goal: clip(goal, L.packageFieldMaxChars),
    scope: strList(r.scope, L.packageListMax, L.packageFieldMaxChars),
    acceptance: strList(r.acceptance, L.packageListMax, L.packageFieldMaxChars),
    stopConditions: strList(r.stopConditions, L.packageListMax, L.packageFieldMaxChars),
    rejectCount: Math.max(0, Math.floor(Number(r.rejectCount) || 0)),
    status,
    createdAt: Number(r.createdAt) > 0 ? Number(r.createdAt) : now,
    updatedAt: Number(r.updatedAt) > 0 ? Number(r.updatedAt) : now,
  };
  const lastRejectReason = str(r.lastRejectReason);
  if (lastRejectReason) pkg.lastRejectReason = clip(lastRejectReason, L.noteMaxChars);
  return pkg;
}

/** 從 meta_json.ledger 讀出並正規化；壞資料一律丟棄，不丟例外 */
export function readLedger(meta: Record<string, unknown> | null | undefined, now = Date.now()): StrategyLedger {
  const raw = meta?.ledger;
  if (!raw || typeof raw !== "object") return emptyLedger();
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const items: LedgerItem[] = [];
  for (const it of Array.isArray(r.items) ? r.items : []) {
    const n = normalizeItem(it, now);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    items.push(n);
    if (items.length >= LEDGER_LIMITS.maxItems) break;
  }
  const currentItemId = str(r.currentItemId);
  const lastRaw = r.lastHostTurn as Record<string, unknown> | null | undefined;
  const lastHostTurn =
    lastRaw && typeof lastRaw === "object"
      ? {
          at: Number(lastRaw.at) || now,
          instructions: strList(lastRaw.instructions, LEDGER_LIMITS.lastTurnMaxItems, LEDGER_LIMITS.lastTurnEachMaxChars),
          reportRequests: strList(lastRaw.reportRequests, LEDGER_LIMITS.lastTurnMaxItems, LEDGER_LIMITS.lastTurnEachMaxChars),
          held: (Array.isArray(lastRaw.held) ? lastRaw.held : [])
            .map((h) => {
              const o = (h ?? {}) as Record<string, unknown>;
              const text = clip(String(o.text ?? ""), LEDGER_LIMITS.lastTurnEachMaxChars);
              if (!text) return null;
              return { text, itemId: str(o.itemId) || null, reason: clip(String(o.reason ?? ""), 120) };
            })
            .filter((h): h is HeldInstruction => h !== null)
            .slice(0, LEDGER_LIMITS.lastTurnMaxItems),
        }
      : null;
  return {
    brief: normalizeBrief(r.brief, now),
    items,
    currentItemId: currentItemId && seen.has(currentItemId) ? currentItemId : null,
    currentPackage: normalizePackage(r.currentPackage, now),
    lastHostTurn,
    log: strList(r.log, LEDGER_LIMITS.logMax, 200),
  };
}

/** 外部（API key／CLI）整份寫入帳本時的驗證；回傳正規化結果 */
export function validateLedgerInput(
  input: unknown,
  now = Date.now(),
): { ok: true; ledger: StrategyLedger } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "ledger 必須是物件" };
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.items) || r.items.length === 0) return { ok: false, error: "ledger.items 至少一項" };
  if (r.items.length > LEDGER_LIMITS.maxItems) {
    return { ok: false, error: `ledger.items 最多 ${LEDGER_LIMITS.maxItems} 項` };
  }
  for (const it of r.items) {
    if (!normalizeItem(it, now)) {
      return { ok: false, error: `項目格式錯誤（需要 id 符合 ${ID_RE} 與 title）：${JSON.stringify(it).slice(0, 120)}` };
    }
  }
  const ledger = readLedger({ ledger: input }, now);
  if (ledger.items.length !== r.items.length) return { ok: false, error: "ledger.items 有重複 id" };
  if (str(r.currentItemId) && !ledger.currentItemId) {
    return { ok: false, error: "currentItemId 不在 items 裡" };
  }
  return { ok: true, ledger: { ...ledger, log: [...ledger.log, `${stamp(now)} 帳本由外部匯入（${ledger.items.length} 項）`].slice(-LEDGER_LIMITS.logMax) } };
}

function stamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(ts).toISOString().slice(5, 16);
  }
}

// ─── 主持人輸出 → 帳本變更 ─────────────────────────────────────────

export type LedgerVerdict = "accept" | "reject" | "none";
export type EscalationChoice = "narrow" | "alternate" | "park";

export type LedgerTurnInput = {
  ledgerOps?: unknown;
  workPackage?: unknown;
  verdict?: unknown;
  verdictReason?: unknown;
  /** verdict 為 accept 時寫入項目的結論 */
  conclusion?: unknown;
  escalationDecision?: unknown;
  instructions: unknown[];
  reportRequests: unknown[];
};

export type LedgerTurnResult = {
  ledger: StrategyLedger;
  /** 可派送的指令（含 reportRequests） */
  allowedInstructions: unknown[];
  allowedReportRequests: unknown[];
  held: HeldInstruction[];
  /** 本回合帳本做了哪些事（給回應與紀錄） */
  events: string[];
  escalated: boolean;
};

function instructionText(x: unknown): string {
  if (typeof x === "string") return x.trim();
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return str(o.text) || str(o.instruction) || str(o.title) || str(o.spec) || JSON.stringify(o).slice(0, 400);
  }
  return String(x ?? "").trim();
}

/** 從可見回覆抽出「交付命令」正文。 */
export function extractDeliveryCommand(reply: string): string {
  const marked = reply.split(/交付命令\s*[：:／/]?/);
  if (marked.length < 2) return "";
  return marked[marked.length - 1]!.trim().slice(0, 4000);
}

/** instructions 空了或太短，用交付命令／工作包補成可派送清單。 */
export function fillInstructionsFromDelivery(
  reply: string,
  instructions: unknown[],
  workPackage?: unknown,
): unknown[] {
  const existing = instructions.filter((x) => instructionText(x).length > 0);
  const existingChars = existing.reduce((n, x) => n + instructionText(x).length, 0);
  const command = extractDeliveryCommand(reply);
  // 已有夠完整的指令就保留；只有空／過短時才用可見交付命令補上
  if (existing.length > 0 && (existingChars >= 80 || command.length <= existingChars)) {
    return existing;
  }
  if (command.length >= 8) return [command];
  if (existing.length > 0) return existing;
  if (!workPackage || typeof workPackage !== "object") return instructions;
  const pkg = workPackage as Record<string, unknown>;
  const id = str(pkg.id);
  const itemId = str(pkg.itemId);
  const goal = str(pkg.goal);
  if (!id && !goal) return instructions;
  const acceptance = Array.isArray(pkg.acceptance)
    ? pkg.acceptance.map((x) => str(x)).filter(Boolean).slice(0, 8)
    : [];
  const scope = Array.isArray(pkg.scope)
    ? pkg.scope.map((x) => str(x)).filter(Boolean).slice(0, 8)
    : [];
  const text = [
    `執行工作包 ${id || "下一項"}${itemId ? `（路線圖 ${itemId}）` : ""}`,
    goal ? `目標：${goal}` : "",
    scope.length ? `範圍：${scope.join("、")}` : "",
    acceptance.length ? `驗收：${acceptance.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("。");
  return [itemId ? { itemId, text } : text];
}

function instructionItemId(x: unknown): string | null {
  if (x && typeof x === "object") {
    const id = str((x as Record<string, unknown>).itemId);
    return id || null;
  }
  return null;
}

/** itemId 是否就是 scopeId 或其子孫項目 */
function isWithinItem(ledger: StrategyLedger, itemId: string, scopeId: string): boolean {
  const byId = new Map(ledger.items.map((i) => [i.id, i]));
  let cur: string | undefined = itemId;
  for (let depth = 0; cur && depth < LEDGER_LIMITS.maxItems; depth++) {
    if (cur === scopeId) return true;
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

function completeItem(ledger: StrategyLedger, item: LedgerItem, conclusion: string, now: number, events: string[]): void {
  item.status = "done";
  delete item.parkedReason;
  delete item.resumeTrigger;
  if (conclusion) item.conclusion = clip(conclusion, LEDGER_LIMITS.conclusionMaxChars);
  item.updatedAt = now;
  events.push(
    conclusion
      ? `${item.id} 完成：${clip(conclusion, 80)}`
      : `${item.id} 完成（⚠ 主持人未寫結論）`,
  );
}

/** 路線圖下一個要做的項目：先找進行中、再找未開始；有未完成子項目的父項目讓給子項目 */
export function pickNextItem(ledger: StrategyLedger): LedgerItem | null {
  const open = (s: LedgerItemStatus) => s === "todo" || s === "in_progress";
  const hasOpenChild = new Set(
    ledger.items.filter((i) => i.parentId && open(i.status)).map((i) => i.parentId as string),
  );
  const candidates = ledger.items.filter((i) => open(i.status) && !hasOpenChild.has(i.id));
  return candidates.find((i) => i.status === "in_progress") ?? candidates.find((i) => i.status === "todo") ?? null;
}

function applyOps(ledger: StrategyLedger, opsRaw: unknown, now: number, events: string[]): void {
  if (!Array.isArray(opsRaw)) return;
  for (const raw of opsRaw.slice(0, LEDGER_LIMITS.opsPerTurnMax)) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    const kind = str(op.op);
    if (kind === "setBrief") {
      const brief = normalizeBrief({ ...op, updatedAt: now }, now);
      if (!brief) continue;
      ledger.brief = brief;
      events.push(`專案簡介更新：${clip(brief.topic, 60)}`);
      continue;
    }
    const id = str(op.id);
    const item = ledger.items.find((i) => i.id === id);
    if (kind === "add") {
      if (item || ledger.items.length >= LEDGER_LIMITS.maxItems) continue;
      const created = normalizeItem({ ...op, status: op.status ?? "todo", updatedAt: now }, now);
      if (!created) continue;
      ledger.items.push(created);
      events.push(`新增項目 ${created.id}「${created.title}」`);
      continue;
    }
    if (!item) continue;
    if (kind === "complete") {
      if (item.status === "done") continue;
      completeItem(ledger, item, str(op.conclusion), now, events);
    } else if (kind === "setStatus") {
      const status = op.status as LedgerItemStatus;
      if (!LEDGER_ITEM_STATUSES.includes(status) || status === item.status) continue;
      if (status === "done") {
        completeItem(ledger, item, str(op.conclusion) || str(op.note), now, events);
        continue;
      }
      item.status = status;
      const note = str(op.note);
      if (note) item.note = clip(note, LEDGER_LIMITS.noteMaxChars);
      if (status !== "parked") {
        delete item.parkedReason;
        delete item.resumeTrigger;
      }
      item.updatedAt = now;
      events.push(`${item.id} → ${STATUS_LABEL[status]}${note ? `（${clip(note, 60)}）` : ""}`);
    } else if (kind === "park") {
      item.status = "parked";
      item.parkedReason = clip(str(op.reason) || "未註明", LEDGER_LIMITS.noteMaxChars);
      const trig = str(op.resumeTrigger);
      if (trig) item.resumeTrigger = clip(trig, LEDGER_LIMITS.noteMaxChars);
      item.updatedAt = now;
      if (ledger.currentItemId === item.id) ledger.currentItemId = null;
      events.push(`${item.id} 暫停：${clip(item.parkedReason, 60)}${trig ? `；恢復點：${clip(trig, 60)}` : ""}`);
    } else if (kind === "resume") {
      if (item.status !== "parked") continue;
      item.status = "in_progress";
      delete item.parkedReason;
      item.updatedAt = now;
      events.push(`${item.id} 恢復進行`);
    } else if (kind === "setCurrent") {
      if (ledger.currentItemId === item.id) continue;
      ledger.currentItemId = item.id;
      if (item.status === "todo" || item.status === "parked") {
        item.status = "in_progress";
        delete item.parkedReason;
        item.updatedAt = now;
      }
      events.push(`目前項目切換為 ${item.id}「${item.title}」`);
    }
  }
}

/**
 * 依主持人本回合輸出更新帳本，並決定哪些指令可派送、哪些要保留。
 * 帳本未啟用（沒有任何項目）時只記錄上一輪指令，不做攔截，維持舊行為。
 */
export function applyLedgerTurn(
  current: StrategyLedger,
  turn: LedgerTurnInput,
  now = Date.now(),
): LedgerTurnResult {
  const ledger: StrategyLedger = {
    brief: current.brief,
    items: current.items.map((i) => ({ ...i })),
    currentItemId: current.currentItemId,
    currentPackage: current.currentPackage ? { ...current.currentPackage } : null,
    lastHostTurn: current.lastHostTurn,
    log: [...current.log],
  };
  const events: string[] = [];
  const held: HeldInstruction[] = [];
  const wasEscalated = ledger.currentPackage?.status === "escalated";

  applyOps(ledger, turn.ledgerOps, now, events);

  // 僵局處置：必須先選一條路，才能再派施工指令
  let escalationResolved = false;
  if (wasEscalated && turn.escalationDecision && typeof turn.escalationDecision === "object") {
    const d = turn.escalationDecision as Record<string, unknown>;
    const choice = str(d.choice) as EscalationChoice;
    const reason = clip(str(d.reason) || "未註明", LEDGER_LIMITS.noteMaxChars);
    const pkg = ledger.currentPackage!;
    if (choice === "park") {
      const item = ledger.items.find((i) => i.id === pkg.itemId);
      if (item) {
        item.status = "parked";
        item.parkedReason = reason;
        const trig = str(d.resumeTrigger);
        if (trig) item.resumeTrigger = clip(trig, LEDGER_LIMITS.noteMaxChars);
        item.updatedAt = now;
      }
      if (ledger.currentItemId === pkg.itemId) ledger.currentItemId = null;
      ledger.currentPackage = null;
      events.push(`僵局處置：暫停 ${pkg.itemId}（${clip(reason, 80)}）`);
      escalationResolved = true;
    } else if (choice === "narrow" || choice === "alternate") {
      // 需要搭配新的 workPackage；沒有就維持僵局
      if (turn.workPackage) {
        events.push(`僵局處置：${choice === "narrow" ? "縮小範圍" : "換做法"}（${clip(reason, 80)}）`);
        escalationResolved = true;
      }
    }
  }

  // 驗收判定：針對本回合開始時的工作包，先判再裝新包，否則「通過＋下一包」會判到新包上
  const verdict = str(turn.verdict) as LedgerVerdict;
  const newPkgItemId =
    turn.workPackage && typeof turn.workPackage === "object"
      ? str((turn.workPackage as Record<string, unknown>).itemId)
      : "";
  const judged = ledger.currentPackage;
  if (
    judged &&
    !wasEscalated &&
    judged.status !== "accepted" &&
    (verdict === "accept" || verdict === "reject")
  ) {
    judged.updatedAt = now;
    if (verdict === "accept") {
      judged.status = "accepted";
      events.push(`工作包 ${judged.id} 驗收通過`);
      const item = ledger.items.find((i) => i.id === judged.itemId);
      const conclusion = str(turn.conclusion);
      // 同回合替同一項目開新工作包＝項目還沒做完，只結工作包
      if (item && item.status !== "done" && newPkgItemId !== item.id) {
        completeItem(ledger, item, conclusion, now, events);
      } else if (item && item.status === "done" && conclusion && !item.conclusion) {
        item.conclusion = clip(conclusion, LEDGER_LIMITS.conclusionMaxChars);
      }
    } else {
      judged.rejectCount += 1;
      const reason = clip(str(turn.verdictReason), LEDGER_LIMITS.noteMaxChars);
      if (reason) judged.lastRejectReason = reason;
      if (judged.rejectCount >= LEDGER_LIMITS.rejectEscalateAt) {
        judged.status = "escalated";
        events.push(`工作包 ${judged.id} 已退回 ${judged.rejectCount} 次 → 進入僵局處置`);
      } else {
        judged.status = "executing";
        events.push(`工作包 ${judged.id} 退回第 ${judged.rejectCount} 次${reason ? `：${clip(reason, 60)}` : ""}`);
      }
    }
  }

  // 目前項目已結案 → 自動接路線圖下一項
  const curItem = ledger.items.find((i) => i.id === ledger.currentItemId);
  if (curItem?.status === "done") {
    const next = pickNextItem(ledger);
    if (next) {
      ledger.currentItemId = next.id;
      if (next.status === "todo" && (!newPkgItemId || newPkgItemId === next.id)) {
        next.status = "in_progress";
        next.updatedAt = now;
      }
      events.push(`自動接下一項 ${next.id}「${clip(next.title, 40)}」`);
    } else {
      ledger.currentItemId = null;
      events.push("路線圖項目全部完成");
    }
    if (ledger.currentPackage?.status === "accepted") ledger.currentPackage = null;
  }

  if (
    turn.workPackage &&
    typeof turn.workPackage === "object" &&
    (ledger.currentPackage?.status !== "escalated" || escalationResolved)
  ) {
    // 同 ID 重新下發（未驗收、非僵局處置換包）沿用退回次數與起始時間，否則僵局保護會被歸零繞過
    const prev = ledger.currentPackage;
    const sameOpen =
      !escalationResolved &&
      prev !== null &&
      prev.status !== "accepted" &&
      prev.id === str((turn.workPackage as Record<string, unknown>).id);
    const pkg = normalizePackage(
      {
        ...(turn.workPackage as Record<string, unknown>),
        rejectCount: sameOpen ? prev.rejectCount : 0,
        status: "executing",
        createdAt: sameOpen ? prev.createdAt : now,
        updatedAt: now,
      },
      now,
    );
    if (pkg && (!isLedgerActive(ledger) || ledger.items.some((i) => i.id === pkg.itemId))) {
      ledger.currentPackage = pkg;
      if (isLedgerActive(ledger) && ledger.currentItemId !== pkg.itemId) {
        ledger.currentItemId = pkg.itemId;
        const item = ledger.items.find((i) => i.id === pkg.itemId);
        if (item && (item.status === "todo" || item.status === "parked")) {
          item.status = "in_progress";
          delete item.parkedReason;
          item.updatedAt = now;
        }
      }
      events.push(`新工作包 ${pkg.id}（${pkg.itemId}）：${clip(pkg.goal, 80)}`);
    } else if (pkg) {
      events.push(`工作包 ${pkg.id} 的 itemId「${pkg.itemId}」不在帳本中，已忽略`);
    }
  }

  const escalated = ledger.currentPackage?.status === "escalated" && !escalationResolved;

  const active = isLedgerActive(ledger);
  const scopeItemId = ledger.currentPackage?.itemId ?? ledger.currentItemId;
  const allowedInstructions: unknown[] = [];
  for (const ins of turn.instructions) {
    const text = instructionText(ins);
    if (!text) continue;
    const itemId = instructionItemId(ins);
    if (isIrreversibleInstruction(text)) {
      held.push({ text: clip(text, 400), itemId, reason: "不可逆動作（部署／push／正式資料庫）需發起人批准" });
      continue;
    }
    if (escalated) {
      held.push({ text: clip(text, 400), itemId, reason: "工作包僵局中，需先做 escalationDecision" });
      continue;
    }
    if (active && itemId && scopeItemId && !isWithinItem(ledger, itemId, scopeItemId)) {
      held.push({ text: clip(text, 400), itemId, reason: `不屬於目前項目 ${scopeItemId}；請先用 setCurrent 切換` });
      continue;
    }
    allowedInstructions.push(ins);
  }
  // 報告需求是唯讀蒐證；僵局時仍允許（例如要 Cursor 交卡關說明）
  const allowedReportRequests = turn.reportRequests.filter((r) => {
    const text = instructionText(r);
    if (text && isIrreversibleInstruction(text)) {
      held.push({ text: clip(text, 400), itemId: instructionItemId(r), reason: "不可逆動作需發起人批准" });
      return false;
    }
    return true;
  });

  if (held.length) events.push(`保留 ${held.length} 項指令未派送`);

  ledger.lastHostTurn = {
    at: now,
    instructions: allowedInstructions
      .map((x) => clip(instructionText(x), LEDGER_LIMITS.lastTurnEachMaxChars))
      .slice(0, LEDGER_LIMITS.lastTurnMaxItems),
    reportRequests: allowedReportRequests
      .map((x) => clip(instructionText(x), LEDGER_LIMITS.lastTurnEachMaxChars))
      .slice(0, LEDGER_LIMITS.lastTurnMaxItems),
    held: held.slice(0, LEDGER_LIMITS.lastTurnMaxItems).map((h) => ({
      ...h,
      text: clip(h.text, LEDGER_LIMITS.lastTurnEachMaxChars),
    })),
  };
  if (events.length) {
    const line = `${stamp(now)} ${events.join("；")}`;
    ledger.log = [...ledger.log, clip(line, 200)].slice(-LEDGER_LIMITS.logMax);
  }

  return { ledger, allowedInstructions, allowedReportRequests, held, events, escalated };
}

// ─── 注入給主持人的文字 ───────────────────────────────────────────

function renderItems(ledger: StrategyLedger): string {
  const children = new Map<string, LedgerItem[]>();
  const roots: LedgerItem[] = [];
  const ids = new Set(ledger.items.map((i) => i.id));
  for (const it of ledger.items) {
    if (it.parentId && ids.has(it.parentId)) {
      const arr = children.get(it.parentId) ?? [];
      arr.push(it);
      children.set(it.parentId, arr);
    } else {
      roots.push(it);
    }
  }
  const line = (it: LedgerItem, depth: number) => {
    const cur = ledger.currentItemId === it.id ? " ◀ 目前" : "";
    const extra = [
      it.conclusion ? `結論：${clip(it.conclusion, 300)}` : "",
      it.note ? `備註：${it.note}` : "",
      it.parkedReason ? `暫停原因：${it.parkedReason}` : "",
      it.resumeTrigger ? `恢復點：${it.resumeTrigger}` : "",
    ]
      .filter(Boolean)
      .join("｜");
    return `${"  ".repeat(depth)}- [${it.id}] ${it.title} — ${STATUS_LABEL[it.status]}${cur}${extra ? `（${extra}）` : ""}`;
  };
  const out: string[] = [];
  const walk = (it: LedgerItem, depth: number) => {
    out.push(line(it, depth));
    for (const c of children.get(it.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out.join("\n");
}

/** 精簡會議室用：一行專案錨點（目前項目＋工作包），讓換模型或歷史變短時不會忘記做到哪 */
export function renderLedgerAnchor(ledger: StrategyLedger): string {
  const item = ledger.items.find((i) => i.id === ledger.currentItemId);
  const pkg = ledger.currentPackage;
  const parts: string[] = [];
  if (ledger.brief) parts.push(`主題：${clip(ledger.brief.topic, 80)}`);
  if (isLedgerActive(ledger)) {
    const done = ledger.items.filter((i) => i.status === "done").length;
    parts.push(`路線圖 ${done}/${ledger.items.length} 完成`);
  }
  if (item) parts.push(`目前項目：${item.id}「${clip(item.title, 60)}」（${STATUS_LABEL[item.status]}）`);
  if (item && !pkg) parts.push("⚠ 目前項目沒有工作包：本回合要輸出 workPackage 並下指令給 Cursor");
  if (pkg) {
    parts.push(`工作包：${clip(pkg.goal, 120)}`);
    if (pkg.acceptance.length) parts.push(`驗收：${clip(pkg.acceptance.join("；"), 160)}`);
    if (pkg.status === "escalated") parts.push("⚠ 已退回 2 次：本回合必須決定縮小範圍、換做法或暫停（escalationDecision）");
  }
  return parts.length ? `# 專案錨點\n${parts.join("｜")}` : "";
}

/** 每回合固定放在脈絡最前面 */
export function renderLedgerForHost(ledger: StrategyLedger): string {
  const parts: string[] = ["# 主線帳本（程式保存，以此為準；不要憑記憶推測進度）"];
  const brief = ledger.brief;
  if (brief) {
    parts.push(
      [
        `## 專案簡介\n主題：${brief.topic}`,
        brief.problems.length ? `問題：${brief.problems.join("；")}` : "",
        brief.requirements.length ? `需求：${brief.requirements.join("；")}` : "",
        brief.constraints.length ? `限制：${brief.constraints.join("；")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (!isLedgerActive(ledger)) {
    parts.push(
      "## 尚未排路線圖\n討論出主題、問題與需求後，同一回合輸出 setBrief 與路線圖（多個 add，依執行順序），再 setCurrent 第一項並給 workPackage。討論還不夠時先問使用者，不要急著排。",
    );
  } else {
    if (!brief) parts.push("## ⚠ 尚無專案簡介\n本回合請用 setBrief 補上主題／問題／需求／限制。");
    const done = ledger.items.filter((i) => i.status === "done").length;
    parts.push(`## 路線圖（${done}/${ledger.items.length} 完成）\n${renderItems(ledger)}`);
  }
  const pkg = ledger.currentPackage;
  const curItem = ledger.items.find((i) => i.id === ledger.currentItemId);
  if (curItem && !pkg) {
    parts.push(
      `## ⚠ 目前項目 ${curItem.id} 沒有工作包（本回合必做）\n輸出 workPackage（itemId:"${curItem.id}"），並把可執行的交付命令寫進 instructions。只寫在回覆裡、instructions 留空，Cursor 不會開工。`,
    );
  } else if (isLedgerActive(ledger) && !curItem && pickNextItem(ledger)) {
    parts.push("## ⚠ 沒有目前項目\n用 setCurrent 選路線圖下一項並給 workPackage。");
  }
  if (pkg) {
    parts.push(
      [
        `## 目前工作包 ${pkg.id}（項目 ${pkg.itemId}）｜狀態：${pkg.status}｜已退回 ${pkg.rejectCount}/${LEDGER_LIMITS.rejectEscalateAt} 次`,
        `目標：${pkg.goal}`,
        pkg.scope.length ? `範圍：${pkg.scope.join("；")}` : "",
        pkg.acceptance.length ? `驗收條件：${pkg.acceptance.join("；")}` : "",
        pkg.stopConditions.length ? `停止條件：${pkg.stopConditions.join("；")}` : "",
        pkg.lastRejectReason ? `上次退回原因：${pkg.lastRejectReason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (pkg.status === "escalated") {
      parts.push(
        `## ⚠ 僵局處置（本回合必做）
此工作包已退回 ${pkg.rejectCount} 次。本回合不得再對同一工作包下修補指令（會被程式攔下）。
必須輸出 escalationDecision：{"choice":"narrow|alternate|park","reason":"…","resumeTrigger":"park 時填恢復點"}。
- narrow：縮小範圍，同時輸出新的 workPackage，並把交付命令寫進 instructions（只寫在回覆裡不會派送）
- alternate：換做法，同時輸出新的 workPackage，並把交付命令寫進 instructions
- park：暫停此項，回到主線下一個項目；若下一項要開工，同樣要有 workPackage 與 instructions
資訊不足時可先用 reportRequests 要 Cursor 交「卡關說明」（≤2000 字：卡在哪、試過什麼、可選方案）。`,
      );
    }
  }
  const last = ledger.lastHostTurn;
  if (last && (last.instructions.length || last.reportRequests.length || last.held.length)) {
    parts.push(
      [
        "## 你上一回合下的指令",
        ...last.instructions.map((s) => `- 指令：${s}`),
        ...last.reportRequests.map((s) => `- 報告需求：${s}`),
        ...last.held.map((h) => `- 被保留未派送：${h.text}（${h.reason}）`),
      ].join("\n"),
    );
  }
  if (ledger.log.length) parts.push(`## 帳本最近變更\n${ledger.log.slice(-5).map((l) => `- ${l}`).join("\n")}`);
  return parts.join("\n\n");
}

/** 附在 system 尾端的協定（不寫進範本，DB 自訂範本也一律套用） */
export function ledgerProtocolBlock(): string {
  return `## 主線帳本協定（程式強制）
你是規劃與驗收者，不是逐行審碼者。Cursor 負責實作、自測與自行審碼。進度由你推動，使用者不必勾選。
- 會議流程：①討論期：和使用者釐清主題、問題、需求。②排路線圖：討論夠了就在同一回合輸出 setBrief＋多個 add（依執行順序，一項＝一個可驗收的階段或問題）＋setCurrent 第一項＋workPackage＋instructions。③逐項執行：Cursor 做完交報告 → 你驗收 → 通過就結案並接下一項。④全部完成後總結。
- 進度以「主線帳本」為準。改帳本只能用 ledgerOps（每回合最多 ${LEDGER_LIMITS.opsPerTurnMax} 個）：
  [{"op":"setBrief","topic":"…","problems":["…"],"requirements":["…"],"constraints":["…"]},
   {"op":"add","id":"P1","title":"…","parentId":"…"},{"op":"setCurrent","id":"…"},
   {"op":"complete","id":"…","conclusion":"…"},
   {"op":"setStatus","id":"4A","status":"todo|in_progress|parked|blocked","note":"…"},
   {"op":"park","id":"…","reason":"…","resumeTrigger":"…"},{"op":"resume","id":"…"}]
- 派工（要 Cursor 做事時必做）：可見回覆只准兩段——短「判定」（最多 5 行）＋「交付命令」。同一條交付命令必須原文寫進 instructions（至少一條）。Cursor 只執行 instructions。若 instructions 留空或過短，平台會用可見交付命令／工作包補派，路線圖才能繼續。禁止只給結語或方向，也禁止「請依下列／接續這項／先補證據」卻不寫出命令本身。
- 交付命令／instructions 一次寫完整，讓 Cursor 不用再問就能做完交報告：具體路徑或模組、要跑的指令、這次不做的事、可用輸出判定的驗收。每條驗收要有固定輸入、比對欄位、程序邊界、數字或狀態。禁止用「完整／正確／足夠／釐清／接續」當條件。
- 暫扣只給真的 git push／vercel --prod／部署到正式／正式資料庫寫入。本機改碼、測試、持久化例外、副本掛接不要標成不可逆。
- 驗收通過（verdict "accept"）時必填 "conclusion"（放在判定段，3–5 行：做了什麼、驗收結果、數字、這次不代表什麼）。程式會結案並切到下一項；同一回合必須給下一項 workPackage 與對應交付命令。workPackage：{"id":"wp-…","itemId":"目前項目 id","goal":"…","scope":["允許改的檔案／模組"],"acceptance":["可用測試輸出判定的條件，不要形容詞"],"stopConditions":["遇到就停下回報的情況"]}。一個工作包要能一次做完再回報。
- 還差一項：帳本用 verdict "reject"（附 verdictReason）＋一條修正命令，把要改的點和要重測的證據寫完。可見回覆禁止寫「不通過」「待改碼」「await_code」，改寫「還差：一句話」然後接交付命令；phase 必須填 reviewing。有 instructions 時禁止把 phase 設成 await_code，那個階段會讓 Cursor 停下來等使用者。同一工作包退回 ${LEDGER_LIMITS.rejectEscalateAt} 次會進入僵局；僵局時 narrow／alternate 也要新 workPackage 加非空 instructions。
- 本回合訊息來自 Cursor 時必須派工（accept 接下一項、reject 一條修正、或 reportRequests 指名缺的證據）。不要只回覆使用者。
- instructions 可寫字串或 {"itemId":"…","text":"…"}；itemId 與目前項目不同會被保留不派送。只有 git push／vercel --prod／部署到正式／正式資料庫寫入保留給發起人。
- 要看程式碼時，指名函式或行號範圍（每段 ≤150 行）；不要要求整份檔案。
- 「做到哪裡」直接引用帳本；帳本沒寫的就說不知道，請 Cursor 用 git／報告查證。`;
}

/** 給人看的進度表（API 回應用） */
export function renderLedgerForHuman(ledger: StrategyLedger): string {
  if (!isLedgerActive(ledger)) return "";
  const pkg = ledger.currentPackage;
  const done = ledger.items.filter((i) => i.status === "done").length;
  return [
    ledger.brief ? `主題：${ledger.brief.topic}` : "",
    `路線圖 ${done}/${ledger.items.length} 完成`,
    renderItems(ledger),
    pkg ? `\n目前工作包：${pkg.id}（${pkg.itemId}）${pkg.goal}｜${pkg.status}｜退回 ${pkg.rejectCount} 次` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
