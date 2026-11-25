import { findModel, type ModelInfo } from "@/lib/models";
import { routeChat } from "@/lib/gateway";
import { AUTO_MODEL_ID, applyDeepThink, resolveAutoModel, type AutoDecision } from "@/lib/auto-router";
import { isAbortError, ModelNotInCatalogError, type ChatImage, type ChatMessage } from "@/lib/providers";
import {
  buildConversationStateContext,
  updateConversationStateAfterTurn,
} from "@/lib/conversation-state";
import { alignedTail, slideMessagesForUpstream } from "@/lib/context-window";
import { getSessionUser, jsonError } from "@/lib/auth";
import { cloudDbProxy } from "@/lib/cloud-api";
import { getFreeDailyStatus, getOrCreateGuestIdentity, isFreeTierModel } from "@/lib/free-tier";
import {
  addUserMessage,
  applyPersonaFromUserMessage,
  balance,
  buildStyleOverrideContext,
  buildUserMemoryContext,
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversation,
  listMessages,
  settleAssistantMessage,
} from "@/lib/store";
import { buildWorkspaceBrief } from "@/lib/strategy-loop";

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
    const comma = data.indexOf(",");
    if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
    out.push({ mimeType, data });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  try {
    const sessionUser = await getSessionUser(req);
    const guest = sessionUser ? null : getOrCreateGuestIdentity(req);
    const userId = sessionUser ? sessionUser.id : guest!.guestUserId;

    const body = (await req.json()) as {
      conversationId?: string;
      model: string;
      content?: string;
      images?: unknown;
      /** 僅 top 模型有效：改走 medium（單次 Cap 45） */
      deepThink?: boolean;
      /** Auto 專用：「改用主力模型重答」 */
      autoForce?: "main";
      /** 附加策略主體：注入主體共用記憶與各會議室摘要 */
      strategyWorkspaceId?: string;
    };

    const isAuto = body.model === AUTO_MODEL_ID;
    const picked = isAuto ? null : findModel(body.model);
    if (!isAuto && !picked) return Response.json({ error: "未知的模型" }, { status: 400 });

    const trimmed = (body.content ?? "").trim();
    const images = normalizeImages(body.images);
    if (!trimmed && images.length === 0) {
      return Response.json({ error: "訊息不能是空的" }, { status: 400 });
    }

    const upstreamContent = trimmed || "（見附圖）";
    const dbContent = images.length
      ? `[已上傳 ${images.length} 張圖片]\n${upstreamContent}`
      : upstreamContent;

    let convId = body.conversationId;
    const [userBal, convRow, priorRows] = await Promise.all([
      sessionUser ? balance(sessionUser.id) : Promise.resolve(0),
      convId ? getConversation(userId, convId) : Promise.resolve(null),
      convId ? listMessages(convId) : Promise.resolve([]),
    ]);
    if (convId && !convRow) {
      convId = undefined;
    }
    const prior = convId ? priorRows : [];

    const hasPaidAccess = Boolean(sessionUser && (sessionUser.isAdmin || userBal > 0));
    const freeMode = !hasPaidAccess;

    if (freeMode) {
      if (!isAuto && picked && !isFreeTierModel(picked)) {
        return Response.json(
          {
            error: sessionUser
              ? "此為高階模型，請先開通雲端工作台服務費方案（＋擴充）以解鎖全系列模型"
              : "此為高階模型，請先登入並開通雲端工作台服務費方案；目前可免費選用各家入門模型",
            code: "MODEL_LOCKED",
          },
          { status: 402 },
        );
      }
      const freeStatus = await getFreeDailyStatus({
        userId,
        isGuest: !sessionUser,
        ipBucketId: guest?.ipBucketId,
      });
      if (freeStatus.remaining <= 0) {
        return Response.json(
          {
            error: sessionUser
              ? `今日免費體驗額度（${freeStatus.limit} 則）已用完，請點左下「＋擴充」開通雲端工作台服務費方案，或明日 00:00 後再試`
              : `今日訪客免費體驗額度（${freeStatus.limit} 則）已用完，請點左下「登入」並開通雲端工作台服務費方案，或明日 00:00 後再試`,
            code: "FREE_QUOTA_EXHAUSTED",
          },
          { status: 402 },
        );
      }
    }

    let model: ModelInfo;
    let autoDecision: AutoDecision | null = null;
    let autoInput: Parameters<typeof resolveAutoModel>[0] | null = null;
    if (isAuto) {
      const lastAssistant = [...prior].reverse().find((m) => m.role === "assistant");
      autoInput = {
        text: upstreamContent,
        hasImages: images.length > 0,
        lastAssistant: lastAssistant ? { content: lastAssistant.content, model: lastAssistant.model } : undefined,
        forceMain: body.autoForce === "main",
        freeOnly: freeMode,
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
        freeMode,
        reason: autoDecision.reason,
      });
    } else {
      model = applyDeepThink(picked!, freeMode ? false : Boolean(body.deepThink));
    }
    const deepThinkApplied = !freeMode && !isAuto && Boolean(body.deepThink) && model.effort === "medium";

    const userModelTag = isAuto ? AUTO_MODEL_ID : model.id;
    let createdThisTurn = false;
    if (!convId) {
      convId = await createConversation(userId, dbContent.slice(0, 30), userModelTag);
      createdThisTurn = true;
    }
    const userMsgId = await addUserMessage(convId, dbContent, userModelTag);

    // 不再重讀 DB：用先前訊息＋本輪 user 組歷史
    const fullHistory: ChatMessage[] = alignedTail(
      [
        ...prior
          .filter((m) => m.content.trim())
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: dbContent },
      ],
      DB_HISTORY_READ,
    );
    const history = slideMessagesForUpstream(fullHistory);

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

    // 先寫入本輪語氣／事實記憶，再組裝注入（避免本輪 style 趕不上注入）
    try {
      await applyPersonaFromUserMessage({
        userId: sessionUser ? userId : null,
        conversationId: convId,
        content: upstreamContent,
        sourceMessageId: userMsgId,
      });
    } catch (memErr) {
      console.warn("[chat] persona remember failed", memErr instanceof Error ? memErr.message : memErr);
    }

    const workspaceId = sessionUser && typeof body.strategyWorkspaceId === "string" ? body.strategyWorkspaceId : "";
    const [userMemoryCtx, styleOverrideCtx, stateNoteCtx, workspaceCtx] = await Promise.all([
      sessionUser ? buildUserMemoryContext(userId, convId).then((s) => s || "") : Promise.resolve(""),
      buildStyleOverrideContext(sessionUser ? userId : null, convId),
      buildConversationStateContext(convId),
      workspaceId
        ? buildWorkspaceBrief(userId, workspaceId)
            .then((r) =>
              r.text
                ? `【使用者附加的策略主體：以下是主體共用記憶與各會議室的最新摘要，回答相關問題時以此為準】\n${r.text}`
                : "",
            )
            .catch((e) => {
              console.warn("[chat] workspace brief failed", e instanceof Error ? e.message : e);
              return "";
            })
        : Promise.resolve(""),
    ]);
    // 事實／狀態 → 非當前指令；語氣 → 獨立 styleOverride 通道
    const extraSystemContext =
      [stateNoteCtx, userMemoryCtx, workspaceCtx].filter((s) => s.trim()).join("\n\n") || undefined;
    const styleOverrideContext = styleOverrideCtx.trim() || undefined;

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
        let settled = false;
        let lastSourceId = "";
        const triedAutoModels = new Set<string>();
        try {
          for (;;) {
            let streamed = false;
            try {
              for await (const ev of routeChat(
                model,
                history,
                userId,
                req.signal,
                extraSystemContext,
                undefined,
                styleOverrideContext,
                { cacheAffinityId: convId! },
              )) {
                if (ev.type === "text" || ev.type === "thinking") streamed = true;
                if (ev.type === "text") answer += ev.text;
                if (ev.type === "source" && typeof (ev as { sourceId?: string }).sourceId === "string") {
                  lastSourceId = (ev as { sourceId: string }).sourceId;
                }
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
                  chargedPoints: freeMode ? 0 : ev.chargedPoints,
                  quotaLabel: ev.usage.quotaLabel,
                  quotaUsedPct: ev.usage.quotaUsedPct,
                  quotaBeforePct: ev.usage.quotaRemainingBeforePct,
                  quotaAfterPct: ev.usage.quotaRemainingAfterPct,
                  upstreamModelVersion: ev.usage.upstreamModelVersion,
                  jobId: ev.jobId,
                  freeMode,
                  ipBucketId: guest?.ipBucketId,
                });
                settled = true;
                // 本串狀態筆記：吸收本輪＋視窗外舊訊（整則邊界）；失敗不擋回答
                try {
                  const latest = await listMessages(convId!);
                  await updateConversationStateAfterTurn({
                    conversationId: convId!,
                    messages: latest,
                  });
                } catch (stateErr) {
                  console.warn(
                    "[conversation-state] update failed",
                    stateErr instanceof Error ? stateErr.message : stateErr,
                  );
                }
                const nextBal = sessionUser ? await balance(userId) : undefined;
                const nextFree = await getFreeDailyStatus({
                  userId,
                  isGuest: !sessionUser,
                  ipBucketId: guest?.ipBucketId,
                });
                send({
                  ...ev,
                  chargedPoints: freeMode ? 0 : ev.chargedPoints,
                  balance: nextBal,
                  hasPaidAccess: sessionUser ? sessionUser.isAdmin || (nextBal ?? 0) > 0 : false,
                  freeQuota: nextFree,
                  freeMode,
                  modelId: model.id,
                  effort: model.effort ?? null,
                  deepThink: deepThinkApplied,
                });
              }
              break;
            } catch (e) {
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
          if (!req.signal.aborted && !isAbortError(e)) {
            send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          }
        } finally {
          // 連線中斷／停止：
          // - 已有半截回覆 → 寫入 DB（不扣點），讓手機等其他裝置還看得到
          // - 完全沒產出 → 回滾本輪，避免空對話／重複附件
          if (!settled && req.signal.aborted) {
            try {
              const partial = answer.trim();
              if (partial) {
                const note = `${partial}\n\n（連線中斷或已停止，回覆未完成）`;
                await settleAssistantMessage({
                  userId,
                  conversationId: convId!,
                  content: note,
                  model: model.id,
                  sourceId: lastSourceId || "interrupted",
                  inputTokens: 0,
                  cachedInputTokens: 0,
                  outputTokens: 0,
                  officialCostPoints: 0,
                  chargedPoints: 0,
                  freeMode: true,
                  ipBucketId: guest?.ipBucketId,
                });
                try {
                  send({
                    type: "done",
                    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
                    officialCostPoints: 0,
                    chargedPoints: 0,
                    sourceId: lastSourceId || "interrupted",
                    completionStatus: "failed",
                    modelId: model.id,
                  });
                } catch {
                  /* 客戶端已斷線時 enqueue 可能失敗，忽略 */
                }
              } else if (createdThisTurn) {
                await deleteConversation(userId, convId!);
              } else {
                await deleteMessage(convId!, userMsgId);
              }
            } catch (rollbackErr) {
              console.warn(
                "[chat] abort rollback/partial save failed",
                rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
              );
            }
          }
          controller.close();
        }
      },
    });

    const headers = new Headers({
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    if (guest?.setCookieHeader) headers.append("Set-Cookie", guest.setCookieHeader);
    return new Response(stream, { headers });
  } catch (e) {
    return jsonError(e);
  }
}
