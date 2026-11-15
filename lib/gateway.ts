import { createHash } from "node:crypto";
import { chargePointsFromUsd, officialCostUsd, type ModelInfo, type Usage } from "./models";
import { candidatesFor, markFailure, markSuccess, type Source } from "./sources";
import {
  ClientAbortError,
  isAbortError,
  ModelNotInCatalogError,
  sourceCatalogLacksModel,
  streamFrom,
  UpstreamError,
  type ChatMessage,
} from "./providers";
import { enqueueInferenceJob, streamJobResult } from "./inference-jobs";
import { listOnlineNodesForModel } from "./node-registry";
import { releaseSourceLock, tryAcquireSourceLock } from "./source-lock";
import { slideMessagesForUpstream } from "./context-window";

/** 停止後立刻再問：短暫重試拿鎖，等上一輪 abort 釋放（避免誤判 busy／亂接力） */
async function tryAcquireSourceLockBriefly(
  sourceId: string,
  signal?: AbortSignal,
  attempts = 8,
  gapMs = 40,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return false;
    if (tryAcquireSourceLock(sourceId)) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

export type GatewayEvent =
  | { type: "source"; sourceId: string; label: string; kind: Source["kind"] }
  | { type: "failover"; from: string; reason: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "done";
      usage: Usage;
      officialCostPoints: number;
      chargedPoints: number;
      sourceId: string;
      jobId?: string;
      upstreamModelId?: string;
      upstreamModelVersion?: string;
      viaDailyBypass?: boolean;
      groundingSources?: { title: string; uri: string }[];
      webSearchQueries?: string[];
    };

export class NoSourceError extends Error {}

function safetyIdFor(userId: string): string {
  return createHash("sha256").update(`user:${userId}`).digest("hex").slice(0, 64);
}

function resolveNodeRoute(model: ModelInfo): { providerKey: string; upstreamModel: string } | null {
  if (model.nodeProviderKey && model.nodeUpstreamModel) {
    return { providerKey: model.nodeProviderKey, upstreamModel: model.nodeUpstreamModel };
  }
  if (model.antigravityId) {
    return { providerKey: "antigravity", upstreamModel: model.antigravityId };
  }
  if (model.codexId) {
    return { providerKey: "chatgpt-codex", upstreamModel: model.codexId };
  }
  return null;
}

async function* streamViaNodeAgent(
  model: ModelInfo,
  messages: ChatMessage[],
  userId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
): AsyncGenerator<GatewayEvent> {
  const route = resolveNodeRoute(model);
  if (!route) throw new UpstreamError(400, "此模型未設定 Node Agent 路由");

  const nodes = listOnlineNodesForModel(route.providerKey, route.upstreamModel);
  if (!nodes.length) {
    throw new UpstreamError(503, `沒有在線節點可執行 ${route.providerKey}:${route.upstreamModel}`);
  }

  const job = enqueueInferenceJob({
    userId,
    modelId: model.id,
    providerKey: route.providerKey,
    upstreamModel: route.upstreamModel,
    messages,
    extraSystemContext,
    customSystemPrompt,
  });

  yield {
    type: "source",
    sourceId: `node:${job.assignedNodeId ?? "queued"}`,
    label: `Node Agent ${job.assignedNodeId?.slice(0, 8) ?? "排隊中"}`,
    kind: "supplier",
  };

  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for await (const ev of streamJobResult(job.id, signal)) {
    if (ev.type === "text" || ev.type === "thinking") yield ev;
    else {
      usage = {
        inputTokens: ev.usage.inputTokens,
        cachedInputTokens: ev.usage.cachedInputTokens,
        outputTokens: ev.usage.outputTokens,
        upstreamModelId: route.upstreamModel,
      };
    }
  }

  const { getJob } = await import("./inference-jobs");
  const done = getJob(job.id);
  const fallback = chargePointsFromUsd(officialCostUsd(model, usage), model.tier, model.effort);
  yield {
    type: "done",
    usage,
    officialCostPoints: done?.platformCostPoints ?? fallback.officialCostPoints,
    chargedPoints: done?.chargedPoints ?? fallback.chargedPoints,
    sourceId: `node:${done?.assignedNodeId ?? job.assignedNodeId ?? "unknown"}`,
    jobId: job.id,
    upstreamModelId: route.upstreamModel,
  };
}

/**
 * 混合算力水庫：
 * 1) 有對應 Node Agent → 優先派工
 * 2) 否則／failover → oauth_sub（C=1 鎖）+ api_key + OpenRouter
 */
export async function* routeChat(
  model: ModelInfo,
  messages: ChatMessage[],
  userId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
): AsyncGenerator<GatewayEvent> {
  const upstreamMessages = slideMessagesForUpstream(messages);
  const ctx = extraSystemContext?.trim() || undefined;
  const customSys = customSystemPrompt?.trim() || undefined;

  const route = resolveNodeRoute(model);
  const nodeAvailable =
    route && listOnlineNodesForModel(route.providerKey, route.upstreamModel).length > 0;

  if (model.category === "node-agent" || nodeAvailable) {
    try {
      yield* streamViaNodeAgent(model, upstreamMessages, userId, signal, ctx, customSys);
      return;
    } catch (e) {
      const err = e instanceof UpstreamError ? e : new UpstreamError(0, e instanceof Error ? e.message : String(e));
      if (model.category === "node-agent" || !err.retryable) throw err;
      yield { type: "failover", from: "Node Agent", reason: `${err.status}` };
    }
  }

  // 混合水庫：含 oauth_sub；candidatesFor 已過濾 share_limit / cooldown
  const allCandidates = candidatesFor(model);
  if (allCandidates.length === 0) {
    throw new NoSourceError(
      "目前沒有可用貨源。請綁定訂閱／API Key，或啟動 Node Agent。",
    );
  }
  const candidates = allCandidates.filter((c) => !sourceCatalogLacksModel(c.source.id, model));
  if (candidates.length === 0) {
    throw new ModelNotInCatalogError(`目前綁定的帳號都沒有開放「${model.label}」，請改選其他模型。`);
  }

  const safetyId = safetyIdFor(userId);
  let lastError = "";
  let catalogMisses = 0;

  for (const c of candidates) {
    if (signal?.aborted) throw new ClientAbortError();

    const needsLock = c.source.authType === "oauth_sub";
    if (needsLock && !(await tryAcquireSourceLockBriefly(c.source.id, signal))) {
      if (signal?.aborted) throw new ClientAbortError();
      yield { type: "failover", from: c.source.label, reason: "busy" };
      continue;
    }

    let started = false;
    let usage: Usage | null = null;
    try {
      for await (const ev of streamFrom(c, model, upstreamMessages, safetyId, signal, ctx, customSys)) {
        if (ev.type === "text" || ev.type === "thinking") {
          if (!started) {
            started = true;
            yield { type: "source", sourceId: c.source.id, label: c.source.label, kind: c.source.kind };
          }
          yield ev;
        } else {
          usage = ev.usage;
        }
      }
      markSuccess(c.source.id);
      const u = usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      const bill = chargePointsFromUsd(officialCostUsd(model, u), model.tier, model.effort);
      yield {
        type: "done",
        usage: u,
        officialCostPoints: bill.officialCostPoints,
        chargedPoints: bill.chargedPoints,
        sourceId: c.source.id,
        upstreamModelId: u.upstreamModelId,
        upstreamModelVersion: u.upstreamModelVersion,
        viaDailyBypass: u.viaDailyBypass,
        groundingSources: u.groundingSources,
        webSearchQueries: u.webSearchQueries,
      };
      return;
    } catch (e) {
      // 買家停止／斷線：釋放鎖即可，絕對不要 markFailure 把帳號打進冷卻
      if (signal?.aborted || isAbortError(e)) {
        throw e instanceof ClientAbortError ? e : new ClientAbortError();
      }
      // 目錄沒有此模型：帳號本身正常，不冷卻（否則同帳號的其他模型也會被連坐 30 秒）
      if (e instanceof ModelNotInCatalogError && !started) {
        catalogMisses++;
        lastError = `${c.source.label}：${e.message}`;
        continue;
      }
      const err = e instanceof UpstreamError ? e : new UpstreamError(0, e instanceof Error ? e.message : String(e));
      markFailure(c.source.id, err.status, err.message);
      lastError = `${c.source.label}：${err.status} ${err.message}`;
      if (started || !err.retryable) throw err;
      yield { type: "failover", from: c.source.label, reason: `${err.status}` };
    } finally {
      if (needsLock) releaseSourceLock(c.source.id);
    }
  }
  if (catalogMisses > 0 && catalogMisses === candidates.length) {
    throw new ModelNotInCatalogError(`目前綁定的帳號都沒有開放「${model.label}」，請改選其他模型。`);
  }
  throw new NoSourceError(`所有貨源都失敗了。最後一個錯誤：${lastError}`);
}
