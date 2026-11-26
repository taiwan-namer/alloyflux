import { cloudDbProxy } from "@/lib/cloud-api";
import { NoSourceError, routeChat } from "@/lib/gateway";
import { findModel, type ModelInfo } from "@/lib/models";
import { authenticateStrategyActor } from "@/lib/platform-api-auth";
import { isAbortError, type ChatMessage } from "@/lib/providers";
import {
  addUserMessage,
  balance,
  createConversation,
  settleAssistantMessage,
} from "@/lib/store";
import { absorbStrategyRoomMemory, formatStrategyRoomMemory } from "@/lib/strategy-room-memory";
import {
  STRATEGY_STREAM_HEADERS,
  StrategyJsonTailBuffer,
  encodeNdjson,
  readPartialJsonStringField,
} from "@/lib/strategy-stream";
import {
  STRATEGY_STATE_DELIMITER,
  STREAM_REPLY_EMPTY_RULE,
  type StrategyTemplate,
} from "@/lib/strategy-templates";
import { after } from "next/server";
import {
  acquireTurnLock,
  refreshTurnLock,
  releaseTurnLock,
  addDispatchItems,
  addSessionMessage,
  buildReportInjection,
  buildWorkspaceBrief,
  countCursorTurnsSinceWeb,
  parseLeanTurnType,
  readRoomMode,
  type LeanTurnType,
  ensureDefaultWorkspace,
  extractJsonObject,
  getStrategySession,
  getStrategyTemplateById,
  getStrategyWorkspace,
  listRunsForSession,
  listSessionDispatch,
  listSessionMessages,
  listSessionMessagesPage,
  listSessionReports,
  mergeDossier,
  queryRoomContent,
  readDossier,
  leadStreamWatchdog,
  resolveSessionMembers,
  selectStrategyHistory,
  STRATEGY_LIMITS,
  STRATEGY_SESSION_STATUSES,
  updateStrategySession,
  type SessionMember,
  type StrategyMessageCompletionStatus,
  type StrategySession,
  type StrategySessionStatus,
} from "@/lib/strategy-loop";
import {
  applyLedgerTurn,
  fillInstructionsFromDelivery,
  ledgerProtocolBlock,
  readLedger,
  renderLedgerAnchor,
  renderLedgerForHost,
  type HeldInstruction,
} from "@/lib/strategy-ledger";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const L = STRATEGY_LIMITS;
const ADVISOR_BUDGET_MS = 180_000;

type RoomQueryResult = { roomId: string; roomName: string; question: string; snippet: string };

type DoneBill = {
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  officialCostPoints: number;
  chargedPoints: number;
  sourceId: string;
  jobId?: string;
};

function budgetJoin(parts: string[], max: number): string {
  let out = "";
  for (const p of parts) {
    if (out.length + p.length > max) break;
    out += p;
  }
  return out;
}

function readRoomQueryResults(meta: Record<string, unknown>): RoomQueryResult[] {
  const raw = meta.roomQueryResults;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is RoomQueryResult => !!r && typeof r === "object" && typeof (r as RoomQueryResult).snippet === "string",
  );
}

function limitsBlock(): string {
  return `## 資料量限制（很重要）
- 平台每回合只看得到：主線帳本、dossier（≤${L.dossierMaxChars} 字）、你上一回合之後新上傳的報告正文（同系列 _p1/_p2 自動合併，合計 ≤${L.reportsInjectMaxChars} 字）、最近幾則對話。
- 舊報告只有索引；需要再看時在 JSON 填 "reportFocus": ["srep_…"]（最多 ${L.reportFocusMax} 份），下一回合注入正文。
- Cursor 單則訊息 ≤${L.messageMaxChars} 字；單份報告 ≤${L.reportMaxChars} 字。
- 不要要求貼原始 K 線／完整 fills／decision_trace；只要本機彙總。
- 重要結論寫進 memoryUpdates；summary ≤${L.summaryMaxChars} 字；roomQueries 每回合最多 ${L.roomQueriesPerTurn} 個。`;
}

function leanSopBlock(): string {
  return `## 工作 SOP（精簡會議室，必須遵守）
你負責規劃與驗收，不看程式碼；程式碼由 Cursor 在本機讀取、對齊與修改。
1. 了解：依使用者描述與 Cursor 的架構報告理解專案。資訊不足時，用一個 reportRequests 請 Cursor 交架構摘要（不要原始碼）。
2. 下指令：可見回覆先寫最多 5 行判定，接著寫交付命令；命令原文同時放進 instructions（至少一條，最多 5 條）。只寫在回覆、instructions 留空，Cursor 不會做。命令要含目標、範圍、這次不做的事、可用測試輸出判定的驗收；禁止只寫「請依下列／接續／先補證據」。同時輸出 workPackage（itemId、goal、scope、acceptance）。不指定逐行改法。
3. 對齊：Cursor 回報「對齊有問題」時，只針對那個問題給一條交付命令，不重新規劃整個專案。
4. 驗收：Cursor 交「最終報告」時對照驗收標準判定。通過 → verdict "accept"＋conclusion（放在判定段），同回合給下一項 workPackage 與交付命令。還差一項 → 帳本 verdict "reject"＋verdictReason，可見回覆寫「還差」加一條修正命令，phase 填 reviewing。禁止寫「不通過」或把 phase 設成 await_code，那會讓 Cursor 停下來等人。
5. 使用者要求復盤時，再總結得失。
禁止：要求原始碼或拆段上傳；擴大範圍（新點子寫在 reply 的「建議清單」，不要下成指令）；只為了確認而要求額外報告；部署、git push、正式資料庫寫入一律寫成「待發起人批准」。
reply 控制在 800 字內。項目完成或要換下一項時，用 ledgerOps（setStatus／setCurrent）更新帳本。`;
}

function jsonOnlySystem(template: StrategyTemplate, lean: boolean): string {
  if (lean) {
    return `${template.systemPrompt}\n\n${leanSopBlock()}\nJSON 物件可另含欄位：ledgerOps, workPackage, verdict, verdictReason, conclusion, escalationDecision。\n可見回覆只寫「判定」（最多 5 行）和「交付命令」，命令原文同時放入 instructions。寫完後單獨一行輸出 ${STRATEGY_STATE_DELIMITER}，再輸出 JSON。\n${STREAM_REPLY_EMPTY_RULE}`;
  }
  return `${template.systemPrompt}\n\n${limitsBlock()}\n\n${ledgerProtocolBlock()}\nJSON 物件可另含欄位：ledgerOps, workPackage, verdict, verdictReason, conclusion, escalationDecision, reportFocus。\n可見回覆只寫「判定」（最多 5 行）和「交付命令」，命令原文同時放入 instructions。寫完後單獨一行輸出 ${STRATEGY_STATE_DELIMITER}，再輸出 JSON。\n${STREAM_REPLY_EMPTY_RULE}`;
}

function streamLeadSystem(template: StrategyTemplate, lean: boolean): string {
  return `${template.streamLeadPreface}

${lean ? leanSopBlock() : `${limitsBlock()}\n\n${ledgerProtocolBlock()}`}

結構化 JSON 欄位必須包含：reply, phase, instructions, reportRequests, memoryUpdates, canStartRun, openQuestions, summary, roomQueries；需要時另加 ledgerOps, workPackage, verdict, verdictReason, conclusion, escalationDecision${lean ? "" : ", reportFocus"}。
分隔標記必須單獨一行：${STRATEGY_STATE_DELIMITER}
要 Cursor 做事時，分隔線前只寫「判定」（最多 5 行）和「交付命令」，命令原文放入 instructions。
${STREAM_REPLY_EMPTY_RULE}`;
}

