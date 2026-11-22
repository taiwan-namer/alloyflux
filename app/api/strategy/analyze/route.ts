import { cloudDbProxy } from "@/lib/cloud-api";
import { NoSourceError, routeChat } from "@/lib/gateway";
import { findModel } from "@/lib/models";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import {
  addUserMessage,
  balance,
  createConversation,
  settleAssistantMessage,
} from "@/lib/store";
import {
  createStrategyPlan,
  createStrategyRun,
  extractJsonObject,
  getStrategyRun,
} from "@/lib/strategy-loop";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = `你是量化交易策略審稿助手。根據使用者提供的 run report／review 摘要，產出「下一輪要改什麼」的 JSON。
只輸出一個 JSON 物件，不要 markdown 解釋。欄位：
{
  "hypotheses": ["假設1", "假設2"],
  "changeRequests": [
    {"target": "檔案或模組", "action": "要改什麼", "why": "原因"}
  ],
  "acceptance": ["可驗證的驗收條件"],
  "riskNotes": ["風險提醒"]
}
限制：最多 3 條 hypotheses、最多 5 條 changeRequests；優先可在本機 paper 驗證的小改動；不要建議實盤下單。`;

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    model?: string;
    profileId?: string;
    strategyVersion?: string;
    gitCommit?: string;
    summary?: Record<string, unknown>;
    reviewExcerpt?: string;
    metrics?: Record<string, unknown>;
    roundIndex?: number;
  };

  let runId = body.runId?.trim() || "";
  if (runId) {
    const existing = await getStrategyRun(auth.user.id, runId);
    if (!existing) return Response.json({ error: "run not found" }, { status: 404 });
  } else {
    const created = await createStrategyRun({
      userId: auth.user.id,
      profileId: body.profileId,
      strategyVersion: body.strategyVersion,
      gitCommit: body.gitCommit,
      summary: body.summary,
      reviewExcerpt: body.reviewExcerpt,
      metrics: body.metrics,
    });
    runId = created.id;
  }

  const run = await getStrategyRun(auth.user.id, runId);
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });

  if ((await balance(auth.user.id)) <= 0) {
    return Response.json({ error: "Insufficient credits" }, { status: 402 });
  }

  const model = findModel(body.model || "gemini-3.5-flash-lite");
  if (!model) {
    return Response.json({ error: `Unknown model: ${body.model}` }, { status: 400 });
  }

  const userPayload = {
    runId: run.id,
    profileId: run.profileId,
    strategyVersion: run.strategyVersion,
    metrics: run.metrics,
    summary: run.summary,
    reviewExcerpt: (run.reviewExcerpt || "").slice(0, 12000),
  };

  const prompt = `請分析此策略 run 並回傳 JSON：\n${JSON.stringify(userPayload, null, 2)}`;
  const convId = await createConversation(auth.user.id, `strategy-analyze ${run.id}`, model.id);
  await addUserMessage(convId, prompt, model.id);

  let answer = "";
  let doneEv: {
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    officialCostPoints: number;
    chargedPoints: number;
    sourceId: string;
    jobId?: string;
  } | null = null;
  try {
    for await (const ev of routeChat(
      model,
      [{ role: "user", content: prompt }],
      auth.user.id,
      req.signal,
      undefined,
      SYSTEM,
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
    const status = e instanceof NoSourceError ? 503 : 500;
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
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
  const hypotheses = Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
  const changeRequests = Array.isArray(parsed.changeRequests) ? parsed.changeRequests : [];
  const acceptance = Array.isArray(parsed.acceptance) ? parsed.acceptance : [];

  const plan = await createStrategyPlan({
    userId: auth.user.id,
    runId,
    hypotheses,
    changeRequests,
    acceptance,
    rawAnalysis: answer,
    roundIndex: body.roundIndex ?? 1,
    status: "pending_code",
  });

  return Response.json({
    runId,
    planId: plan.id,
    plan: {
      id: plan.id,
      status: "pending_code",
      hypotheses,
      changeRequests,
      acceptance,
      riskNotes: parsed.riskNotes ?? [],
      rawAnalysis: answer,
    },
  });
}
