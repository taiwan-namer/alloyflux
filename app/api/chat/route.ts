import { findModel, type ModelInfo } from "@/lib/models";
import { routeChat } from "@/lib/gateway";
import { AUTO_MODEL_ID, applyDeepThink, resolveAutoModel, type AutoDecision } from "@/lib/auto-router";
import { isAbortError, ModelNotInCatalogError, type ChatImage, type ChatMessage } from "@/lib/providers";
import { slideMessagesForUpstream } from "@/lib/context-window";
import { jsonError, requireUser } from "@/lib/auth";
import {
  addUserMessage,
  balance,
  buildUserMemoryContext,
  createConversation,
  getConversation,
  listMessages,
  maybeRememberFromUserMessage,
  settleAssistantMessage,
} from "@/lib/store";

export const dynamic = "force-dynamic";

const DB_HISTORY_READ = 80;
const MAX_IMAGES = 3;

function normalizeImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const mimeType = String((item as { mimeType?: unknown }).mimeType ?? "").trim();
    let data = String((item as { data?: unknown }).data ?? "").trim();
    if (!mimeType.startsWith("image/") || !data) continue;
    // 容錯：若前端誤帶 data URL prefix 則剝掉
    const comma = data.indexOf(",");
    if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
    out.push({ mimeType, data });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json()) as {
      conversationId?: string;
      model: string;
      content?: string;
      images?: unknown;
      /** 僅 top 模型有效：改走 medium（單次 Cap 45） */
      deepThink?: boolean;
      /** Auto 專用：「改用主力模型重答」 */
      autoForce?: "main";
    };
    const userId = user.id;
    const isAuto = body.model === AUTO_MODEL_ID;
    const picked = isAuto ? null : findModel(body.model);
    if (!isAuto && !picked) return Response.json({ error: "未知的模型" }, { status: 400 });

    const trimmed = (body.content ?? "").trim();
    const images = normalizeImages(body.images);
    if (!trimmed && images.length === 0) {
      return Response.json({ error: "訊息不能是空的" }, { status: 400 });
    }
    if ((await balance(userId)) <= 0) return Response.json({ error: "可用額度不足，請先兌換儲值碼" }, { status: 402 });

    const upstreamContent = trimmed || "（見附圖）";
    const dbContent = images.length
      ? `[已上傳 ${images.length} 張圖片]\n${upstreamContent}`
      : upstreamContent;

    let convId = body.conversationId;
    if (convId && !(await getConversation(userId, convId))) convId = undefined;

    let model: ModelInfo;
    let autoDecision: AutoDecision | null = null;
    let autoInput: Parameters<typeof resolveAutoModel>[0] | null = null;
    if (isAuto) {
      const prior = convId ? await listMessages(convId) : [];
      const lastAssistant = [...prior].reverse().find((m) => m.role === "assistant");
      autoInput = {
        text: upstreamContent,
        hasImages: images.length > 0,
        lastAssistant: lastAssistant ? { content: lastAssistant.content, model: lastAssistant.model } : undefined,
        forceMain: body.autoForce === "main",
      };
      autoDecision = await resolveAutoModel(autoInput);
      if (!autoDecision) {
        return Response.json({ error: "Auto 目前沒有可用模型，請稍後再試或手動選擇模型" }, { status: 503 });
      }
      model = autoDecision.model;
      console.log("[auto-route]", {
        conv: convId?.slice(0, 8) ?? "new",
        lane: autoDecision.lane,
        model: model.id,
        reason: autoDecision.reason,
      });
    } else {
      model = applyDeepThink(picked!, Boolean(body.deepThink));
    }
    const deepThinkApplied = !isAuto && Boolean(body.deepThink) && model.effort === "medium";

    // Auto 對話：user 訊息／對話記 "auto"，assistant 記實際派發模型
    const userModelTag = isAuto ? AUTO_MODEL_ID : model.id;
    if (!convId) convId = await createConversation(userId, dbContent.slice(0, 30), userModelTag);
    await addUserMessage(convId, dbContent, userModelTag);
    // 零成本靜默記憶：規則擷取自述背景／偏好（不另開模型請求）
    await maybeRememberFromUserMessage(userId, upstreamContent);

    const fullHistory: ChatMessage[] = (await listMessages(convId))
      .filter((m) => m.content.trim())
      .slice(-DB_HISTORY_READ)
      .map((m) => ({ role: m.role, content: m.content }));
    const history = slideMessagesForUpstream(fullHistory);

    // 當輪圖片只掛在最後一則 user（base64 不入庫）
    if (images.length && history.length) {
      const lastIdx = history.length - 1;
      if (history[lastIdx]?.role === "user") {
        history[lastIdx] = {
          role: "user",
          content: upstreamContent,
          images,
        };
      }
    }

    const extraSystemContext = (await buildUserMemoryContext(userId, convId)) || undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        send({ type: "conversation", conversationId: convId });
        const announceAuto = () => {
          if (!autoDecision) return;
          send({
            type: "auto_route",
            modelId: model.id,
            label: model.label,
            lane: autoDecision.lane,
            reason: autoDecision.reason,
          });
        };
        announceAuto();
        let answer = "";
        const triedAutoModels = new Set<string>();
        try {
          for (;;) {
            let streamed = false;
            try {
              for await (const ev of routeChat(model, history, userId, req.signal, extraSystemContext)) {
                if (ev.type === "text" || ev.type === "thinking") streamed = true;
                if (ev.type === "text") answer += ev.text;
                if (ev.type !== "done") {
                  send(ev);
                  continue;
                }
                await settleAssistantMessage({
                  userId,
                  conversationId: convId!,
                  content: answer,
                  model: model.id,
                  sourceId: ev.sourceId,
                  inputTokens: ev.usage.inputTokens,
                  cachedInputTokens: ev.usage.cachedInputTokens,
                  outputTokens: ev.usage.outputTokens,
                  officialCostPoints: ev.officialCostPoints,
                  chargedPoints: ev.chargedPoints,
                  quotaLabel: ev.usage.quotaLabel,
                  quotaUsedPct: ev.usage.quotaUsedPct,
                  quotaBeforePct: ev.usage.quotaRemainingBeforePct,
                  quotaAfterPct: ev.usage.quotaRemainingAfterPct,
                  upstreamModelVersion: ev.usage.upstreamModelVersion,
                  jobId: ev.jobId,
                });
                send({
                  ...ev,
                  balance: await balance(userId),
                  modelId: model.id,
                  effort: model.effort ?? null,
                  deepThink: deepThinkApplied,
                });
              }
              break;
            } catch (e) {
              // Auto 派到帳號目錄沒有的模型且尚未吐字 → 靜默改派下一個候選（最多再試 2 次）
              if (!autoInput || streamed || !(e instanceof ModelNotInCatalogError) || triedAutoModels.size >= 2) throw e;
              triedAutoModels.add(model.id);
              const next = await resolveAutoModel({ ...autoInput, excludeModelIds: triedAutoModels });
              if (!next) throw e;
              console.log("[auto-route] reroute", { from: model.id, to: next.model.id, reason: e.message });
              autoDecision = next;
              model = next.model;
              announceAuto();
            }
          }
        } catch (e) {
          // 買家按停止／斷線：不要寫成錯誤事件（否則下一輪易誤以為帳號掛了）
          if (!req.signal.aborted && !isAbortError(e)) {
            send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    return jsonError(e);
  }
}