function advisorSystem(label: string): string {
  return `你是會議室顧問「${label}」。用繁體中文給出精簡審查意見（風險、漏洞、可執行建議）。只要純文字，不要 JSON、不要程式碼圍欄、不要分隔標記。控制在 400 字內。`;
}

async function buildContextBlock(
  authUserId: string,
  session: StrategySession,
  fromWeb: boolean,
  lean = false,
): Promise<{ contextBlock: string; dossier: ReturnType<typeof readDossier> }> {
  const dossier = readDossier(session.meta);
  const ledger = readLedger(session.meta);
  const roomMemory = formatStrategyRoomMemory(session.meta, session.id);
  const memoryBlock = roomMemory ? `## 會議室記憶（狀態筆記與較早對話摘要）\n${roomMemory}` : "";
  // 工作包驗收前，期間上傳的交付一直注入；否則中間多一回合（重送、網頁發言）報告就只剩索引
  const pkg = ledger.currentPackage;
  const packageSince = pkg && pkg.status !== "accepted" ? pkg.createdAt : 0;
  const sourceBlock = fromWeb
    ? "## 發言來源\n本回合訊息來自：使用者（網頁）"
    : "## 發言來源\n本回合訊息來自：Cursor。可見回覆只能是「判定」（最多 5 行）加「交付命令」。交付命令全文同時寫進 instructions。若 instructions 留空，平台會用交付命令或下一項 workPackage 補成派工，路線圖繼續。禁止只給結語、方向，或「請依下列／接續／先補證據」。通過就接下一項 workPackage 與命令。還差就寫「還差」加一條修正命令，phase 填 reviewing；禁止寫「不通過」或 phase=await_code，那會讓 Cursor 停下等人。";

  if (lean) {
    // 像一般聊天：只有專案錨點＋上一回合之後／本工作包期間上傳的報告，其餘全靠對話紀錄
    const fresh = await listSessionReports(authUserId, session.id, 10);
    const { bodies } = buildReportInjection(fresh, {
      lastHostTurnAt: ledger.lastHostTurn?.at ?? 0,
      focusIds: [],
      packageSince,
    });
    const contextBlock = [
      renderLedgerAnchor(ledger),
      memoryBlock,
      bodies ? `## 上一回合之後／本工作包期間 Cursor 上傳的報告${bodies}` : "",
      sourceBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { contextBlock, dossier };
  }

  const reports = await listSessionReports(authUserId, session.id, 30);
  const runs = await listRunsForSession(authUserId, session.id, 3);
  const { text: workspaceBrief } = await buildWorkspaceBrief(authUserId, session.workspaceId, {
    excludeSessionId: session.id,
  });
  const queryResults = readRoomQueryResults(session.meta);
  const awaitingApproval = session.autoDispatch
    ? []
    : (await listSessionDispatch(authUserId, session.id, 50)).filter((d) => d.status === "pending");

  const { bodies: reportBodies, index: reportIndex } = buildReportInjection(reports, {
    lastHostTurnAt: ledger.lastHostTurn?.at ?? 0,
    focusIds: readReportFocus(session.meta),
    packageSince,
  });
  const runBodies = budgetJoin(
    runs.map(
      (r) =>
        `\n- run ${r.id} profile=${r.profileId} metrics=${JSON.stringify(r.metrics)}\n${(r.reviewExcerpt || "").slice(0, 2500)}\n`,
    ),
    L.runsInjectMaxChars,
  );
  const queryBodies = queryResults
    .map((q) => `\n### 查詢 ${q.roomName}（${q.roomId}）：${q.question}\n${q.snippet}\n`)
    .join("");

  const contextBlock = [
    renderLedgerForHost(ledger),
    workspaceBrief,
    `# 會議室 ${session.name}（${session.id}）｜phase=${session.status}${session.topic ? `｜主題：${session.topic}` : ""}`,
    session.summary ? `## 本會議室上一版摘要\n${session.summary}` : "",
    queryBodies ? `## 上一回合 roomQueries 的結果${queryBodies}` : "",
    memoryBlock,
    `## 策略檔案夾 dossier\n${JSON.stringify(dossier)}`,
    // 帳本已列「你上一回合下的指令」時不重複
    ledger.lastHostTurn
      ? ""
      : `## 已派給 Cursor 的待辦\n${JSON.stringify(session.pendingInstructions).slice(0, 3000)}`,
    awaitingApproval.length
      ? `## 等待使用者確認派送的指令（${awaitingApproval.length} 項）\n${JSON.stringify(awaitingApproval.map((d) => d.instruction)).slice(0, 2000)}`
      : "",
    reportIndex
      ? `## 報告索引（正文未注入；要看就填 reportFocus）\n${reportIndex}`
      : reports.length
        ? ""
        : "## 尚未收到任何報告",
    reportBodies ? `## 上一回合之後的新報告／本工作包期間的交付／指名報告${reportBodies}` : "",
    runBodies ? `## 已掛載 run${runBodies}` : "",
    sourceBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { contextBlock, dossier };
}

async function buildUpstream(
  authUserId: string,
  sessionId: string,
  contextBlock: string,
  content: string,
  includeCurrentUserInHistory: boolean,
  lastHostTurnAt: number,
  lean = false,
): Promise<ChatMessage[]> {
  // 起點對齊整房絕對序號的格線，連續幾回合開頭相同才吃得到 prompt cache
  const page = await listSessionMessagesPage(authUserId, sessionId, { limit: L.historyFetchLimit });
  const fetched = page.messages;
  const offset = Math.max(0, page.total - fetched.length);
  const bounded = selectStrategyHistory(
    fetched,
    lean
      ? {
          offset,
          minKeep: L.leanHistoryMinMessages,
          maxChars: L.leanHistoryCharBudget,
          olderAssistantMaxChars: L.leanOlderAssistantMaxChars,
        }
      : { offset },
  );
  const upstream: ChatMessage[] = bounded.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const notes = fetched
    .filter((m) => m.structured?.kind === "note" && m.createdAt > lastHostTurnAt)
    .slice(-L.notesInjectMax)
    .map((m) => `- ${m.content.length > L.noteInjectMaxChars ? `${m.content.slice(0, L.noteInjectMaxChars)}…` : m.content}`);
  const block = notes.length
    ? `${contextBlock}\n\n## 上一回合之後 Cursor 的通知（未觸發回合）\n${notes.join("\n")}`
    : contextBlock;

  if (includeCurrentUserInHistory) {
    const last = upstream[upstream.length - 1];
    if (last?.role === "user") {
      last.content = `${block}\n\n---\n# 本回合訊息\n${last.content}`;
    }
  } else {
    upstream.push({
      role: "user",
      content: `${block}\n\n---\n# 本回合訊息\n${content}`,
    });
  }
  return upstream;
}

const DUPLICATE_WINDOW_MS = 15 * 60_000;

/** Cursor 重送同一則訊息（補送／重試）且上次已有主持人回覆 → 直接回傳上次結果，不再花一回合 */
async function findRecentDuplicateTurn(userId: string, sessionId: string, content: string) {
  const recent = await listSessionMessages(userId, sessionId, 12);
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.createdAt < cutoff) break;
    if (m.role !== "user" || m.structured?.kind === "note" || m.content.trim() !== content) continue;
    const reply = recent
      .slice(i + 1)
      .find((x) => x.role === "assistant" && x.structured?.kind !== "advisor");
    return reply ?? null;
  }
  return null;
}

