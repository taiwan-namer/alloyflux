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
import { enqueueInferenceJob, streamJobResult, sweepStaleJobs } from "./inference-jobs";
import { listOnlineNodesForModel } from "./node-registry";
import { releaseSourceLock, tryAcquireSourceLock } from "./source-lock";
import { slideMessagesForUpstream } from "./context-window";
import { listSources } from "./sources";
import {
  attachResearchToDone,
  gateEvidence,
  modelNeedsPlatformResearch,
  preparePlatformResearch,
  withPlatformResearchScope,
  type ResearchVerdict,
} from "./research-v2";
import { planResearch } from "./research-v2/planner";
import {
  loadLastSourceForAffinity,
  loadPreferredSource,
  preferSourceFirst,
  savePreferredSource,
  stickyKeyFor,
} from "./prompt-cache-sticky";

export type RouteChatOptions = {
  /**
   * 只用這段文字判斷是否即時查證（而非最後一則 user 全文）。
   * 空字串＝本次不查證；provider 端也不會再自行查。
   */
  researchQuery?: string;
  /**
   * 平台使用者側的快取黏著鍵（聊天 conversationId／會議室 sessionId）。
   * 跟供給者 ChatGPT 帳號無關；連續輪次必須相同才能命中快取。
   */
  cacheAffinityId?: string;
};

function skippedResearchVerdict(): ResearchVerdict {
  const plan = planResearch({ text: "" });
  return gateEvidence({ plan: { ...plan, intent: "skip", requireLive: false }, corpus: null });
}

/** 停止後立刻再問：短暫重試拿鎖，等上一輪 abort 釋放（避免誤判 busy／亂接力） */
async function tryAcquireSourceLockBriefly(
  sourceId: string,
  signal?: AbortSignal,
  attempts = 24,
  gapMs = 50,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return false;
    if (tryAcquireSourceLock(sourceId)) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

/**
 * 停止後立刻重送：上一輪 job 可能尚佔 concurrency（cancel 寫庫競態）。
 * 短暫重試等節點空位，避免誤報「沒有可用貨源」。
 */
async function listOnlineNodesBriefly(
  providerKey: string,
  modelId: string,
  signal?: AbortSignal,
  attempts = 16,
  gapMs = 50,
): Promise<Awaited<ReturnType<typeof listOnlineNodesForModel>>> {
  // 先清逾時卡住的 assigned／running，避免 concurrency 假滿
  try {
    await sweepStaleJobs();
  } catch {
    /* ignore */
  }
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return [];
    const nodes = await listOnlineNodesForModel(providerKey, modelId);
    if (nodes.length) return nodes;
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, gapMs));
  }
  return [];
}

/** 把「真的沒貨源」拆成可行動的原因（Node 離線／忙碌／模型未掛能力／委託後無備援） */
async function explainEmptySupply(model: ModelInfo): Promise<string> {
  const route = resolveNodeRoute(model);
  const sources = await listSources();
  const enabled = sources.filter((s) => s.enabled && !s.removedAt);
  const delegated = enabled.filter((s) => s.delegatedToNode);
  const localish = enabled.filter((s) => !s.delegatedToNode);

  if (!route) {
    if (localish.length === 0 && delegated.length > 0) {
      return "訂閱憑證已委託給 Node Agent，但此模型沒有 Node 路由；請啟動節點或改選有備援的模型。";
    }
    return "目前沒有可用貨源。請綁定訂閱／API Key，或啟動 Node Agent。";
  }

  const capable = await listOnlineNodesForModel(route.providerKey, route.upstreamModel, {
    ignoreLoad: true,
  });
  const free = await listOnlineNodesForModel(route.providerKey, route.upstreamModel);
  if (capable.length === 0) {
    return `沒有在線節點支援「${model.label}」（${route.providerKey}:${route.upstreamModel}）。請確認 Node Agent 在線，並在後台刷新／掛上此模型能力。`;
  }
  if (free.length === 0) {
    return "算力節點在線但忙碌中（concurrency 已滿或有卡住任務）。請稍候再送，或檢查是否有未結束的 inference job。";
  }
  if (localish.length === 0 && delegated.length > 0) {
    return "訂閱憑證在節點端，平台本地無備援貨源；節點瞬間不可用時會出現此訊息，請再試一次或確認 Node Agent 心跳。";
  }
  return "目前沒有可用貨源。請綁定訂閱／API Key，或啟動 Node Agent。";
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
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<GatewayEvent> {
  const route = resolveNodeRoute(model);
  if (!route) throw new UpstreamError(400, "此模型未設定 Node Agent 路由");

  const nodes = await listOnlineNodesBriefly(route.providerKey, route.upstreamModel, signal);
  if (!nodes.length) {
    throw new UpstreamError(503, await explainEmptySupply(model));
  }

  const job = await enqueueInferenceJob({
    userId,
    modelId: model.id,
    providerKey: route.providerKey,
    upstreamModel: route.upstreamModel,
    messages,
    extraSystemContext,
    styleOverrideContext,
    customSystemPrompt,
    cacheAffinityId,
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
        groundingSources: ev.usage.groundingSources ?? usage.groundingSources,
        webSearchQueries: ev.usage.webSearchQueries ?? usage.webSearchQueries,
      };
    }
  }

  const { getJob } = await import("./inference-jobs");
  const done = await getJob(job.id);
  const fallback = chargePointsFromUsd(officialCostUsd(model, usage), model.tier, model.effort);
  yield {
    type: "done",
    usage,
    officialCostPoints: done?.platformCostPoints ?? fallback.officialCostPoints,
    chargedPoints: done?.chargedPoints ?? fallback.chargedPoints,
    sourceId: `node:${done?.assignedNodeId ?? job.assignedNodeId ?? "unknown"}`,
    jobId: job.id,
    upstreamModelId: route.upstreamModel,
    groundingSources: usage.groundingSources,
    webSearchQueries: usage.webSearchQueries,
  };
}

