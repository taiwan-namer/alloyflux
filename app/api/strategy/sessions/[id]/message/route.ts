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
import {
  STRATEGY_STREAM_HEADERS,
  StrategyJsonTailBuffer,
  encodeNdjson,
} from "@/lib/strategy-stream";
import {
  STRATEGY_STATE_DELIMITER,
  STREAM_REPLY_EMPTY_RULE,
  type StrategyTemplate,
} from "@/lib/strategy-templates";
import {
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
const SOFT_DEADLINE_MS = 270_000;

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
2. 下指令：instructions 只寫「目標、範圍、驗收標準」，不指定逐行改法；每次最多 5 條，全部屬於目前項目。同時輸出 workPackage（itemId、goal、scope、acceptance）。
3. 對齊：Cursor 回報「對齊有問題」時，只針對那個問題修正指令，不重新規劃整個專案。
4. 驗收：Cursor 交「最終報告」時對照驗收標準判定。通過 → verdict "accept"，說明下一步或結束；不通過 → verdict "reject"＋verdictReason，只給一條具體修正指令。
5. 使用者要求復盤時，再總結得失。
禁止：要求原始碼或拆段上傳；擴大範圍（新點子寫在 reply 的「建議清單」，不要下成指令）；只為了確認而要求額外報告；部署、git push、正式資料庫寫入一律寫成「待發起人批准」。
reply 控制在 800 字內。項目完成或要換下一項時，用 ledgerOps（setStatus／setCurrent）更新帳本。`;
}

function jsonOnlySystem(template: StrategyTemplate, lean: boolean): string {
  if (lean) {
    return `${template.systemPrompt}\n\n${leanSopBlock()}\nJSON 物件可另含欄位：ledgerOps, workPackage, verdict, verdictReason, escalationDecision。`;
  }
  return `${template.systemPrompt}\n\n${limitsBlock()}\n\n${ledgerProtocolBlock()}\nJSON 物件可另含欄位：ledgerOps, workPackage, verdict, verdictReason, escalationDecision, reportFocus。`;
}

function streamLeadSystem(template: StrategyTemplate, lean: boolean): string {
  return `${template.streamLeadPreface}

${lean ? leanSopBlock() : `${limitsBlock()}\n\n${ledgerProtocolBlock()}`}

結構化 JSON 欄位必須包含：reply, phase, instructions, reportRequests, memoryUpdates, canStartRun, openQuestions, summary, roomQueries；需要時另加 ledgerOps, workPackage, verdict, verdictReason, escalationDecision${lean ? "" : ", reportFocus"}。
分隔標記必須單獨一行：${STRATEGY_STATE_DELIMITER}
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

  if (lean) {
    // 像一般聊天：只有專案錨點＋上一回合之後新上傳的報告，其餘全靠對話紀錄
    const fresh = await listSessionReports(authUserId, session.id, 10);
    const { bodies } = buildReportInjection(fresh, {
      lastHostTurnAt: ledger.lastHostTurn?.at ?? 0,
      focusIds: [],
    });
    const contextBlock = [
      renderLedgerAnchor(ledger),
      bodies ? `## 上一回合之後 Cursor 上傳的報告${bodies}` : "",
      `## 發言來源\n本回合訊息來自：${fromWeb ? "使用者（網頁）" : "Cursor"}`,
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
    reportBodies ? `## 上一回合之後的新報告／指名報告${reportBodies}` : "",
    runBodies ? `## 已掛載 run${runBodies}` : "",
    `## 發言來源提示\n本回合訊息來自：${fromWeb ? "使用者（網頁）" : "Cursor"}`,
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
          olderUserMaxChars: L.leanOlderUserMaxChars,
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

  if ((await balance(auth.user.id)) <= 0) {
    return Response.json({ error: "Insufficient credits" }, { status: 402 });
  }

  const wantStream = body.stream === true;
  const template = await resolveTemplateForSession(auth.user.id, session);
  const members = resolveSessionMembers(session).map((m) => ({ ...m }));
  if (body.model?.trim()) {
    const lead = members.find((m) => m.role === "lead");
    if (lead) lead.modelId = body.model.trim();
  }

  if (!wantStream) {
    return handleJsonMode({
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

  return handleStreamMode({
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

  await addSessionMessage({
    sessionId,
    userId: authUserId,
    role: "user",
    content,
    structured: { source: fromWeb ? "web" : "cursor", ...(turnType ? { turnType } : {}) },
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
  try {
    for await (const ev of routeChat(
      model,
      upstream,
      authUserId,
      req.signal,
      undefined,
      jsonOnlySystem(template, lean),
      undefined,
      { researchQuery: fromWeb ? content : "", cacheAffinityId: sessionId },
    )) {
      if (ev.type === "text") answer += ev.text;
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
      return Response.json({ error: "aborted", aborted: true }, { status: 499 });
    }
    const status = e instanceof NoSourceError ? 503 : 500;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }

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
    instructions,
    reportRequests,
    openQuestions,
    nextStatus,
    nextDossier,
    summary,
    roomQueries,
  } = parsedPack;

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
    await updateStrategySession(input.authUserId, input.sessionId, {
      status: nextStatus,
      ...(shouldAutoDispatch ? { pendingInstructions: toDispatch } : {}),
      meta: {
        ...baseMeta,
        dossier: nextDossier,
        roomQueryResults: nextQueryResults,
        reportFocus: readReportFocus({ reportFocus: parsedPack.parsed.reportFocus }),
        ...(ledgerResult ? { ledger: ledgerResult.ledger } : {}),
      },
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
  const stream = new ReadableStream({
    async start(controller) {
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

        try {
          for await (const ev of routeChat(
            leadModel,
            leadUpstream,
            authUserId,
            req.signal,
            undefined,
            streamLeadSystem(template, lean),
            undefined,
            researchOpts,
          )) {
            if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
              softTimeout = true;
              break;
            }
            // thinking 靜默丟棄，不轉發前端
            if (ev.type === "text") {
              const visible = tail.push(ev.text);
              if (visible) {
                leadVisiblePartial = tail.getVisibleText();
                send({ type: "text", text: visible, modelId: leadModel.id, role: "lead" });
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
          if (isAbortError(e) || req.signal.aborted) {
            aborted = true;
          } else {
            await persistPartial("failed");
            send({ type: "error", message: e instanceof Error ? e.message : String(e) });
            send({ type: "done", completionStatus: "failed" });
            controller.close();
            return;
          }
        }

        const flushed = tail.flushVisible();
        if (flushed) send({ type: "text", text: flushed, modelId: leadModel.id, role: "lead" });
        leadVisiblePartial = tail.getVisibleText();

        if (aborted || req.signal.aborted) {
          await persistPartial("aborted");
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

        // #9：可見文字結束立刻解鎖輸入；settle／finalize（落庫、派送）再背景做
        // 否則前端要等數秒 done 才解除 generating，體感像當機
        send({
          type: "member_done",
          role: "lead",
          modelId: leadModel.id,
          label: leadMember.label,
        });
        send({ type: "input_ready" });

        if (doneEv && (visibleText || jsonRaw)) {
          await settle(leadModel, visibleText || jsonRaw, doneEv);
        }

        const skipMemory = softTimeout && !extractJsonObject(leadAnswer);
        if (softTimeout) {
          send({
            type: "notice",
            message: skipMemory
              ? "已達 270 秒軟截止：僅保留純文字回覆，不更新記憶與派送"
              : "已達 270 秒軟截止：盡力完成結構化收尾",
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
          completionStatus: softTimeout ? "degraded" : "ok",
        });

        send({
          type: "done",
          completionStatus: softTimeout ? "degraded" : "ok",
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
  });

  return new Response(stream, { headers: STRATEGY_STREAM_HEADERS });
}