const WEB_REPEAT_WINDOW_MS = 2 * 60_000;

/** 網頁短時間內重送一字不差的同一句、且上次已有完整回覆（畫面像卡住時重按）：不再多跑一回合 */
async function findRecentWebRepeat(userId: string, sessionId: string, content: string): Promise<boolean> {
  const recent = await listSessionMessages(userId, sessionId, 12);
  const cutoff = Date.now() - WEB_REPEAT_WINDOW_MS;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.createdAt < cutoff) break;
    if (m.role !== "user" || m.structured?.source !== "web" || m.structured?.kind === "note") continue;
    if (m.content.trim() !== content) continue;
    // 上次失敗／中斷就讓使用者重送
    return recent
      .slice(i + 1)
      .some(
        (x) =>
          x.role === "assistant" &&
          x.structured?.kind !== "advisor" &&
          x.completionStatus !== "failed" &&
          x.completionStatus !== "aborted",
      );
  }
  return false;
}

function readReportFocus(meta: Record<string, unknown>): string[] {
  const raw = meta.reportFocus;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.startsWith("srep_")).slice(0, L.reportFocusMax);
}

function parseAssistantStructured(
  answer: string,
  session: StrategySession,
  dossier: ReturnType<typeof readDossier>,
  contextChars: number,
  opts?: { visibleText?: string },
) {
  const parsed = extractJsonObject(answer) || {};
  const fromJson = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  const visible = (opts?.visibleText ?? "").trim();
  // stream：可見正文優先；允許 JSON reply 為 ""；非 stream：維持 JSON reply → 全文切片
  const reply = visible || fromJson || answer.slice(0, 4000);
  const instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
  const reportRequests = Array.isArray(parsed.reportRequests) ? parsed.reportRequests : [];
  const openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [];
  const canStartRun = Boolean(parsed.canStartRun ?? parsed.canStartNextRun);

  const proposed = String(parsed.phase ?? parsed.status ?? "");
  let nextStatus: StrategySessionStatus = STRATEGY_SESSION_STATUSES.includes(proposed as StrategySessionStatus)
    ? (proposed as StrategySessionStatus)
    : session.status;
  if (canStartRun) {
    nextStatus = ["discovery", "designing", "ready_to_run"].includes(session.status)
      ? "ready_to_run"
      : "ready_next_run";
  }
  // 有命令就要 Cursor 接著做。await_code 會讓它停下來等使用者。
  if (nextStatus === "await_code" && instructions.length > 0) nextStatus = "reviewing";

  const nextDossier = mergeDossier(dossier, parsed.memoryUpdates);
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const roomQueries = Array.isArray(parsed.roomQueries) ? parsed.roomQueries.slice(0, L.roomQueriesPerTurn) : [];

  return {
    parsed,
    reply,
    instructions,
    reportRequests,
    openQuestions,
    nextStatus,
    nextDossier,
    summary,
    roomQueries,
    contextChars,
  };
}

