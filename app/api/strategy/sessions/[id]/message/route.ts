import { cloudDbProxy } from "@/lib/cloud-api";
import { NoSourceError, routeChat } from "@/lib/gateway";
import { findModel } from "@/lib/models";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import type { ChatMessage } from "@/lib/providers";
import {
  addUserMessage,
  balance,
  createConversation,
  settleAssistantMessage,
} from "@/lib/store";
import {
  addSessionMessage,
  extractJsonObject,
  getStrategySession,
  listRunsForSession,
  listSessionMessages,
  listSessionReports,
  mergeDossier,
  readDossier,
  STRATEGY_LIMITS,
  STRATEGY_SESSION_STATUSES,
  updateStrategySession,
  type StrategySessionStatus,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const L = STRATEGY_LIMITS;

const SYSTEM = `你是 automax 量化策略「會議室」主導者。另一端是 Cursor（能在使用者電腦上讀檔、跑 Python、改程式、啟動 paper 測試）。
策略方向、取捨與何時開跑由你決定；Cursor 負責執行你的指令並回報。

## 流程（phase）
1. discovery：透過 Cursor 了解 automax 過往 A、B、C、D、E 各策略的規則與實績；再要求挖個別交易紀錄、K 線分析。
2. designing：根據證據討論出新策略「F 方案」，來回修正。
3. ready_to_run：F 定案。給出 fPlan（規則、參數、驗收指標）與給 Cursor 的實作／啟動指令，canStartRun=true。
4. running：本機 24h paper 進行中（由 Cursor 標記）。
5. collecting／reviewing：24h 結束後復盤；缺資料就下指令要。
6. await_code：需要改程式。
7. ready_next_run：復盤完成，允許開下一輪 24h（canStartRun=true）。

## 資料量限制（很重要）
- 平台每回合只看得到：你的策略檔案夾（dossier，≤${L.dossierMaxChars} 字）、最近的 Cursor 報告（合計 ≤${L.reportsInjectMaxChars} 字，單份 ≤${L.reportInjectEachMaxChars} 字）、最近幾則對話。更早的對話會被裁掉。
- Cursor 單則訊息 ≤${L.messageMaxChars} 字；單份報告上傳 ≤${L.reportMaxChars} 字。
- 因此：絕對不要要求 Cursor 貼原始 K 線、完整 fills、decision_trace 原檔。要指定「在本機分析後回傳彙總」：統計表、分組（標的／方向／時段／退出原因）、分佈、代表性樣本（≤10 筆）、結論。
- 每個 reportRequest 必須寫清楚：資料來源、計算方式、輸出欄位、maxChars（建議 3000–8000）。
- 重要結論一定要寫進 memoryUpdates，因為舊對話會被裁掉；dossier 是你唯一可靠的長期記憶。

## 每次只輸出一個 JSON 物件
{
  "reply": "給使用者與 Cursor 的繁體中文說明",
  "phase": "discovery|designing|ready_to_run|collecting|reviewing|await_code|ready_next_run",
  "instructions": ["Cursor 要執行的具體動作"],
  "reportRequests": [{"id": "r1", "title": "標題", "spec": "來源、方法、欄位", "maxChars": 6000}],
  "memoryUpdates": {
    "strategies": {"A": "一段摘要：規則重點＋實績＋問題"},
    "findings": ["新發現"],
    "decisions": ["已定案的決策"],
    "fPlan": null
  },
  "canStartRun": false,
  "openQuestions": ["未解問題"]
}
規則：只限 paper／testnet，不建議實盤下單。引用數字要來自報告或 dossier，不可臆造。fPlan 未定案時給 null；定案時給完整物件（name、規則、參數、風控、驗收指標、比較基準）。`;

function budgetJoin(parts: string[], max: number): string {
  let out = "";
  for (const p of parts) {
    if (out.length + p.length > max) break;
    out += p;
  }
  return out;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: sessionId } = await ctx.params;
  const session = await getStrategySession(auth.user.id, sessionId);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  if (session.status === "closed") {
    return Response.json({ error: "Session closed" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { content?: string; model?: string };
  const content = (body.content || "").trim();
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  if (content.length > L.messageMaxChars) {
    return Response.json(
      {
        error: `訊息 ${content.length} 字，超過上限 ${L.messageMaxChars} 字；長內容請改用報告上傳（/report）`,
        limits: L,
      },
      { status: 413 },
    );
  }

  if ((await balance(auth.user.id)) <= 0) {
    return Response.json({ error: "Insufficient credits" }, { status: 402 });
  }

  const modelId = body.model || session.model || "gemini-4-neon-high";
  const model = findModel(modelId);
  if (!model) {
    return Response.json({ error: `Unknown model: ${modelId}` }, { status: 400 });
  }

  await addSessionMessage({ sessionId, userId: auth.user.id, role: "user", content });

  const dossier = readDossier(session.meta);
  const history = await listSessionMessages(auth.user.id, sessionId, L.historyMessages);
  const reports = await listSessionReports(auth.user.id, sessionId, 30);
  const runs = await listRunsForSession(auth.user.id, sessionId, 3);

  const reportIndex = reports
    .map((r) => `- ${r.id}${r.requestId ? ` [${r.requestId}]` : ""}：${r.title}（${r.chars} 字）`)
    .join("\n");
  const reportBodies = budgetJoin(
    reports.map((r) => {
      const body =
        r.content.length > L.reportInjectEachMaxChars
          ? `${r.content.slice(0, L.reportInjectEachMaxChars)}\n…[截斷]`
          : r.content;
      return `\n### 報告 ${r.id}${r.requestId ? ` [${r.requestId}]` : ""}：${r.title}\n${body}\n`;
    }),
    L.reportsInjectMaxChars,
  );
  const runBodies = budgetJoin(
    runs.map(
      (r) =>
        `\n- run ${r.id} profile=${r.profileId} metrics=${JSON.stringify(r.metrics)}\n${(r.reviewExcerpt || "").slice(0, 2500)}\n`,
    ),
    L.runsInjectMaxChars,
  );

  const contextBlock = [
    `# 會議室 ${session.name}（${session.id}）｜phase=${session.status}`,
    `## 策略檔案夾 dossier\n${JSON.stringify(dossier, null, 1)}`,
    `## 上一回合你給 Cursor 的待辦\n${JSON.stringify(session.pendingInstructions).slice(0, 3000)}`,
    reports.length ? `## 已收到的報告索引\n${reportIndex}` : "## 尚未收到任何報告",
    reportBodies ? `## 最近報告內容${reportBodies}` : "",
    runBodies ? `## 已掛載 run${runBodies}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const upstream: ChatMessage[] = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  while (upstream.length && upstream[0].role !== "user") upstream.shift();
  const last = upstream[upstream.length - 1];
  if (last?.role === "user") {
    last.content = `${contextBlock}\n\n---\n# Cursor 本回合訊息\n${last.content}`;
  }

  const convId = await createConversation(auth.user.id, `strategy-session ${session.name}`, model.id);
  await addUserMessage(convId, content, model.id);

  let answer = "";
  let doneEv: {
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    officialCostPoints: number;
    chargedPoints: number;
    sourceId: string;
    jobId?: string;
  } | null = null;

  try {
    for await (const ev of routeChat(model, upstream, auth.user.id, req.signal, undefined, SYSTEM)) {
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
    const status = e instanceof NoSourceError ? 503 : 500;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }

  if (doneEv) {
    await settleAssistantMessage({
      userId: auth.user.id,
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

  const parsed = extractJsonObject(answer) || {};
  const reply =
    typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : answer.slice(0, 4000);
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

  const structured = {
    reply,
    phase: nextStatus,
    instructions,
    reportRequests,
    openQuestions,
    canStartRun: nextStatus === "ready_to_run" || nextStatus === "ready_next_run",
    fPlan: nextDossier.fPlan,
    contextChars: contextBlock.length,
  };

  await addSessionMessage({
    sessionId,
    userId: auth.user.id,
    role: "assistant",
    content: reply,
    structured,
  });
  await updateStrategySession(auth.user.id, sessionId, {
    status: nextStatus,
    pendingInstructions: [...instructions, ...reportRequests],
    meta: { ...session.meta, dossier: nextDossier },
    model: model.id,
  });

  const updated = await getStrategySession(auth.user.id, sessionId);
  return Response.json({ session: updated, assistant: structured, dossier: nextDossier, limits: L });
}