/**
 * 混合算力水庫：
 * 1) 平台先跑一次 Research V2（Node／local 共用，failover 不重跑）
 * 2) 有對應 Node Agent → 優先派工（注入相同查證）
 * 3) 否則／failover → oauth_sub（C=1 鎖）+ api_key + OpenRouter
 */
export async function* routeChat(
  model: ModelInfo,
  messages: ChatMessage[],
  userId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  options?: RouteChatOptions,
): AsyncGenerator<GatewayEvent> {
  const upstreamMessages = slideMessagesForUpstream(messages);
  const ctx = extraSystemContext?.trim() || undefined;
  const customSys = customSystemPrompt?.trim() || undefined;
  const styleCtx = styleOverrideContext?.trim() || undefined;
  const cacheAffinityId = options?.cacheAffinityId?.trim() || undefined;

  const route = resolveNodeRoute(model);
  const nodeAvailable =
    route &&
    (await listOnlineNodesBriefly(route.providerKey, route.upstreamModel, signal)).length > 0;

  const supplyPath = nodeAvailable || model.category === "node-agent" ? "node" : "local";
  const researchQuery = options?.researchQuery;
  let prepared: ResearchVerdict | null = null;
  if (researchQuery !== undefined) {
    const q = researchQuery.trim();
    prepared = q
      ? await preparePlatformResearch({ messages: [{ role: "user", content: q }], supplyPath, signal })
      : null;
    prepared ??= skippedResearchVerdict();
  } else if (modelNeedsPlatformResearch(model)) {
    prepared = await preparePlatformResearch({
      messages: upstreamMessages.map((m) => ({ role: m.role, content: m.content })),
      supplyPath,
      signal,
    });
  }

  // P0-1：Node 無 ALS → 注入進 extraSystemContext；Local 由 withResearchSystem＋ALS 重用，禁止雙重注入
  const ctxForNode =
    prepared?.injectionText
      ? [ctx, prepared.injectionText].filter(Boolean).join("\n\n")
      : ctx;
  const ctxForLocal = ctx;

  async function* routeBody(): AsyncGenerator<GatewayEvent> {
    if (model.category === "node-agent" || nodeAvailable) {
      try {
        for await (const ev of streamViaNodeAgent(
          model,
          upstreamMessages,
          userId,
          signal,
          ctxForNode,
          customSys,
          styleCtx,
          cacheAffinityId,
        )) {
          yield attachResearchToDone(ev, prepared);
        }
        return;
      } catch (e) {
        // 買家停止：不可包成 retryable UpstreamError 再去打本地貨源（易誤冷卻／空貨源）
        if (signal?.aborted || isAbortError(e)) {
          throw e instanceof ClientAbortError ? e : new ClientAbortError();
        }
        const err =
          e instanceof UpstreamError ? e : new UpstreamError(0, e instanceof Error ? e.message : String(e));
        if (model.category === "node-agent" || !err.retryable) throw err;
        yield { type: "failover", from: "Node Agent", reason: `${err.status}` };
      }
    }

    yield* routeLocalCandidates(
      model,
      upstreamMessages,
      userId,
      signal,
      ctxForLocal,
      customSys,
      prepared,
      styleCtx,
      cacheAffinityId,
    );
  }

  yield* withPlatformResearchScope(prepared, supplyPath, routeBody());
}

async function* routeLocalCandidates(
  model: ModelInfo,
  upstreamMessages: ChatMessage[],
  userId: string,
  signal: AbortSignal | undefined,
  ctx: string | undefined,
  customSys: string | undefined,
  prepared: ResearchVerdict | null,
  styleCtx?: string,
  cacheAffinityId?: string,
): AsyncGenerator<GatewayEvent> {
  // 混合水庫：含 oauth_sub；candidatesFor 已過濾 share_limit / cooldown／delegatedToNode
  const allCandidates = await candidatesFor(model);
  if (allCandidates.length === 0) {
    throw new NoSourceError(await explainEmptySupply(model));
  }
  const eligible = allCandidates.filter((c) => !sourceCatalogLacksModel(c.source.id, model));
  if (eligible.length === 0) {
    throw new ModelNotInCatalogError(`目前綁定的帳號都沒有開放「${model.label}」，請改選其他模型。`);
  }
  // 以平台使用者／對話為黏著鍵：同一對話優先沿用上次成功的供給來源（額度內才黏）
  const stickyKey = stickyKeyFor(userId, model.id, cacheAffinityId);
  let preferredSourceId = await loadPreferredSource(stickyKey);
  if (!preferredSourceId && cacheAffinityId) {
    preferredSourceId = await loadLastSourceForAffinity(cacheAffinityId);
  }
  const candidates = preferSourceFirst(eligible, preferredSourceId);

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
      for await (const ev of streamFrom(
        c,
        model,
        upstreamMessages,
        safetyId,
        signal,
        ctx,
        customSys,
        styleCtx,
        cacheAffinityId,
      )) {
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
      void savePreferredSource(stickyKey, c.source.id);
      const u = usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      const bill = chargePointsFromUsd(officialCostUsd(model, u), model.tier, model.effort);
      yield attachResearchToDone(
        {
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
        },
        prepared,
      );
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