async function resolveTemplateForSession(userId: string, session: StrategySession): Promise<StrategyTemplate> {
  if (session.templateId) return getStrategyTemplateById(session.templateId);
  if (session.workspaceId) {
    const ws = await getStrategyWorkspace(userId, session.workspaceId);
    if (ws?.templateId) return getStrategyTemplateById(ws.templateId);
  }
  return getStrategyTemplateById("automax");
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticateStrategyActor(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const fromWeb = auth.via === "session";

  const { id: sessionId } = await ctx.params;
  let session = await getStrategySession(auth.user.id, sessionId);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  if (!session.workspaceId) {
    await ensureDefaultWorkspace(auth.user.id);
    session = (await getStrategySession(auth.user.id, sessionId))!;
  }
  if (session.status === "closed") {
    return Response.json({ error: "Session closed" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    content?: string;
    model?: string;
    stream?: boolean;
    /** 只存成通知、不觸發主持人回合；下一回合以「Cursor 的通知」段落帶入 */
    noReply?: boolean;
    /** 精簡會議室：Cursor 只有 align（對齊有問題）／report（最終報告）才觸發主持人 */
    turnType?: string;
  };
  const content = (body.content || "").trim();
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  const lean = readRoomMode(session.meta) === "lean";
  const maxChars = lean ? L.leanMessageMaxChars : L.messageMaxChars;
  if (content.length > maxChars) {
    return Response.json(
      {
        error: `訊息 ${content.length} 字，超過上限 ${maxChars} 字；長內容請改用報告上傳（/report）`,
        limits: L,
      },
      { status: 413 },
    );
  }

  const turnType = parseLeanTurnType(body.turnType);
  const saveNote = async (gated?: string) => {
    await addSessionMessage({
      sessionId,
      userId: auth.user.id,
      role: "user",
      content,
      structured: { source: fromWeb ? "web" : "cursor", kind: "note", ...(gated ? { gated } : {}) },
    });
    return Response.json({
      ok: true,
      noted: true,
      ...(gated ? { gated } : {}),
      session: await getStrategySession(auth.user.id, sessionId),
    });
  };

  if (body.noReply === true) return saveNote();

  if (lean && !fromWeb) {
    if (!turnType) return saveNote("not_turn_type");
    const recent = await listSessionMessages(auth.user.id, sessionId, 60);
    if (countCursorTurnsSinceWeb(recent) >= L.leanCursorTurnsPerTask) return saveNote("turn_budget");
  }

  if (!fromWeb && body.stream !== true) {
    const dup = await findRecentDuplicateTurn(auth.user.id, sessionId, content);
    if (dup) {
      return Response.json({
        session: await getStrategySession(auth.user.id, sessionId),
        assistant: { ...dup.structured, reply: dup.content, duplicate: true },
        dossier: readDossier(session.meta),
        limits: L,
      });
    }
  }

  if (fromWeb && (await findRecentWebRepeat(auth.user.id, sessionId, content))) {
    return Response.json(
      { error: "同一句剛剛已送出並回覆過；若要主持人重新處理，請換個說法或補充內容", duplicate: true },
      { status: 409 },
    );
  }

  if ((await balance(auth.user.id)) <= 0) {
    return Response.json({ error: "Insufficient credits" }, { status: 402 });
  }

  // 排隊，不拒絕。上一則還在寫就等到它收完再處理；沒心跳的鎖約一分鐘後失效。
  const lockToken = `lock_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const queued = await waitForRoomTurn(auth.user.id, sessionId, lockToken, req.signal);
  if (!queued) {
    return Response.json({ error: "aborted", aborted: true }, { status: 499 });
  }
  const heartbeat = setInterval(() => {
    void refreshTurnLock(auth.user.id, sessionId, lockToken).catch(() => {});
  }, 20_000);
  const release = () => {
    clearInterval(heartbeat);
    return releaseTurnLock(auth.user.id, sessionId, lockToken).catch((e) => {
      console.warn("[strategy-turn-lock] release failed", e instanceof Error ? e.message : e);
    });
  };

  session = (await getStrategySession(auth.user.id, sessionId)) ?? session;
  const wantStream = body.stream === true;
  const template = await resolveTemplateForSession(auth.user.id, session);
  const members = resolveSessionMembers(session).map((m) => ({ ...m }));
  if (body.model?.trim()) {
    const lead = members.find((m) => m.role === "lead");
    if (lead) lead.modelId = body.model.trim();
  }

  try {
    if (!wantStream) {
      return await handleJsonMode({
        req,
        authUserId: auth.user.id,
        fromWeb,
        session,
        sessionId,
        content,
        template,
        members,
        lean,
        turnType,
      });
    }

    let streamSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      streamSettled = resolve;
    });
    const res = await handleStreamMode({
      req,
      authUserId: auth.user.id,
      fromWeb,
      session,
      sessionId,
      content,
      template,
      members,
      lean,
      turnType,
      onSettled: async () => {
        await release();
        streamSettled();
      },
    });
    if (!res.headers.get("content-type")?.includes("ndjson")) {
      await release();
      return res;
    }
    after(() => settled);
    return res;
  } finally {
    if (!wantStream) await release();
  }
}

/** 上一則還沒結束就排隊等，等到能處理或連線中止。不回「正在回覆」把人拒掉。 */
async function waitForRoomTurn(
  userId: string,
  sessionId: string,
  token: string,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    if (await acquireTurnLock(userId, sessionId, token)) return true;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 400);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }).catch(() => undefined);
    if (signal.aborted) return false;
  }
  return acquireTurnLock(userId, sessionId, token);
}

async function handleJsonMode(opts: {
  req: Request;
  authUserId: string;
  fromWeb: boolean;
  session: StrategySession;
  sessionId: string;
  content: string;
  template: StrategyTemplate;
  members: SessionMember[];
  lean: boolean;
  turnType: LeanTurnType | null;
}) {
  const { req, authUserId, fromWeb, session, sessionId, content, template, members, lean, turnType } = opts;
  const lead = members.find((m) => m.role === "lead") ?? members[0]!;
  const model = findModel(lead.modelId) || findModel("gemini-4-neon-high");
  if (!model) return Response.json({ error: `Unknown model: ${lead.modelId}` }, { status: 400 });

  const startedAt = Date.now();
  const turnId = `turn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await addSessionMessage({
    sessionId,
    userId: authUserId,
    role: "user",
    content,
    structured: { source: fromWeb ? "web" : "cursor", turnId, ...(turnType ? { turnType } : {}) },
    createdAt: startedAt,
    turnId,
    idempotent: true,
  });

  const { contextBlock, dossier } = await buildContextBlock(authUserId, session, fromWeb, lean);
  const lastHostTurnAt = readLedger(session.meta).lastHostTurn?.at ?? 0;
  const upstream = await buildUpstream(authUserId, sessionId, contextBlock, content, true, lastHostTurnAt, lean);

  const convId = await createConversation(authUserId, `strategy-session ${session.name}`, model.id, {
    hidden: true,
  });
  await addUserMessage(convId, content, model.id);

  let answer = "";
  let doneEv: DoneBill | null = null;
  const tail = new StrategyJsonTailBuffer(STRATEGY_STATE_DELIMITER);
  let checkpointChain: Promise<void> = Promise.resolve();
  let checkpointsClosed = false;
  let pendingSnap: { text: string; status: "partial" | "ok" } | null = null;
  let checkpointFlying = false;
  const pumpCheckpoints = () => {
    if (checkpointFlying) return checkpointChain;
    checkpointFlying = true;
    checkpointChain = (async () => {
      try {
        while (pendingSnap) {
          const job = pendingSnap;
          pendingSnap = null;
          await addSessionMessage({
            sessionId,
            userId: authUserId,
            role: "assistant",
            content: job.text,
            structured: { kind: "lead", turnId, completionStatus: job.status, reply: job.text },
            createdAt: startedAt + 1,
            speakerModel: model.id,
            speakerRole: "lead",
            speakerLabel: lead.label || "主導",
            turnId,
            completionStatus: job.status,
            idempotent: true,
          });
        }
      } catch {
        /* 下一則快照會再寫 */
      } finally {
        checkpointFlying = false;
        if (pendingSnap) void pumpCheckpoints();
      }
    })();
    return checkpointChain;
  };
  const queueCheckpoint = (snapshot: string, _force = false, status: "partial" | "ok" = "partial") => {
    if (checkpointsClosed) return;
    const text = snapshot.trim();
    if (!text || text.startsWith("{") || text.startsWith("```")) return;
    pendingSnap = { text, status };
    void pumpCheckpoints();
  };
  const drainCheckpoints = async () => {
    do {
      if (pendingSnap && !checkpointFlying) void pumpCheckpoints();
      await checkpointChain;
    } while (checkpointFlying || pendingSnap);
  };
  const shownNow = () => {
    const prose = tail.getVisibleText();
    if (prose.trim()) return prose;
    return readPartialJsonStringField(answer, "reply") ?? "";
  };
  let flushedDelim = false;
  const upstreamAbort = new AbortController();
  const relayClientAbort = () => upstreamAbort.abort();
  if (req.signal.aborted) upstreamAbort.abort();
  else req.signal.addEventListener("abort", relayClientAbort, { once: true });
  let lastEventAt = Date.now();
  let inputReleased = false;
  let cutoff: "idle" | "deadline" | null = null;
  const stopUpstream = (reason: "idle" | "deadline") => {
    if (cutoff || req.signal.aborted) return;
    cutoff = reason;
    upstreamAbort.abort();
  };
  // 正文寫完後 JSON 還在吐時，若上游停住就收尾放鎖，不要讓游標和回合鎖一直掛著
  const watchdog = setInterval(() => {
    const action = leadStreamWatchdog({
      now: Date.now(),
      startedAt,
      lastEventAt,
      inputReleased,
    });
    if (action === "continue") return;
    stopUpstream(action);
  }, 1000);
  let clientAbort = false;
  let jsonReadyEarly = false;
  try {
    for await (const ev of routeChat(
      model,
      upstream,
      authUserId,
      upstreamAbort.signal,
      undefined,
      jsonOnlySystem(template, lean),
      undefined,
      { researchQuery: fromWeb ? content : "", cacheAffinityId: sessionId },
    )) {
      lastEventAt = Date.now();
      const action = leadStreamWatchdog({
        now: lastEventAt,
        startedAt,
        lastEventAt,
        inputReleased,
      });
      if (action !== "continue") {
        stopUpstream(action);
        break;
      }
      if (ev.type === "text") {
        answer += ev.text;
        tail.push(ev.text);
        const shown = shownNow();
        const crossed = tail.getMode() === "after_delim" && !flushedDelim;
        if (crossed) flushedDelim = true;
        if (tail.getMode() === "after_delim") inputReleased = true;
        // 結構化 JSON 一閉合就收尾派工。不要等模型把尾巴吐完，Cursor 才拿得到指令。
        const jsonReady = inputReleased && Boolean(extractJsonObject(tail.getJsonRaw()));
        if (jsonReady) {
          if (shown) queueCheckpoint(shown, true, "ok");
          jsonReadyEarly = true;
          upstreamAbort.abort();
          break;
        }
        if (crossed) {
          if (shown) queueCheckpoint(shown, true, "ok");
        } else if (shown) {
          queueCheckpoint(shown, false);
        }
      }
      if (ev.type === "done") {
        doneEv = {
          usage: ev.usage,
          officialCostPoints: ev.officialCostPoints,
          chargedPoints: ev.chargedPoints,
          sourceId: ev.sourceId,
          jobId: ev.jobId,
        };
      }
    }
  } catch (e) {
    if (jsonReadyEarly || (cutoff && !req.signal.aborted)) {
      // JSON 已齊／自己切斷：用已寫出的正文收尾，不要當成使用者中止
    } else if (isAbortError(e) || req.signal.aborted) {
      clientAbort = true;
    } else {
      queueCheckpoint(shownNow(), true);
      checkpointsClosed = true;
      await drainCheckpoints();
      const status = e instanceof NoSourceError ? 503 : 500;
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  } finally {
    clearInterval(watchdog);
    req.signal.removeEventListener("abort", relayClientAbort);
  }
  if (clientAbort) {
    queueCheckpoint(shownNow(), true);
    checkpointsClosed = true;
    await drainCheckpoints();
    return Response.json({ error: "aborted", aborted: true }, { status: 499 });
  }
  queueCheckpoint(shownNow(), true);
  checkpointsClosed = true;
  await drainCheckpoints();

  if (doneEv) {
    await settleAssistantMessage({
      userId: authUserId,
      conversationId: convId,
      content: answer,
      model: model.id,
      sourceId: doneEv.sourceId,
      inputTokens: doneEv.usage.inputTokens,
      cachedInputTokens: doneEv.usage.cachedInputTokens,
      outputTokens: doneEv.usage.outputTokens,
      officialCostPoints: doneEv.officialCostPoints,
      chargedPoints: doneEv.chargedPoints,
      jobId: doneEv.jobId,
    });
  }

  const stalledWithoutJson = Boolean(cutoff) && !extractJsonObject(tail.getJsonRaw() || answer);
  const structured = await finalizeTurn({
    authUserId,
    session,
    sessionId,
    dossier,
    contextChars: contextBlock.length,
    answer,
    leadModelId: model.id,
    writeUser: false,
    content,
    fromWeb,
    advisorTexts: [],
    visibleText: shownNow(),
    turnId,
    skipMemoryAndDispatch: stalledWithoutJson,
    completionStatus: stalledWithoutJson ? "degraded" : "ok",
  });

  const updated = await getStrategySession(authUserId, sessionId);
  return Response.json({ session: updated, assistant: structured, dossier: structured.nextDossier, limits: L });
}

async function finalizeTurn(input: {
  authUserId: string;
  session: StrategySession;
  sessionId: string;
  dossier: ReturnType<typeof readDossier>;
  contextChars: number;
  answer: string;
  leadModelId: string;
  writeUser: boolean;
  content: string;
  fromWeb: boolean;
  advisorTexts: { member: SessionMember; text: string }[];
  baseTs?: number;
  skipMemoryAndDispatch?: boolean;
  /** stream 分隔線前可見正文；優先於 JSON reply 落庫 */
  visibleText?: string;
  turnId?: string | null;
  completionStatus?: StrategyMessageCompletionStatus;
}) {
  const completionStatus = input.completionStatus ?? "ok";
  const parsedPack = parseAssistantStructured(
    input.answer,
    input.session,
    input.dossier,
    input.contextChars,
    { visibleText: input.visibleText },
  );
  const {
    reply,
    reportRequests,
    openQuestions,
    nextStatus,
    nextDossier,
    summary,
    roomQueries,
  } = parsedPack;
  const instructions = fillInstructionsFromDelivery(reply, parsedPack.instructions, parsedPack.parsed.workPackage);

  const nextQueryResults: RoomQueryResult[] = [];
  if (!input.skipMemoryAndDispatch) {
    for (const q of roomQueries) {
      if (!q || typeof q !== "object") continue;
      const { roomId, question } = q as { roomId?: unknown; question?: unknown };
      if (typeof roomId !== "string" || typeof question !== "string" || !question.trim()) continue;
      const hit = await queryRoomContent(input.authUserId, input.session, roomId.trim(), question.trim());
      if (hit) nextQueryResults.push(hit);
    }
  }

  const freshSession = await getStrategySession(input.authUserId, input.sessionId);
  const baseMeta = freshSession?.meta ?? input.session.meta;
  const ledgerResult = input.skipMemoryAndDispatch
    ? null
    : applyLedgerTurn(readLedger(baseMeta), {
        ledgerOps: parsedPack.parsed.ledgerOps,
        workPackage: parsedPack.parsed.workPackage,
        verdict: parsedPack.parsed.verdict,
        verdictReason: parsedPack.parsed.verdictReason,
        conclusion: parsedPack.parsed.conclusion,
        escalationDecision: parsedPack.parsed.escalationDecision,
        instructions,
        reportRequests,
      });
  const allowedInstructions = ledgerResult?.allowedInstructions ?? [];
  const allowedReportRequests = ledgerResult?.allowedReportRequests ?? [];
  const held: HeldInstruction[] = ledgerResult?.held ?? [];
  const toDispatch = [...allowedInstructions, ...allowedReportRequests];
  const shouldAutoDispatch =
    !input.skipMemoryAndDispatch &&
    (freshSession?.pauseState ?? "none") === "none" &&
    Boolean(freshSession?.autoDispatch);

  const dispatchIds = toDispatch.length
    ? await addDispatchItems({
        userId: input.authUserId,
        sessionId: input.sessionId,
        items: toDispatch,
        dispatched: shouldAutoDispatch,
      })
    : [];
  const heldDispatchIds = held.length
    ? await addDispatchItems({
        userId: input.authUserId,
        sessionId: input.sessionId,
        items: held.map((h) => ({ text: h.text, itemId: h.itemId, heldReason: h.reason })),
        dispatched: false,
      })
    : [];

  const baseTs = input.baseTs ?? Date.now();
  let idx = 0;
  if (input.writeUser) {
    await addSessionMessage({
      sessionId: input.sessionId,
      userId: input.authUserId,
      role: "user",
      content: input.content,
      structured: { source: input.fromWeb ? "web" : "cursor", turnId: input.turnId ?? undefined },
      createdAt: baseTs + idx,
      turnId: input.turnId,
      idempotent: Boolean(input.turnId),
    });
    idx += 1;
  }
  for (const a of input.advisorTexts) {
    await addSessionMessage({
      sessionId: input.sessionId,
      userId: input.authUserId,
      role: "assistant",
      content: a.text,
      structured: { kind: "advisor", turnId: input.turnId ?? undefined },
      createdAt: baseTs + idx,
      speakerModel: a.member.modelId,
      speakerRole: a.member.role,
      speakerLabel: a.member.label,
      turnId: input.turnId,
      completionStatus,
      idempotent: Boolean(input.turnId),
    });
    idx += 1;
  }

  const structured = {
    reply,
    phase: nextStatus,
    instructions: allowedInstructions,
    reportRequests: allowedReportRequests,
    heldInstructions: held,
    heldDispatchIds,
    ledgerEvents: ledgerResult?.events ?? [],
    ledgerEscalated: ledgerResult?.escalated ?? false,
    openQuestions,
    canStartRun: nextStatus === "ready_to_run" || nextStatus === "ready_next_run",
    fPlan: input.skipMemoryAndDispatch ? input.dossier.fPlan : nextDossier.fPlan,
    contextChars: input.contextChars,
    summary: input.skipMemoryAndDispatch ? input.session.summary : summary,
    roomQueries: nextQueryResults.map((r) => ({
      roomId: r.roomId,
      roomName: r.roomName,
      question: r.question,
    })),
    autoDispatch: shouldAutoDispatch,
    pauseState: freshSession?.pauseState ?? "none",
    dispatchIds,
    nextDossier: input.skipMemoryAndDispatch ? input.dossier : nextDossier,
    completionStatus,
    turnId: input.turnId ?? undefined,
  };

  await addSessionMessage({
    sessionId: input.sessionId,
    userId: input.authUserId,
    role: "assistant",
    content: reply,
    structured,
    createdAt: baseTs + idx,
    speakerModel: input.leadModelId,
    speakerRole: "lead",
    speakerLabel: "主導",
    turnId: input.turnId,
    completionStatus,
    idempotent: Boolean(input.turnId),
  });

  if (!input.skipMemoryAndDispatch) {
    let nextMeta: Record<string, unknown> = {
      ...baseMeta,
      dossier: nextDossier,
      roomQueryResults: nextQueryResults,
      reportFocus: readReportFocus({ reportFocus: parsedPack.parsed.reportFocus }),
      ...(ledgerResult ? { ledger: ledgerResult.ledger } : {}),
    };
    try {
      nextMeta = await absorbStrategyRoomMemory({
        userId: input.authUserId,
        sessionId: input.sessionId,
        meta: nextMeta,
        lean: readRoomMode(baseMeta) === "lean",
      });
    } catch (e) {
      console.warn("[strategy-memory] absorb failed", e instanceof Error ? e.message : e);
    }
    await updateStrategySession(input.authUserId, input.sessionId, {
      status: nextStatus,
      ...(shouldAutoDispatch ? { pendingInstructions: toDispatch } : {}),
      meta: nextMeta,
      model: input.leadModelId,
      summary,
    });
  } else {
    await updateStrategySession(input.authUserId, input.sessionId, {
      model: input.leadModelId,
    });
  }

  return structured;
}

/** abort／錯誤：idempotent 保存 user＋已產生 partial，不假裝完成；無可見內容不寫空 assistant */
async function finalizePartialTurn(input: {
  authUserId: string;
  sessionId: string;
  content: string;
  fromWeb: boolean;
  turnId: string;
  leadModelId: string;
  leadLabel: string;
  advisorTexts: { member: SessionMember; text: string }[];
  visibleText: string;
  status: Extract<StrategyMessageCompletionStatus, "aborted" | "failed" | "partial">;
  baseTs?: number;
}) {
  const baseTs = input.baseTs ?? Date.now();
  let idx = 0;
  await addSessionMessage({
    sessionId: input.sessionId,
    userId: input.authUserId,
    role: "user",
    content: input.content,
    structured: {
      source: input.fromWeb ? "web" : "cursor",
      turnId: input.turnId,
      completionStatus: input.status,
    },
    createdAt: baseTs + idx,
    turnId: input.turnId,
    completionStatus: input.status,
    idempotent: true,
  });
  idx += 1;
  for (const a of input.advisorTexts) {
    if (!a.text.trim()) continue;
    await addSessionMessage({
      sessionId: input.sessionId,
      userId: input.authUserId,
      role: "assistant",
      content: a.text,
      structured: { kind: "advisor", turnId: input.turnId, completionStatus: input.status },
      createdAt: baseTs + idx,
      speakerModel: a.member.modelId,
      speakerRole: a.member.role,
      speakerLabel: a.member.label,
      turnId: input.turnId,
      completionStatus: input.status,
      idempotent: true,
    });
    idx += 1;
  }
  const partial = (input.visibleText || "").trim();
  // 禁止寫空 assistant（前端會當正常氣泡）；狀態掛在 user.structured／completion_status
  if (!partial) return;
  await addSessionMessage({
    sessionId: input.sessionId,
    userId: input.authUserId,
    role: "assistant",
    content: partial,
    structured: {
      kind: "lead",
      turnId: input.turnId,
      completionStatus: input.status,
      reply: partial,
    },
    createdAt: baseTs + idx,
    speakerModel: input.leadModelId,
    speakerRole: "lead",
    speakerLabel: input.leadLabel,
    turnId: input.turnId,
    completionStatus: input.status,
    idempotent: true,
  });
}

async function handleStreamMode(opts: {
  req: Request;
  authUserId: string;
  fromWeb: boolean;
  session: StrategySession;
  sessionId: string;
  content: string;
  template: StrategyTemplate;
  members: SessionMember[];
  lean: boolean;
  turnType: LeanTurnType | null;
  /** 串流主體結束（含中斷、錯誤）時呼叫一次 */
  onSettled?: () => Promise<void>;
}) {
  const { req, authUserId, fromWeb, session, sessionId, content, template, members, lean, turnType } = opts;
  const leadMember = members.find((m) => m.role === "lead") ?? members[0]!;
  // 精簡會議室不跑顧問模型，每回合只呼叫主持人一次
  const advisors = lean ? [] : members.filter((m) => m.role !== "lead");
  const leadModel = findModel(leadMember.modelId) || findModel("gemini-4-neon-high");
  if (!leadModel) {
    return Response.json({ error: `Unknown model: ${leadMember.modelId}` }, { status: 400 });
  }

  const researchOpts = { researchQuery: fromWeb ? content : "", cacheAffinityId: sessionId };
  const turnId = `turn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  // 串流開始即 idempotent 落庫 user，避免 abort 提前 return 丟訊
  await addSessionMessage({
    sessionId,
    userId: authUserId,
    role: "user",
    content,
    structured: { source: fromWeb ? "web" : "cursor", turnId, ...(turnType ? { turnType } : {}) },
    turnId,
    idempotent: true,
  });

  const startedAt = Date.now();
  const encoder = encodeNdjson;

  // 先回串流讓前端可立刻「停止」；組 context／upstream 放到 start 內並尊重 req.signal
  const turn = {
    async run(controller: ReadableStreamDefaultController<Uint8Array>) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder(obj));
        } catch {
          /* client gone */
        }
      };

      send({ type: "stage", stage: "starting" });
      if (req.signal.aborted) {
        send({ type: "error", message: "aborted", aborted: true });
        send({ type: "done", completionStatus: "failed", aborted: true });
        controller.close();
        return;
      }

      let contextBlock: string;
      let dossier: ReturnType<typeof readDossier>;
      let upstreamBase: ChatMessage[];
      try {
        const built = await buildContextBlock(authUserId, session, fromWeb, lean);
        contextBlock = built.contextBlock;
        dossier = built.dossier;
        if (req.signal.aborted) {
          send({ type: "error", message: "aborted", aborted: true });
          send({ type: "done", completionStatus: "failed", aborted: true });
          controller.close();
          return;
        }
        const lastHostTurnAt = readLedger(session.meta).lastHostTurn?.at ?? 0;
        upstreamBase = await buildUpstream(
          authUserId,
          sessionId,
          contextBlock,
          content,
          false,
          lastHostTurnAt,
          lean,
        );
      } catch (e) {
        if (isAbortError(e) || req.signal.aborted) {
          send({ type: "error", message: "aborted", aborted: true });
          send({ type: "done", completionStatus: "failed", aborted: true });
          controller.close();
          return;
        }
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        send({ type: "done", completionStatus: "failed" });
        controller.close();
        return;
      }

      if (req.signal.aborted) {
        send({ type: "error", message: "aborted", aborted: true });
        send({ type: "done", completionStatus: "failed", aborted: true });
        controller.close();
        return;
      }

      let hiddenConvId: string | null = null;
      const advisorTexts: { member: SessionMember; text: string }[] = [];
      let leadAnswer = "";
      let leadVisiblePartial = "";
      let aborted = false;
      let softTimeout = false;
      let visibleStall = false;

      const persistPartial = async (
        status: Extract<StrategyMessageCompletionStatus, "aborted" | "failed" | "partial">,
      ) => {
        try {
          await finalizePartialTurn({
            authUserId,
            sessionId,
            content,
            fromWeb,
            turnId,
            leadModelId: leadModel.id,
            leadLabel: leadMember.label,
            advisorTexts,
            visibleText: leadVisiblePartial,
            status,
            baseTs: Date.now(),
          });
        } catch {
          /* 落庫失敗不阻斷關閉串流 */
        }
      };

      const ensureHiddenConv = async (modelId: string) => {
        if (hiddenConvId) return hiddenConvId;
        hiddenConvId = await createConversation(
          authUserId,
          `strategy-session ${session.name}`,
          modelId,
          { hidden: true },
        );
        return hiddenConvId;
      };

      const settle = async (model: ModelInfo, text: string, done: DoneBill) => {
        const convId = await ensureHiddenConv(model.id);
        await settleAssistantMessage({
          userId: authUserId,
          conversationId: convId,
          content: text,
          model: model.id,
          sourceId: done.sourceId,
          inputTokens: done.usage.inputTokens,
          cachedInputTokens: done.usage.cachedInputTokens,
          outputTokens: done.usage.outputTokens,
          officialCostPoints: done.officialCostPoints,
          chargedPoints: done.chargedPoints,
          jobId: done.jobId,
        });
      };

      try {
        // Advisors
        for (const adv of advisors) {
          if (req.signal.aborted) {
            aborted = true;
            break;
          }
          if (Date.now() - startedAt > ADVISOR_BUDGET_MS) {
            send({
              type: "notice",
              message: "已超過 180 秒顧問預算，略過剩餘顧問，交由主導彙總",
            });
            break;
          }
          if ((await balance(authUserId)) <= 0) {
            send({ type: "notice", message: "餘額不足，略過剩餘顧問" });
            break;
          }
          const advModel = findModel(adv.modelId);
          if (!advModel) {
            send({ type: "notice", message: `略過未知模型 ${adv.modelId}` });
            continue;
          }

          send({
            type: "member_start",
            role: adv.role,
            modelId: adv.modelId,
            label: adv.label,
          });

          let text = "";
          let doneEv: DoneBill | null = null;
          const advUpstream: ChatMessage[] = [
            ...upstreamBase,
            {
              role: "user",
              content: `請針對上一則使用者訊息與脈絡，以「${adv.label}」視角給出審查意見。`,
            },
          ];
          try {
            for await (const ev of routeChat(
              advModel,
              advUpstream,
              authUserId,
              req.signal,
              undefined,
              advisorSystem(adv.label),
              undefined,
              { researchQuery: "", cacheAffinityId: sessionId },
            )) {
              // thinking 靜默丟棄，不轉發前端
              if (ev.type === "text") {
                text += ev.text;
                send({ type: "text", text: ev.text, modelId: adv.modelId, role: adv.role });
              }
              if (ev.type === "done") {
                doneEv = {
                  usage: ev.usage,
                  officialCostPoints: ev.officialCostPoints,
                  chargedPoints: ev.chargedPoints,
                  sourceId: ev.sourceId,
                  jobId: ev.jobId,
                };
              }
            }
          } catch (e) {
            if (isAbortError(e) || req.signal.aborted) {
              aborted = true;
              break;
            }
            send({
              type: "notice",
              message: `顧問 ${adv.label} 失敗：${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
          }

          if (aborted || req.signal.aborted) {
            aborted = true;
            break;
          }
          if (doneEv && text.trim()) {
            await settle(advModel, text, doneEv);
            advisorTexts.push({ member: adv, text: text.trim() });
            send({ type: "member_done", role: adv.role, modelId: adv.modelId, label: adv.label });
          }
        }

        if (aborted || req.signal.aborted) {
          await persistPartial("aborted");
          send({ type: "error", message: "aborted", aborted: true });
          send({ type: "done", completionStatus: "failed", aborted: true });
          controller.close();
          return;
        }

        // Lead
        send({
          type: "member_start",
          role: "lead",
          modelId: leadModel.id,
          label: leadMember.label,
        });
        send({ type: "stage", stage: "lead" });

        const advisorDigest =
          advisorTexts.length === 0
            ? ""
            : `\n\n## 本回合顧問意見\n${advisorTexts
                .map((a) => `### ${a.member.label}（${a.member.modelId}）\n${a.text}`)
                .join("\n\n")}`;

        const leadUpstream: ChatMessage[] = upstreamBase.map((m, i) =>
          i === upstreamBase.length - 1 && m.role === "user"
            ? { role: "user", content: `${m.content}${advisorDigest}` }
            : m,
        );

        const tail = new StrategyJsonTailBuffer(STRATEGY_STATE_DELIMITER);
        let doneEv: DoneBill | null = null;
        let inputReleased = false;
        // 可見文字先分段落庫。重新整理會切斷連線，收尾的 abort 存檔常常來不及，已寫出的字要先在庫裡。
        let checkpointChain: Promise<void> = Promise.resolve();
        let checkpointsClosed = false;
        let lastCheckpointAt = 0;
        let lastCheckpointLen = 0;
        const queueCheckpoint = (force = false) => {
          if (checkpointsClosed) return;
          const snapshot = tail.getVisibleText();
          if (!snapshot.trim()) return;
          const now = Date.now();
          if (
            !force &&
            now - lastCheckpointAt < 1200 &&
            snapshot.length - lastCheckpointLen < 240
          ) {
            return;
          }
          lastCheckpointAt = now;
          lastCheckpointLen = snapshot.length;
          checkpointChain = checkpointChain
            .then(() =>
              addSessionMessage({
                sessionId,
                userId: authUserId,
                role: "assistant",
                content: snapshot,
                structured: {
                  kind: "lead",
                  turnId,
                  completionStatus: "partial",
                  reply: snapshot,
                },
                createdAt: startedAt + 1,
                speakerModel: leadModel.id,
                speakerRole: "lead",
                speakerLabel: leadMember.label,
                turnId,
                completionStatus: "partial",
                idempotent: true,
              }),
            )
            .then(() => undefined)
            .catch(() => undefined);
        };
        const finishCheckpoints = async () => {
          checkpointsClosed = true;
          await checkpointChain;
        };
        const onClientGone = () => {
          queueCheckpoint(true);
        };
        req.signal.addEventListener("abort", onClientGone, { once: true });
        // 可見文字一結束就解鎖輸入，並放開伺服器回合鎖。後面的 JSON 不再擋住下一則。
        const releaseInput = async () => {
          if (inputReleased) return;
          inputReleased = true;
          send({
            type: "member_done",
            role: "lead",
            modelId: leadModel.id,
            label: leadMember.label,
          });
          send({ type: "input_ready" });
        };

        const upstream = new AbortController();
        const relayClientAbort = () => upstream.abort();
        if (req.signal.aborted) upstream.abort();
        else req.signal.addEventListener("abort", relayClientAbort, { once: true });
        let lastEventAt = Date.now();
        let cutoff: "idle" | "deadline" | null = null;
        let jsonReadyEarly = false;
        const stopUpstream = (reason: "idle" | "deadline") => {
          if (cutoff || req.signal.aborted || jsonReadyEarly) return;
          cutoff = reason;
          if (reason === "deadline") softTimeout = true;
          upstream.abort();
        };
        // 停住的串流不會再進迴圈，軟截止與「正文已結束」都要在這裡自己醒來
        const watchdog = setInterval(() => {
          const action = leadStreamWatchdog({
            now: Date.now(),
            startedAt,
            lastEventAt,
            inputReleased,
          });
          if (action === "continue") return;
          stopUpstream(action);
        }, 1000);

        try {
          for await (const ev of routeChat(
            leadModel,
            leadUpstream,
            authUserId,
            upstream.signal,
            undefined,
            streamLeadSystem(template, lean),
            undefined,
            researchOpts,
          )) {
            lastEventAt = Date.now();
            const action = leadStreamWatchdog({
              now: lastEventAt,
              startedAt,
              lastEventAt,
              inputReleased,
            });
            if (action !== "continue") {
              stopUpstream(action);
              break;
            }
            // thinking 靜默丟棄，不轉發前端
            if (ev.type === "text") {
              const visible = tail.push(ev.text);
              if (visible) {
                leadVisiblePartial = tail.getVisibleText();
                send({ type: "text", text: visible, modelId: leadModel.id, role: "lead" });
                queueCheckpoint(false);
              }
              if (tail.getMode() === "after_delim") {
                queueCheckpoint(true);
                if (extractJsonObject(tail.getJsonRaw())) {
                  inputReleased = true;
                  send({
                    type: "member_done",
                    role: "lead",
                    modelId: leadModel.id,
                    label: leadMember.label,
                  });
                  send({ type: "input_ready" });
                  // JSON 已齊就停上游，不要再等尾巴；派工可以立刻收尾
                  jsonReadyEarly = true;
                  upstream.abort();
                  break;
                }
                await releaseInput();
              }
            }
            if (ev.type === "done") {
              doneEv = {
                usage: ev.usage,
                officialCostPoints: ev.officialCostPoints,
                chargedPoints: ev.chargedPoints,
                sourceId: ev.sourceId,
                jobId: ev.jobId,
              };
            }
          }
        } catch (e) {
          leadVisiblePartial = tail.getVisibleText();
          if (jsonReadyEarly || (cutoff && !req.signal.aborted)) {
            if (cutoff === "deadline") softTimeout = true;
          } else if (isAbortError(e) || req.signal.aborted) {
            aborted = true;
          } else {
            await finishCheckpoints();
            await persistPartial("failed");
            send({ type: "error", message: e instanceof Error ? e.message : String(e) });
            send({ type: "done", completionStatus: "failed" });
            controller.close();
            req.signal.removeEventListener("abort", onClientGone);
            return;
          }
        } finally {
          clearInterval(watchdog);
          req.signal.removeEventListener("abort", relayClientAbort);
        }
        if (cutoff === "idle" && !req.signal.aborted) visibleStall = true;
        if (cutoff === "deadline") softTimeout = true;

        const flushed = tail.flushVisible();
        if (flushed) send({ type: "text", text: flushed, modelId: leadModel.id, role: "lead" });
        leadVisiblePartial = tail.getVisibleText();

        if (aborted || req.signal.aborted) {
          await finishCheckpoints();
          await persistPartial("aborted");
          req.signal.removeEventListener("abort", onClientGone);
          send({ type: "error", message: "aborted", aborted: true });
          send({ type: "done", completionStatus: "failed", aborted: true });
          controller.close();
          return;
        }

        const visibleText = tail.getVisibleText();
        const jsonRaw = tail.getJsonRaw();
        // 結構化欄位取 JSON；落庫正文由 finalizeTurn 以 visibleText 優先（允許 reply===""）
        leadAnswer = jsonRaw || visibleText;
        if (visibleText && jsonRaw && jsonRaw !== visibleText) {
          const parsed = extractJsonObject(jsonRaw);
          if (!parsed) {
            leadAnswer = `${visibleText}\n${STRATEGY_STATE_DELIMITER}\n${jsonRaw}`;
          } else {
            leadAnswer = jsonRaw;
          }
        } else if (visibleText && !extractJsonObject(jsonRaw || "")) {
          leadAnswer = visibleText;
        }

        // 沒有分隔線的回覆：文字到這裡就是全文，先讓輸入框解鎖。鎖留到落庫再放，避免空窗。
        if (!inputReleased) {
          inputReleased = true;
          send({
            type: "member_done",
            role: "lead",
            modelId: leadModel.id,
            label: leadMember.label,
          });
          send({ type: "input_ready" });
        }

        if (doneEv && (visibleText || jsonRaw)) {
          await settle(leadModel, visibleText || jsonRaw, doneEv);
        }

        await finishCheckpoints();
        req.signal.removeEventListener("abort", onClientGone);

        const skipMemory = (softTimeout || visibleStall) && !extractJsonObject(leadAnswer);
        if (softTimeout) {
          send({
            type: "notice",
            message: skipMemory
              ? "已達 270 秒軟截止：僅保留純文字回覆，不更新記憶與派送"
              : "已達 270 秒軟截止：盡力完成結構化收尾",
          });
        } else if (visibleStall && skipMemory) {
          send({
            type: "notice",
            message: "回覆已顯示，後續收尾逾時，這次不更新帳本",
          });
        }

        const structured = await finalizeTurn({
          authUserId,
          session,
          sessionId,
          dossier,
          contextChars: contextBlock.length,
          answer: leadAnswer || visibleText,
          leadModelId: leadModel.id,
          writeUser: false,
          content,
          fromWeb,
          advisorTexts,
          baseTs: Date.now(),
          skipMemoryAndDispatch: skipMemory,
          visibleText,
          turnId,
          completionStatus: softTimeout || (visibleStall && skipMemory) ? "degraded" : "ok",
        });

        send({
          type: "done",
          completionStatus: softTimeout || (visibleStall && skipMemory) ? "degraded" : "ok",
          assistant: {
            reply: structured.reply,
            phase: structured.phase,
            dispatchIds: structured.dispatchIds,
            pauseState: structured.pauseState,
          },
          limits: L,
        });
      } catch (e) {
        if (isAbortError(e) || req.signal.aborted) {
          await persistPartial("aborted");
          send({ type: "error", message: "aborted", aborted: true });
          send({ type: "done", completionStatus: "failed", aborted: true });
        } else {
          await persistPartial("failed");
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          send({ type: "done", completionStatus: "failed" });
        }
      } finally {
        controller.close();
      }
    },
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await turn.run(controller);
      } finally {
        await opts.onSettled?.();
      }
    },
  });

  return new Response(stream, { headers: STRATEGY_STREAM_HEADERS });
}
