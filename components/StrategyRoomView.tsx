"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  DISPATCH_STATUS_LABEL,
  LEDGER_STATUS_LABEL,
  MEMBER_ROLE_LABEL,
  PAUSE_STATE_LABEL,
  dispatchText,
  speakerBadge,
  strategyStatusLabel,
  type PauseAction,
  type StrategyDispatchItem,
  type StrategyLedger,
  type StrategyLedgerItem,
  type StrategyMemberConfig,
  type StrategyMemberRole,
  type StrategyModelOption,
  type StrategySessionDetail,
  type StrategySessionMessage,
  type StrategyStreamEvent,
  type StrategySyncResponse,
  type StrategyTemplateInfo,
  type StreamingMemberBubble,
  type ViewMode,
} from "@/components/strategy-types";
import SafeLightMarkdown from "@/components/SafeLightMarkdown";
import { createAdaptiveDripDriver, typewriterTakeCount } from "@/lib/adaptive-drip";
import {
  applyServerTemplateId,
  beginTemplateSave,
  displayTemplateId,
  markTemplateSaveOk,
  shouldPatchTemplateSelection,
  shouldRollbackTemplate,
  type SopTemplateGate,
} from "@/lib/sop-template-sync";
import {
  buildModelFamilies,
  familyIdOf,
  familyOptionText,
  familyOptionTitle,
  resolveFamilyModelId,
  stripEffortSuffix,
  uiEffortOf,
  type ModelFamilyOption,
} from "@/lib/strategy-model-family";

export type StrategyRoomViewProps = {
  detail: StrategySessionDetail;
  draft: string;
  onDraftChange: (v: string) => void;
  dispatchSelected: Set<string>;
  onDispatchSelectedChange: (next: Set<string>) => void;
  wsMemoryDraft: string;
  onWsMemoryChange: (v: string) => void;
  wsMemoryDirty: boolean;
  busy: boolean;
  error: string | null;
  onError: (msg: string | null) => void;
  canSplit: boolean;
  viewMode: ViewMode;
  models: StrategyModelOption[];
  templates: StrategyTemplateInfo[];
  default3AiPreset: StrategyMemberConfig[];
  onToggleSplit: () => void;
  onBackToChat: () => void;
  onOpenSidebar: () => void;
  onRefresh: () => void;
  onStreamCommitted: (sessionId: string) => Promise<void>;
  onRefreshWallet: () => void;
  onStreamingChange: (streaming: boolean) => void;
  onDecideDispatch: (action: "dispatch" | "reject") => void;
  onToggleAutoDispatch: (next: boolean) => void;
  onSaveMemory: () => void;
  onPauseAction: (action: PauseAction) => void;
  onMarkDispatchDone: (dispatchId: string) => void;
  onSyncPatch: (data: Extract<StrategySyncResponse, { changed: true }>) => void;
  /** 4A：prepend 更舊歷史 */
  onOlderMessages?: (payload: {
    messages: StrategySessionMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    messageTotal: number;
  }) => void;
  onPatchSessionMeta: (patch: {
    models?: StrategyMemberConfig[];
    templateId?: string;
  }) => Promise<boolean>;
  wsMemorySaving?: boolean;
};

function messageRoleLabel(m: StrategySessionMessage) {
  if (m.role === "assistant") {
    return (
      <>
        <span className="strategy-role-badge">{speakerBadge(m)}</span>
        {m.speakerModel ? <span className="muted"> · {m.speakerModel}</span> : null}
      </>
    );
  }
  if (m.role === "user") {
    if (m.structured?.source === "web") return "你（網頁）";
    if (m.structured?.source === "cursor") return "Cursor";
    return "Cursor／你";
  }
  return "系統";
}

type MessageItemProps = {
  m: StrategySessionMessage;
};

const MessageItem = memo(
  function MessageItem({ m }: MessageItemProps) {
    return (
      <div className={`strategy-msg strategy-msg-${m.role}`}>
        <div className="strategy-msg-role">{messageRoleLabel(m)}</div>
        {m.role === "assistant" &&
        (m.completionStatus === "partial" || m.completionStatus === "aborted") ? (
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            回覆未完成，這是重新整理前已保存的部分
          </div>
        ) : null}
        {m.role === "assistant" ? (
          <div className="strategy-msg-body strategy-md-body">
            <SafeLightMarkdown content={m.content} />
          </div>
        ) : (
          <pre className="strategy-msg-body">{m.content}</pre>
        )}
      </div>
    );
  },
  (a, b) =>
    a.m.id === b.m.id &&
    a.m.content === b.m.content &&
    a.m.role === b.m.role &&
    a.m.speakerLabel === b.m.speakerLabel &&
    a.m.speakerModel === b.m.speakerModel &&
    a.m.speakerRole === b.m.speakerRole &&
    a.m.structured?.source === b.m.structured?.source &&
    a.m.completionStatus === b.m.completionStatus,
);

/** 歷史訊息：串流更新（streamBubbles／pendingUser）不會重繪此區 */
const HistoryMessages = memo(function HistoryMessages(props: {
  messages: StrategySessionMessage[];
}) {
  const { messages } = props;
  return (
    <>
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} />
      ))}
    </>
  );
});

function modelOptionTitle(opt: StrategyModelOption): string {
  const parts = [opt.label];
  if (opt.categoryLabel) parts.push(opt.categoryLabel);
  if (!opt.available) parts.push(opt.note?.trim() || "暫不可用");
  else if (opt.note?.trim()) parts.push(opt.note.trim());
  return parts.join("｜");
}

/** 往上滑一次只補幾則，不把更早的歷史一次載完 */
const STRATEGY_OLDER_PAGE = 5;

export default function StrategyRoomView(props: StrategyRoomViewProps) {
  const {
    detail,
    draft,
    onDraftChange,
    dispatchSelected,
    onDispatchSelectedChange,
    wsMemoryDraft,
    onWsMemoryChange,
    busy,
    error,
    onError,
    canSplit,
    viewMode,
    models,
    templates,
    default3AiPreset,
    onToggleSplit,
    onBackToChat,
    onOpenSidebar,
    onRefresh,
    onStreamCommitted,
    onRefreshWallet,
    onStreamingChange,
    onDecideDispatch,
    onToggleAutoDispatch,
    onSaveMemory,
    onPauseAction,
    onMarkDispatchDone,
    onSyncPatch,
    onOlderMessages,
    onPatchSessionMeta,
    wsMemorySaving,
  } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** generating：串流接收中；committing 保留相容（#9 後收尾改背景，不再擋輸入／送出） */
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const streaming = generating;
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streamBubbles, setStreamBubbles] = useState<StreamingMemberBubble[]>([]);
  /** 上一輪串流氣泡尚未進歷史時又開新回合：暫留顯示，避免主持人回覆被清掉 */
  const [parkedBubbles, setParkedBubbles] = useState<StreamingMemberBubble[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [degradedHint, setDegradedHint] = useState(false);
  const [memberDraft, setMemberDraft] = useState<StrategyMemberConfig[]>([]);
  const [templateDraft, setTemplateDraft] = useState("");
  const [metaSaving, setMetaSaving] = useState(false);
  const templateGateRef = useRef<SopTemplateGate | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const reconcileRunRef = useRef<number | null>(null);

  const roomScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  /** 補上更早訊息後維持原本視線，避免捲動被拉回頂端 */
  const olderScrollAdjustRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const loadingOlderRef = useRef(false);
  /** 一次上滑只補一頁；離開頂端後才允許再補，避免連載整段歷史 */
  const olderArmedRef = useRef(true);
  const syncAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const streamRunIdRef = useRef(0);
  const streamContentRef = useRef("");
  const streamCommittingRef = useRef(false);
  /** done 後保留串流氣泡直到歷史訊息進畫面，避免閃空白 */
  const handoffPendingRef = useRef(false);
  const abortReasonRef = useRef<"user" | "switch" | null>(null);
  /** 已接收串流緩衝（權威內容；動畫不得改寫） */
  const bubblesRef = useRef<StreamingMemberBubble[]>([]);
  const dripDriverRef = useRef(createAdaptiveDripDriver());
  const remoteDripRef = useRef(createAdaptiveDripDriver(undefined, undefined, typewriterTakeCount));
  const remoteSeededRef = useRef<Set<string>>(new Set());
  const [remoteBubble, setRemoteBubble] = useState<StreamingMemberBubble | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seenSessionIdRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const toastSeqRef = useRef(0);
  const onStreamingChangeRef = useRef(onStreamingChange);
  const lastUpdatedAtRef = useRef(detail.session.updatedAt || 0);
  const lastMessageCountRef = useRef(detail.messages.length || 0);
  const sessionIdRef = useRef(detail.session.id);
  const streamingRef = useRef(false);
  const onSyncPatchRef = useRef(onSyncPatch);
  /** 本機最新一則的游標（createdAt:id），sync 用來補齊之後的訊息 */
  const newestCursorRef = useRef("");
  const onStreamCommittedRef = useRef(onStreamCommitted);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pauseState = detail.session.pauseState ?? "none";
  const paused = pauseState !== "none";
  const pending = detail.dispatch.filter((d) => d.status === "pending");
  const dispatchedCount = detail.dispatch.filter((d) => d.status === "dispatched").length;
  const sessionId = detail.session.id;

  const fallbackTemplateId =
    templates.find((t) => t.id === "automax")?.id || templates[0]?.id || "automax";
  const serverTemplateRaw = detail.session.templateId ?? null;
  const activeTemplateId = displayTemplateId(templateDraft, serverTemplateRaw, fallbackTemplateId);
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? templates[0];

  streamingRef.current = streaming;
  const generatingRef = useRef(false);
  generatingRef.current = generating;
  onSyncPatchRef.current = onSyncPatch;
  const newestMsg = detail.messages[detail.messages.length - 1];
  newestCursorRef.current = newestMsg ? `${newestMsg.createdAt}:${newestMsg.id}` : "";
  onStreamingChangeRef.current = onStreamingChange;
  onStreamCommittedRef.current = onStreamCommitted;

  const publishDrip = useCallback((snap: ReturnType<typeof dripDriverRef.current.snapshot>) => {
    const mapped: StreamingMemberBubble[] = snap.map((b) => ({
      key: b.key,
      role: b.role,
      modelId: b.modelId,
      label: b.label,
      content: b.displayed,
      done: b.done,
    }));
    // 不用 flushSync：每幀強制同步 render＋Markdown 會卡住主執行緒（體感當機）
    setStreamBubbles(mapped);
    const el = roomScrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const syncDripFromReceived = useCallback(() => {
    const driver = dripDriverRef.current;
    for (const b of bubblesRef.current) {
      driver.upsert({
        key: b.key,
        role: b.role,
        modelId: b.modelId,
        label: b.label,
        received: b.content,
        done: b.done,
      });
    }
    driver.schedule(publishDrip);
  }, [publishDrip]);

  const flushDripNow = useCallback(() => {
    const driver = dripDriverRef.current;
    for (const b of bubblesRef.current) {
      driver.upsert({
        key: b.key,
        role: b.role,
        modelId: b.modelId,
        label: b.label,
        received: b.content,
        done: b.done,
      });
    }
    publishDrip(driver.flushDisplay());
  }, [publishDrip]);

  /** 可見文字結束：立刻解鎖 composer；歷史 sync 仍等 done */
  const unlockComposerAfterVisible = useCallback(() => {
    flushDripNow();
    bubblesRef.current = bubblesRef.current.map((b) => ({ ...b, done: true }));
    setStreamBubbles((prev) => prev.map((b) => ({ ...b, done: true })));
    handoffPendingRef.current = true;
    streamCommittingRef.current = false;
    setCommitting(false);
    setGenerating(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [flushDripNow]);
  const unlockComposerAfterVisibleRef = useRef(unlockComposerAfterVisible);
  unlockComposerAfterVisibleRef.current = unlockComposerAfterVisible;

  const clearDripAndBubbles = useCallback(() => {
    dripDriverRef.current.stopAndClear();
    bubblesRef.current = [];
  }, []);

  /** 失效目前串流：++runId、停止拆吐、cancel reader、abort controller、清空緩衝 */
  const invalidateStream = useCallback(
    (reason: "user" | "switch") => {
      streamRunIdRef.current += 1;
      abortReasonRef.current = reason;
      clearDripAndBubbles();
      const reader = streamReaderRef.current;
      streamReaderRef.current = null;
      if (reader) {
        try {
          void reader.cancel().catch(() => {});
        } catch {
          /* ignore */
        }
      }
      const ctrl = streamAbortRef.current;
      streamAbortRef.current = null;
      ctrl?.abort();
      streamCommittingRef.current = false;
    },
    [clearDripAndBubbles],
  );

  const scrollIfSticky = useCallback(() => {
    const el = roomScrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    onStreamingChange(streaming);
  }, [streaming, onStreamingChange]);

  // 卸載：失效串流與計時器（不還原草稿）
  useEffect(() => {
    return () => {
      invalidateStream("switch");
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      onStreamingChangeRef.current(false);
    };
  }, [invalidateStream]);

  useEffect(() => {
    const prev = sessionIdRef.current;
    if (prev !== detail.session.id) {
      invalidateStream("switch");
      handoffPendingRef.current = false;
      setGenerating(false);
      setCommitting(false);
      setPendingUser(null);
      setStreamBubbles([]);
      setParkedBubbles([]);
      setNotices([]);
      setDegradedHint(false);
      setSettingsOpen(false);
      setToast(null);
      templateGateRef.current = null;
    }
    sessionIdRef.current = detail.session.id;
    // 切房重置；同房僅單調遞增，避免 session.updatedAt 覆寫掉較大的 sync watermark
    // count 必須用總則數，不可用視窗長度，否則 sync 會誤判缺口並整頁重載把對話吃掉
    const totalHint =
      typeof detail.messageTotal === "number" && detail.messageTotal > 0
        ? detail.messageTotal
        : detail.messages.length || 0;
    if (prev !== detail.session.id) {
      lastUpdatedAtRef.current = detail.session.updatedAt || 0;
      lastMessageCountRef.current = totalHint;
      olderArmedRef.current = true;
    } else {
      lastUpdatedAtRef.current = Math.max(
        lastUpdatedAtRef.current,
        detail.session.updatedAt || 0,
      );
      lastMessageCountRef.current = Math.max(lastMessageCountRef.current, totalHint);
    }
  }, [
    detail.session.id,
    detail.session.updatedAt,
    detail.messages.length,
    detail.messageTotal,
    invalidateStream,
  ]);

  // 首次載入／切房：現有訊息全部標記為已看過（不重播）；同房外部新訊息才逐步顯示
  useLayoutEffect(() => {
    const seen = seenMessageIdsRef.current;
    if (seenSessionIdRef.current !== sessionId) {
      seenSessionIdRef.current = sessionId;
      seen.clear();
      handoffPendingRef.current = false;
      for (const m of detail.messages) seen.add(m.id);
      return;
    }
    const fresh = detail.messages.filter((m) => !seen.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) seen.add(m.id);

    const liveBubbles = bubblesRef.current.length > 0;
    const freshHasAssistant = fresh.some((m) => m.role === "assistant");
    const freshUserTexts = new Set(
      fresh.filter((m) => m.role === "user").map((m) => m.content.trim()),
    );
    // 本輪串流氣泡還在時，等歷史裡的 AI 回覆到了再只留那一份，避免兩個對話窗
    if (streamingRef.current || handoffPendingRef.current || liveBubbles || parkedBubbles.length) {
      if (freshHasAssistant) {
        handoffPendingRef.current = false;
        setParkedBubbles([]);
        // 新回合已在飛：不可因「上一則」assistant 進歷史而清掉本則 pending／氣泡
        if (!generatingRef.current) {
          setPendingUser(null);
          setStreamBubbles([]);
          clearDripAndBubbles();
        } else {
          setPendingUser((p) => (p && freshUserTexts.has(p.trim()) ? null : p));
        }
      } else if (freshUserTexts.size) {
        // 僅 user 先落庫：對得上才清 pending，避免重複氣泡
        setPendingUser((p) => (p && freshUserTexts.has(p.trim()) ? null : p));
      }
      return;
    }
  }, [sessionId, detail.messages, clearDripAndBubbles, parkedBubbles.length]);

  const modelsKey = JSON.stringify(detail.session.models ?? null);

  useEffect(() => {
    const modelsCfg =
      detail.session.models && detail.session.models.length > 0
        ? detail.session.models.map((m) => ({ ...m }))
        : [
            {
              modelId: detail.session.model || "gemini-4-neon-high",
              role: "lead" as const,
              label: "主導",
            },
          ];
    setMemberDraft(modelsCfg);
    // 以 modelsKey（內容）而非陣列參照為依賴：sync／套用範本重新載入時不會洗掉尚未儲存的成員編輯
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.session.id, modelsKey, detail.session.model]);

  useEffect(() => {
    const sid = detail.session.id;
    const serverRaw = detail.session.templateId ?? null;
    const decision = applyServerTemplateId({
      sessionId: sid,
      serverRaw,
      saving: metaSaving,
      gate: templateGateRef.current,
      nowMs: Date.now(),
    });
    if (decision.action === "ignore") return;
    if (decision.clearGate) templateGateRef.current = null;
    setTemplateDraft(decision.nextLocal);
  }, [detail.session.id, detail.session.templateId, metaSaving]);

  // 離散事件貼底（送出、新訊息、notice）；串流文字chunk 僅在 rAF flush 內貼底
  useEffect(() => {
    scrollIfSticky();
  }, [detail.messages.length, pendingUser, parkedBubbles.length, notices, scrollIfSticky]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 72), 220)}px`;
  }, [draft]);

  const syncPullRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const sid = sessionId;

    async function pull(force = false) {
      if (cancelled) return;
      // 串流中預設跳過；force=true 用於結束／abort／commit 後的 reconciliation
      if (!force && document.visibilityState === "hidden") return;
      // 上一輪還沒回來就不要中止。每 3 秒中止會讓較慢的同步永遠完不成，資訊抽屜的路線圖就出不來。
      if (syncInFlightRef.current) {
        if (!force) return;
        syncAbortRef.current?.abort();
      }

      const ac = new AbortController();
      syncAbortRef.current = ac;
      syncInFlightRef.current = true;
      const since = lastUpdatedAtRef.current || 0;
      const count = lastMessageCountRef.current || 0;
      const after = newestCursorRef.current;
      try {
        const res = await fetch(
          `/api/strategy/sessions/${encodeURIComponent(sid)}/sync?since=${encodeURIComponent(String(since))}&count=${encodeURIComponent(String(count))}&limit=5${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok || cancelled || ac.signal.aborted) return;
        const data = (await res.json()) as StrategySyncResponse;
        if (!data || typeof data !== "object") return;
        if (!data.changed) {
          if (typeof data.updatedAt === "number") {
            lastUpdatedAtRef.current = Math.max(lastUpdatedAtRef.current, data.updatedAt);
          }
          if (typeof data.messageCount === "number") {
            lastMessageCountRef.current = Math.max(lastMessageCountRef.current, data.messageCount);
          }
          return;
        }
        if (sid !== sessionIdRef.current) return;
        lastUpdatedAtRef.current = Math.max(lastUpdatedAtRef.current, data.updatedAt || 0);
        if (typeof data.messageCount === "number") {
          lastMessageCountRef.current = Math.max(lastMessageCountRef.current, data.messageCount);
        } else if (Array.isArray(data.messages)) {
          lastMessageCountRef.current = Math.max(lastMessageCountRef.current, data.messages.length);
        }
        onSyncPatchRef.current(data);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      } finally {
        if (syncAbortRef.current === ac) syncInFlightRef.current = false;
      }
    }

    syncPullRef.current = pull;
    void pull(true);
    const timer = window.setInterval(() => void pull(false), 400);
    const onVis = () => {
      if (document.visibilityState === "visible") void pull(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      syncAbortRef.current?.abort();
    };
  }, [sessionId]);

  const remotePartial = useMemo(() => {
    const live =
      generating ||
      streamBubbles.some((b) => b.content.trim()) ||
      parkedBubbles.some((b) => b.content.trim());
    if (live) return null;
    for (let i = detail.messages.length - 1; i >= 0; i--) {
      const m = detail.messages[i]!;
      if (
        m.role === "assistant" &&
        m.completionStatus === "partial" &&
        m.speakerRole !== "advisor" &&
        Date.now() - (m.createdAt || 0) < 5 * 60 * 1000
      ) {
        return m;
      }
    }
    return null;
  }, [detail.messages, generating, streamBubbles, parkedBubbles]);

  const historyMessages = useMemo(() => {
    const live =
      streamBubbles.some((b) => b.content.trim()) || parkedBubbles.some((b) => b.content.trim());
    if (!live && !remotePartial) return detail.messages;
    return detail.messages.filter((m) => {
      if (remotePartial && m.id === remotePartial.id) return false;
      if (live && m.role === "assistant" && m.completionStatus === "partial") return false;
      return true;
    });
  }, [detail.messages, streamBubbles, parkedBubbles, remotePartial]);

  const remoteIndex = remotePartial ? detail.messages.findIndex((m) => m.id === remotePartial.id) : -1;
  const historyBefore = remoteIndex >= 0 ? detail.messages.slice(0, remoteIndex) : historyMessages;
  const historyAfter = remoteIndex >= 0 ? detail.messages.slice(remoteIndex + 1) : [];

  useEffect(() => {
    const driver = remoteDripRef.current;
    if (!remotePartial) {
      driver.stopAndClear();
      setRemoteBubble(null);
      return;
    }
    const current = driver.snapshot()[0];
    if (current && current.key !== remotePartial.id) driver.stopAndClear();
    const first = !remoteSeededRef.current.has(remotePartial.id);
    if (first) remoteSeededRef.current.add(remotePartial.id);
    driver.upsert({
      key: remotePartial.id,
      role: remotePartial.speakerRole || "lead",
      modelId: remotePartial.speakerModel || "",
      label: remotePartial.speakerLabel || "主導",
      received: remotePartial.content,
      done: false,
      ...(first && remotePartial.content.length > 24 ? { displayed: remotePartial.content } : {}),
    });
    driver.schedule((snap) => {
      const b = snap.find((x) => x.key === remotePartial.id) ?? snap[0];
      if (!b) return;
      setRemoteBubble({
        key: b.key,
        role: b.role,
        modelId: b.modelId,
        label: b.label,
        content: b.displayed,
        done: false,
      });
      const el = roomScrollRef.current;
      if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [remotePartial]);

  function onScroll() {
    const el = roomScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const overflows = el.scrollHeight > el.clientHeight + 8;
    // 內容還不夠長時仍算貼底，回覆變長才會跟著往下。只有真的往上捲才停止跟隨。
    stickToBottomRef.current = !overflows || dist < 80;
    if (el.scrollTop > 120) olderArmedRef.current = true;
    // 短內容 scrollTop 會是 0，不能因此把更早訊息一次補進來
    if (overflows && el.scrollTop < 72 && olderArmedRef.current && !stickToBottomRef.current) {
      olderArmedRef.current = false;
      void loadOlderMessages();
    }
  }

  useLayoutEffect(() => {
    const adj = olderScrollAdjustRef.current;
    const el = roomScrollRef.current;
    if (!adj || !el) return;
    olderScrollAdjustRef.current = null;
    el.scrollTop = adj.prevTop + (el.scrollHeight - adj.prevHeight);
  }, [detail.messages]);

  /** #9：輕量 reconciliation——force sync＋背景刷側欄；不重開整房 */
  async function reconcileOnce(runId: number, sid: string) {
    if (reconcileRunRef.current === runId) return;
    reconcileRunRef.current = runId;
    await syncPullRef.current(true);
    void onStreamCommittedRef.current(sid);
  }

  /** done／中斷後立刻可打字、可再送；背景 sync 不擋 composer */
  function beginBackgroundReconcile(runId: number, sid: string, refreshWallet = false) {
    streamCommittingRef.current = false;
    setCommitting(false);
    void reconcileOnce(runId, sid)
      .catch(() => {})
      .finally(() => {
        if (refreshWallet && sid === sessionIdRef.current) void onRefreshWallet();
        // sync 若未帶進新訊息：旗標與氣泡一起留著，等歷史到再清；不要只清旗標，否則會變成兩個對話窗
        // 第一次 sync 若 races 在落庫前，短間隔再拉，避免要重新整理才看得到
        for (const wait of [1000, 3000]) {
          window.setTimeout(() => {
            if (sid !== sessionIdRef.current || !handoffPendingRef.current) return;
            void syncPullRef.current(true);
          }, wait);
        }
      });
  }

  async function loadOlderMessages() {
    if (
      !onOlderMessages ||
      loadingOlderRef.current ||
      streamingRef.current ||
      !detail.hasMore ||
      !detail.nextCursor
    ) {
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = roomScrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const sid = sessionId;
      const res = await fetch(
        `/api/strategy/sessions/${encodeURIComponent(sid)}?limit=${STRATEGY_OLDER_PAGE}&lite=1&part=thread&before=${encodeURIComponent(detail.nextCursor)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        olderArmedRef.current = true;
        return;
      }
      const data = (await res.json()) as {
        messages?: StrategySessionMessage[];
        hasMore?: boolean;
        nextCursor?: string | null;
        messageTotal?: number;
      };
      if (!Array.isArray(data.messages) || !data.messages.length) {
        olderArmedRef.current = true;
        return;
      }
      olderScrollAdjustRef.current = { prevHeight, prevTop };
      onOlderMessages({
        messages: data.messages,
        hasMore: Boolean(data.hasMore),
        nextCursor: data.nextCursor ?? null,
        messageTotal: typeof data.messageTotal === "number" ? data.messageTotal : detail.messageTotal ?? 0,
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  function stopGeneration() {
    // 跟聊天介面一樣：以 AbortController／reader 為準，不依賴可能過期的 generating state
    const hasLive =
      generatingRef.current ||
      Boolean(streamAbortRef.current) ||
      Boolean(streamReaderRef.current);
    if (!hasLive) return;
    if (streamCommittingRef.current) return;
    const content = streamContentRef.current;
    const sid = sessionIdRef.current;
    const runId = streamRunIdRef.current;
    // 立即失效本輪：清拆吐佇列，殘留非同步因 runId 不符靜默結束
    invalidateStream("user");
    handoffPendingRef.current = false;
    setStreamBubbles([]);
    setParkedBubbles([]);
    setPendingUser(null);
    setNotices([]);
    setDegradedHint(false);
    setGenerating(false);
    setCommitting(false);
    onError(null);
    if (content) onDraftChange(content);
    requestAnimationFrame(() => textareaRef.current?.focus());
    // #9：停止後立刻可打字／可重送；背景 sync 不擋 composer
    beginBackgroundReconcile(runId, sid, true);
  }

  async function sendStream(text: string) {
    const sid = sessionId;
    const content = text.trim();
    if (!content || generating || committing || detail.session.status === "closed") return;

    // 上一輪可見回覆尚未進歷史：先 sync；若仍未進，暫留氣泡再開新串流，避免吃掉主持人回覆
    if (handoffPendingRef.current) {
      try {
        await syncPullRef.current(true);
      } catch {
        /* ignore */
      }
      if (sid !== sessionIdRef.current) return;
      if (handoffPendingRef.current && bubblesRef.current.some((b) => b.content.trim())) {
        setParkedBubbles(bubblesRef.current.map((b) => ({ ...b, done: true })));
      }
      handoffPendingRef.current = false;
    }

    const runId = ++streamRunIdRef.current;
    const isCurrent = () => runId === streamRunIdRef.current && sid === sessionIdRef.current;

    streamContentRef.current = content;
    streamCommittingRef.current = false;
    reconcileRunRef.current = null;
    abortReasonRef.current = null;
    clearDripAndBubbles();
    stickToBottomRef.current = true;

    onError(null);
    setDegradedHint(false);
    setNotices([]);
    setPendingUser(content);
    setStreamBubbles([]);
    onDraftChange("");
    setCommitting(false);
    setGenerating(true);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    let lineBuffer = "";
    let sawDone = false;
    let completion: (StrategyStreamEvent & { type: "done" }) | null = null;

    try {
      let res: Response | null = null;
      for (let attempt = 0; attempt < 7; attempt++) {
        res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sid)}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, stream: true }),
          signal: controller.signal,
        });
        if (!isCurrent()) {
          void res.body?.cancel().catch(() => {});
          return;
        }
        if (res.status !== 409) break;
        const data = (await res.json().catch(() => ({}))) as { error?: string; busy?: boolean };
        if (!data.busy || attempt === 6 || !isCurrent()) {
          onError(data.error || "送出失敗");
          onDraftChange(content);
          setPendingUser(null);
          setStreamBubbles([]);
          setGenerating(false);
          return;
        }
        // 上一則正文已顯示，伺服器還在收尾。短暫停一下再送，不要先跳出那句鎖
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, 3000);
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!res) return;
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!isCurrent()) return;
        onError(data.error || "送出失敗");
        onDraftChange(content);
        setPendingUser(null);
        setStreamBubbles([]);
        setGenerating(false);
        return;
      }
      if (!res.body) throw new Error("無串流回應");

      const reader = res.body.getReader();
      streamReaderRef.current = reader;
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent()) {
          void reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line.trim()) continue;
          let ev: StrategyStreamEvent;
          try {
            ev = JSON.parse(line) as StrategyStreamEvent;
          } catch {
            continue;
          }
          if (!isCurrent()) {
            void reader.cancel().catch(() => {});
            return;
          }
          handleStreamEvent(ev, isCurrent);
          if (ev.type === "done") {
            sawDone = true;
            completion = ev;
          }
        }
      }

      if (!isCurrent()) return;

      if (completion?.aborted || completion?.completionStatus === "failed") {
        // 先留著已吐出的字，等 sync 把庫裡的回覆接上再收掉氣泡
        setPendingUser(null);
        onError("生成失敗或已中斷");
        setGenerating(false);
        beginBackgroundReconcile(runId, sid);
        return;
      }

      if (sawDone && (completion?.completionStatus === "ok" || completion?.completionStatus === "degraded")) {
        if (completion.completionStatus === "degraded") setDegradedHint(true);
        // input_ready 多半已解鎖；舊後端無此事件時在此補解鎖
        unlockComposerAfterVisible();
        beginBackgroundReconcile(runId, sid, true);
        return;
      }

      // 連線斷了也留著已吐出的字，背景 sync 接到庫裡的回覆再收氣泡
      setPendingUser(null);
      onError("連線中斷，回覆未完成");
      setGenerating(false);
      beginBackgroundReconcile(runId, sid);
    } catch (e) {
      if (!isCurrent()) return;
      setPendingUser(null);
      if ((e as Error)?.name === "AbortError") {
        // 使用者停止：stopGeneration 已 reconcileOnce，這裡略過
        if (abortReasonRef.current === "user") return;
        onError("連線中斷，回覆未完成");
      } else {
        onError(e instanceof Error ? e.message : String(e));
      }
      onDraftChange(content);
      setGenerating(false);
      beginBackgroundReconcile(runId, sid);
    } finally {
      if (runId === streamRunIdRef.current) {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        streamReaderRef.current = null;
        streamCommittingRef.current = false;
        abortReasonRef.current = null;
        if (sid === sessionIdRef.current) {
          setGenerating(false);
        }
      }
    }
  }

  function handleStreamEvent(ev: StrategyStreamEvent, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    // thinking：靜默忽略
    if (ev.type === "thinking") return;
    if (ev.type === "notice" && ev.message) {
      setNotices((prev) => [...prev, ev.message]);
      return;
    }
    if (ev.type === "error" && ev.message && !ev.aborted) {
      onError(ev.message);
      return;
    }
    if (ev.type === "member_start") {
      const key = `${ev.role || "m"}-${ev.modelId || "x"}-${Date.now()}-${bubblesRef.current.length}`;
      bubblesRef.current.push({
        key,
        role: String(ev.role || "custom"),
        modelId: String(ev.modelId || ""),
        label: String(ev.label || ev.role || "AI"),
        content: "",
        done: false,
      });
      syncDripFromReceived();
      return;
    }
    if (ev.type === "text" && ev.text) {
      const buf = bubblesRef.current;
      if (!buf.length) {
        buf.push({
          key: `lead-${Date.now()}`,
          role: String(ev.role || "lead"),
          modelId: String(ev.modelId || ""),
          label: "主導",
          content: ev.text,
          done: false,
        });
      } else {
        buf[buf.length - 1]!.content += ev.text;
      }
      syncDripFromReceived();
      return;
    }
    if (ev.type === "member_done") {
      const buf = bubblesRef.current;
      if (buf.length) buf[buf.length - 1]!.done = true;
      syncDripFromReceived();
      return;
    }
    if (ev.type === "input_ready") {
      // 伺服器：可見文字已完，落庫仍在跑 → 立刻可打字
      unlockComposerAfterVisibleRef.current();
      return;
    }
    if (ev.type === "done") {
      // 收尾：顯示立刻對齊已接收全文（不卡住 committing）
      flushDripNow();
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || generating || committing || detail.session.status === "closed") return;
    void sendStream(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function toggleSelect(id: string, checked: boolean) {
    const next = new Set(dispatchSelected);
    if (checked) next.add(id);
    else next.delete(id);
    onDispatchSelectedChange(next);
  }

  function applyChip(prompt: string) {
    const cur = draft.trim();
    onDraftChange(cur ? `${cur}\n${prompt}` : prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function ensureOneLead(list: StrategyMemberConfig[]): StrategyMemberConfig[] {
    const copy = list.map((m) => ({ ...m }));
    const leads = copy.filter((m) => m.role === "lead");
    if (leads.length === 1) return copy;
    if (copy.length === 0) {
      return [{ modelId: "gemini-4-neon-low", role: "lead", label: "主導" }];
    }
    copy.forEach((m, i) => {
      m.role = i === 0 ? "lead" : m.role === "lead" ? "custom" : m.role;
      if (i === 0) m.label = m.label || "主導";
    });
    return copy;
  }

  function setAsLead(index: number) {
    setMemberDraft((prev) =>
      ensureOneLead(
        prev.map((m, i) => ({
          ...m,
          role: i === index ? "lead" : m.role === "lead" ? "custom" : m.role,
          label: i === index ? m.label || "主導" : m.label,
        })),
      ),
    );
  }

  function addMember() {
    setMemberDraft((prev) => {
      if (prev.length >= 4) return prev;
      const usedFamilies = new Set(
        prev.map((p) => {
          const opt = models.find((m) => m.id === p.modelId);
          return opt ? familyIdOf(opt) : stripEffortSuffix(p.modelId);
        }),
      );
      const fam =
        allFamilies.find((f) => f.available && !usedFamilies.has(f.familyId)) ||
        allFamilies.find((f) => f.available) ||
        null;
      // 新增成員預設 Low（無 Low 則退到唯一／最低可用強度）
      const modelId = fam
        ? resolveFamilyModelId(fam, "low")
        : models.find((m) => m.available)?.id || "gemini-4-neon-low";
      const label =
        fam?.familyLabel.replace(/（.*?）\s*$/, "").trim() ||
        models.find((m) => m.id === modelId)?.label?.split("·")[0]?.trim() ||
        "顧問";
      return ensureOneLead([...prev, { modelId, role: "custom", label }]);
    });
  }

  function removeMember(index: number) {
    setMemberDraft((prev) => {
      if (prev.length <= 1) return prev;
      return ensureOneLead(prev.filter((_, i) => i !== index));
    });
  }

  function applyPreset(list: StrategyMemberConfig[]) {
    setMemberDraft(ensureOneLead(list.map((m) => ({ ...m }))));
  }

  async function saveMeta() {
    const modelsOk = ensureOneLead(memberDraft);
    if (modelsOk.length < 1 || modelsOk.length > 4) {
      onError("成員須為 1–4 位");
      return;
    }
    if (modelsOk.filter((m) => m.role === "lead").length !== 1) {
      onError("必須剛好 1 位主導");
      return;
    }
    setMetaSaving(true);
    onError(null);
    try {
      const ok = await onPatchSessionMeta({
        models: modelsOk,
        templateId: activeTemplateId,
      });
      if (!ok) onError("儲存成員／範本失敗");
      else setSettingsOpen(false);
    } finally {
      setMetaSaving(false);
    }
  }

  function showToast(text: string) {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastSeqRef.current += 1;
    setToast({ key: toastSeqRef.current, text });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2600);
  }

  /** SOP 範本：選擇即儲存；null 顯示預設仍可 PATCH；防晚到舊 sync；失敗僅 rollback 同世代 */
  async function changeTemplate(nextId: string) {
    const sid = sessionId;
    const prevDraft = templateDraft;
    const serverBefore = serverTemplateRaw;
    if (
      !shouldPatchTemplateSelection(nextId, serverBefore, templateDraft) &&
      nextId === activeTemplateId
    ) {
      return;
    }
    const gate = beginTemplateSave({
      sessionId: sid,
      nextId,
      serverBefore,
      prevGen: templateGateRef.current?.gen ?? 0,
    });
    templateGateRef.current = gate;
    setTemplateDraft(nextId);
    setMetaSaving(true);
    onError(null);
    let ok = false;
    try {
      ok = await onPatchSessionMeta({ templateId: nextId });
    } catch {
      ok = false;
    } finally {
      if (sid === sessionIdRef.current) setMetaSaving(false);
    }
    if (sid !== sessionIdRef.current) {
      templateGateRef.current = null;
      return;
    }
    if (ok) {
      templateGateRef.current = markTemplateSaveOk(gate, Date.now());
      showToast("已套用範本");
    } else if (
      shouldRollbackTemplate({
        gate: templateGateRef.current,
        sessionId: sid,
        expectedGen: gate.gen,
        currentLocal: nextId,
      })
    ) {
      templateGateRef.current = null;
      setTemplateDraft(prevDraft);
      onError("套用範本失敗");
    }
  }

  const allFamilies = buildModelFamilies(models);

  const familiesForSelect = (selectedId: string) => {
    const selected = models.find((m) => m.id === selectedId);
    const selectedFamilyId = selected ? familyIdOf(selected) : stripEffortSuffix(selectedId);
    const list = allFamilies.filter((f) => f.available || f.familyId === selectedFamilyId);
    if (selected && !list.some((f) => f.familyId === selectedFamilyId)) {
      // 目前選到的模型若不在清單（例如僅剩 xhigh），補一列以免 select 空白
      list.unshift({
        familyId: selectedFamilyId,
        familyLabel:
          selected.familyLabel?.trim() ||
          selected.label.replace(/\s*·\s*(Low|Medium|High|Extra High)\s*/gi, "").trim() ||
          selectedFamilyId,
        categoryLabel: selected.categoryLabel?.trim() || "其他",
        available: selected.available,
        note: selected.note,
        efforts: [],
        byEffort: {},
        singleton: selected,
      });
    }
    return list;
  };

  /** 依 categoryLabel 分組（保留首次出現順序） */
  const groupedFamilyOptions = (selectedId: string) => {
    const groups: { label: string; items: ModelFamilyOption[] }[] = [];
    for (const fam of familiesForSelect(selectedId)) {
      const label = fam.categoryLabel || "其他";
      let g = groups.find((x) => x.label === label);
      if (!g) {
        g = { label, items: [] };
        groups.push(g);
      }
      g.items.push(fam);
    }
    return groups;
  };

  function patchMemberModel(index: number, nextModelId: string) {
    const opt = models.find((x) => x.id === nextModelId);
    setMemberDraft((prev) =>
      prev.map((row, j) =>
        j === index
          ? {
              ...row,
              modelId: nextModelId,
              label:
                row.role === "lead"
                  ? row.label
                  : opt?.familyLabel?.replace(/（.*?）\s*$/, "").trim() ||
                    opt?.label?.split("·")[0]?.trim() ||
                    row.label,
            }
          : row,
      ),
    );
  }

  return (
    <section className="strategy-room-view" aria-label="策略會議室">
      {toast ? (
        <div key={toast.key} className="strategy-toast" role="status">
          {toast.text}
        </div>
      ) : null}
      <header className="strategy-room-topbar">
        <div className="strategy-room-topbar-left">
          <button type="button" className="strategy-room-menu-btn" aria-label="開啟側欄" onClick={onOpenSidebar}>
            選單
          </button>
          <button type="button" className="ghost" onClick={onBackToChat}>
            返回聊天
          </button>
          <div className="strategy-room-title-block" style={{ minWidth: 0 }}>
            <strong className="strategy-room-title">{detail.session.name || "策略會議室"}</strong>
            {detail.session.topic ? (
              <span className="muted strategy-room-topic">主題：{detail.session.topic}</span>
            ) : null}
          </div>
        </div>
        <div className="strategy-room-topbar-right">
          <span className="strategy-status-chip">{strategyStatusLabel(detail.session.status)}</span>
          {pauseState !== "none" ? (
            <span className={`strategy-pause-chip is-${pauseState}`}>{PAUSE_STATE_LABEL[pauseState]}</span>
          ) : null}
          <span className="strategy-exec-chip" title="依平台派送狀態統計">
            執行中 {dispatchedCount}
          </span>
          <button
            type="button"
            className={`ghost${settingsOpen ? " is-active" : ""}`}
            disabled={streaming}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            成員與範本
          </button>
          {pauseState === "none" ? (
            <button type="button" className="ghost" disabled={busy || streaming} onClick={() => onPauseAction("graceful_pause")}>
              優雅暫停
            </button>
          ) : null}
          {pauseState === "pausing" ? (
            <button type="button" className="ghost" disabled={busy || streaming} onClick={() => onPauseAction("force_pause")}>
              強制立即暫停
            </button>
          ) : null}
          {pauseState === "pausing" || pauseState === "paused" ? (
            <button type="button" className="ghost" disabled={busy || streaming} onClick={() => onPauseAction("resume")}>
              恢復執行
            </button>
          ) : null}
          {canSplit ? (
            <button
              type="button"
              className={`ghost${viewMode === "split" ? " is-active" : ""}`}
              onClick={onToggleSplit}
            >
              {viewMode === "split" ? "取消並排" : "並排檢視"}
            </button>
          ) : null}
          <button
            type="button"
            className={`ghost${drawerOpen ? " is-active" : ""}`}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            資訊
            {(() => {
              const items = detail.ledger?.items ?? [];
              const done = items.filter((i) => i.status === "done").length;
              if (items.length) return ` ${done}/${items.length}`;
              return pending.length ? `（${pending.length}）` : "";
            })()}
          </button>
          <button type="button" className="ghost" disabled={busy || streaming} onClick={onRefresh}>
            重新整理
          </button>
        </div>
      </header>

      {settingsOpen ? (
        <div className="strategy-settings-panel" aria-label="成員與範本設定">
          <div className="strategy-settings-row">
            <label>
              SOP 範本
              <select
                value={activeTemplateId}
                disabled={metaSaving || streaming}
                onChange={(e) => void changeTemplate(e.target.value)}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted" style={{ fontSize: 12 }}>
              {activeTemplate?.description}
            </span>
          </div>
          <div className="strategy-settings-actions">
            <button
              type="button"
              className="ghost"
              disabled={metaSaving || streaming}
              onClick={() => applyPreset(activeTemplate?.recommendedModels ?? default3AiPreset)}
            >
              套用範本推薦
            </button>
            <button
              type="button"
              className="ghost"
              disabled={metaSaving || streaming}
              onClick={() => applyPreset(default3AiPreset)}
            >
              一鍵 3 AI
            </button>
            <button type="button" className="ghost" disabled={metaSaving || streaming || memberDraft.length >= 4} onClick={addMember}>
              新增成員
            </button>
          </div>
          <ul className="strategy-member-edit-list">
            {memberDraft.map((m, i) => {
              const cur = models.find((x) => x.id === m.modelId);
              const familyId = cur ? familyIdOf(cur) : stripEffortSuffix(m.modelId);
              const fam =
                allFamilies.find((f) => f.familyId === familyId) ||
                familiesForSelect(m.modelId).find((f) => f.familyId === familyId);
              const uiEffort = uiEffortOf(cur, m.modelId);
              const canMedium = Boolean(fam?.byEffort.medium);
              const canHigh = Boolean(fam?.byEffort.high);
              const showEffortToggles = Boolean(fam && fam.efforts.length >= 2);
              return (
              <li key={`${m.modelId}-${i}`}>
                <select
                  value={familyId}
                  title={fam ? familyOptionTitle(fam) : cur ? modelOptionTitle(cur) : m.modelId}
                  disabled={metaSaving || streaming}
                  onChange={(e) => {
                    const nextFam = allFamilies.find((f) => f.familyId === e.target.value);
                    if (!nextFam) return;
                    // 換家族：預設 Low（無則退最低可用）
                    patchMemberModel(i, resolveFamilyModelId(nextFam, "low"));
                  }}
                >
                  {!fam ? <option value={familyId}>{familyId}</option> : null}
                  {groupedFamilyOptions(m.modelId).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((f) => (
                        <option key={f.familyId} value={f.familyId} title={familyOptionTitle(f)}>
                          {familyOptionText(f)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <div className="strategy-effort-toggles" title="預設 Low；Medium／High 互斥">
                  {showEffortToggles ? (
                    <>
                      <label className={!canMedium ? "is-disabled" : undefined}>
                        <input
                          type="checkbox"
                          checked={uiEffort === "medium"}
                          disabled={metaSaving || streaming || !canMedium || !fam}
                          onChange={(e) => {
                            if (!fam) return;
                            patchMemberModel(
                              i,
                              resolveFamilyModelId(fam, e.target.checked ? "medium" : "low"),
                            );
                          }}
                        />
                        <span>Medium</span>
                      </label>
                      <label className={!canHigh ? "is-disabled" : undefined}>
                        <input
                          type="checkbox"
                          checked={uiEffort === "high"}
                          disabled={metaSaving || streaming || !canHigh || !fam}
                          onChange={(e) => {
                            if (!fam) return;
                            patchMemberModel(
                              i,
                              resolveFamilyModelId(fam, e.target.checked ? "high" : "low"),
                            );
                          }}
                        />
                        <span>High</span>
                      </label>
                    </>
                  ) : (
                    <span className="muted strategy-effort-fixed">
                      {uiEffort ? uiEffort : "—"}
                    </span>
                  )}
                </div>
                <input
                  value={m.label}
                  maxLength={80}
                  disabled={metaSaving || streaming}
                  placeholder="稱呼"
                  onChange={(e) =>
                    setMemberDraft((prev) => prev.map((row, j) => (j === i ? { ...row, label: e.target.value } : row)))
                  }
                />
                <span className={`strategy-role-badge is-${m.role}`}>
                  {MEMBER_ROLE_LABEL[m.role as StrategyMemberRole] ?? m.role}
                </span>
                <button type="button" className="ghost" disabled={metaSaving || streaming || m.role === "lead"} onClick={() => setAsLead(i)}>
                  設為主導
                </button>
                <button type="button" className="ghost" disabled={metaSaving || streaming || memberDraft.length <= 1} onClick={() => removeMember(i)}>
                  移除
                </button>
              </li>
              );
            })}
          </ul>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ghost" disabled={metaSaving} onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button type="button" disabled={metaSaving || streaming} onClick={() => void saveMeta()}>
              {metaSaving ? "儲存中…" : "儲存"}
            </button>
          </div>
        </div>
      ) : null}

      <div className={`strategy-room-body${drawerOpen ? " drawer-open" : ""}`}>
        <div className="strategy-room-main">
          <div className="strategy-room-msg-list" ref={roomScrollRef} onScroll={onScroll}>
            {/* spacer：短對話貼底；min-height:0 可收縮，桌面可上捲到第一則 */}
            <div className="strategy-room-msg-spacer" aria-hidden />
            {detail.hasMore && detail.nextCursor ? (
              <div className="row" style={{ justifyContent: "center", padding: "8px 0" }}>
                <button
                  type="button"
                  className="ghost strategy-room-load-older"
                  disabled={loadingOlder || streaming}
                  onClick={() => void loadOlderMessages()}
                  title="訊息太短無法上滑時，請直接點此載入"
                >
                  {loadingOlder ? "載入更早的訊息…" : "載入更早的訊息"}
                </button>
              </div>
            ) : null}
            {detail.messages.length === 0 &&
            !pendingUser &&
            streamBubbles.length === 0 &&
            parkedBubbles.length === 0 ? (
              <div className="muted strategy-room-loading-copy">
                {busy ? "載入中…" : "尚無訊息"}
              </div>
            ) : (
              <>
                <HistoryMessages messages={historyBefore} />
                {remoteBubble ? (
                  <div className="strategy-msg strategy-msg-assistant is-streaming">
                    <div className="strategy-msg-role">
                      <span className={`strategy-role-badge is-${remoteBubble.role}`}>{remoteBubble.label}</span>
                      {remoteBubble.modelId ? <span className="muted"> · {remoteBubble.modelId}</span> : null}
                    </div>
                    <div className="strategy-msg-body strategy-md-body">
                      <SafeLightMarkdown content={remoteBubble.content || ""} streaming />
                      <span className="stream-caret" aria-hidden />
                    </div>
                  </div>
                ) : null}
                {historyAfter.length ? <HistoryMessages messages={historyAfter} /> : null}
              </>
            )}

            {parkedBubbles.map((b) => (
              <div key={`parked-${b.key}`} className="strategy-msg strategy-msg-assistant is-streaming is-done">
                <div className="strategy-msg-role">
                  <span className={`strategy-role-badge is-${b.role}`}>{b.label}</span>
                  {b.modelId ? <span className="muted"> · {b.modelId}</span> : null}
                </div>
                <div className="strategy-msg-body strategy-md-body">
                  <SafeLightMarkdown content={b.content || ""} streaming={false} />
                </div>
              </div>
            ))}

            {pendingUser ? (
              <div className="strategy-msg strategy-msg-user is-pending">
                <div className="strategy-msg-role">
                  {generating ? "你（網頁）· 送出中" : "你（網頁）"}
                </div>
                <pre className="strategy-msg-body">{pendingUser}</pre>
              </div>
            ) : null}

            {streamBubbles.map((b) => (
              <div key={b.key} className={`strategy-msg strategy-msg-assistant is-streaming${b.done ? " is-done" : ""}`}>
                <div className="strategy-msg-role">
                  <span className={`strategy-role-badge is-${b.role}`}>{b.label}</span>
                  {b.modelId ? <span className="muted"> · {b.modelId}</span> : null}
                </div>
                <div className="strategy-msg-body strategy-md-body">
                  <SafeLightMarkdown content={b.content || ""} streaming={!b.done} />
                  {!b.done ? <span className="stream-caret" aria-hidden /> : null}
                </div>
              </div>
            ))}

            {notices.map((n, i) => (
              <div key={`n-${i}`} className="strategy-stream-notice">
                {n}
              </div>
            ))}
            {degradedHint ? (
              <div className="strategy-stream-notice is-degraded">本回合因時限降級為純文字收尾（可能未更新記憶／派送）</div>
            ) : null}
          </div>

          {error ? (
            <div className="strategy-room-error" role="alert">
              {error}
            </div>
          ) : null}

          {activeTemplate?.quickPrompts?.length ? (
            <div className="strategy-quick-chips" aria-label="快捷引導">
              {activeTemplate.quickPrompts.map((p) => (
                <button key={p} type="button" className="strategy-chip" disabled={streaming} onClick={() => applyChip(p)}>
                  {p}
                </button>
              ))}
            </div>
          ) : null}

          <form className="strategy-room-composer" onSubmit={submit}>
            <textarea
              ref={textareaRef}
              value={draft}
              maxLength={8000}
              rows={3}
              disabled={generating || detail.session.status === "closed"}
              placeholder={
                detail.session.status === "closed"
                  ? "會議室已關閉"
                  : "在會議室發言（Enter 送出，Shift+Enter 換行）"
              }
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                每次發言會依 token 扣點
              </span>
              {generating ? (
                <button
                  type="button"
                  className="strategy-stop-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopGeneration();
                  }}
                >
                  停止
                </button>
              ) : (
                <button type="submit" disabled={!draft.trim() || detail.session.status === "closed"}>
                  送出
                </button>
              )}
            </div>
          </form>
        </div>

        {drawerOpen ? (
          <aside className="strategy-room-drawer" aria-label="會議室資訊抽屜">
            <div className="modal-section">
              <h3>會議室摘要</h3>
              {detail.session.summary ? (
                <p className="strategy-summary">{detail.session.summary}</p>
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>
                  尚無摘要
                </div>
              )}
            </div>

            <LedgerRoadmapPanel ledger={detail.ledger ?? null} />

            <div className="modal-section">
              <label className="strategy-auto-toggle">
                <input
                  type="checkbox"
                  checked={detail.session.autoDispatch !== false}
                  onChange={(e) => onToggleAutoDispatch(e.target.checked)}
                />
                <span>自動派送給 Cursor</span>
              </label>
            </div>

            <DispatchDrawer
              pending={pending}
              recent={detail.dispatch.filter((d) => d.status !== "pending").slice(0, 12)}
              selected={dispatchSelected}
              paused={paused}
              onToggle={toggleSelect}
              onSelectAll={() =>
                onDispatchSelectedChange(
                  dispatchSelected.size === pending.length ? new Set() : new Set(pending.map((d) => d.id)),
                )
              }
              onDecide={onDecideDispatch}
              onMarkDone={onMarkDispatchDone}
            />

            <div className="modal-section">
              <h3>主體共用記憶</h3>
              <textarea
                className="strategy-ws-memory"
                value={wsMemoryDraft}
                maxLength={4000}
                rows={3}
                placeholder="例如：只做 paper／testnet"
                onChange={(e) => onWsMemoryChange(e.target.value)}
              />
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
                <button type="button" className="ghost" disabled={wsMemorySaving} onClick={onSaveMemory}>
                  {wsMemorySaving ? "儲存中…" : "儲存共用記憶"}
                </button>
              </div>
            </div>

            {(detail.dossier.findings.length > 0 ||
              detail.dossier.decisions.length > 0 ||
              detail.dossier.fPlan) && (
              <div className="modal-section">
                <h3>dossier 摘要</h3>
                {detail.dossier.fPlan ? (
                  <p className="strategy-dossier-line">
                    定案方案：{String((detail.dossier.fPlan as { name?: unknown }).name ?? "已定案")}
                  </p>
                ) : null}
                {detail.dossier.decisions.slice(-3).map((d, i) => (
                  <p key={`d-${i}`} className="strategy-dossier-line">
                    決策：{d}
                  </p>
                ))}
                {detail.dossier.findings.slice(-3).map((f, i) => (
                  <p key={`f-${i}`} className="strategy-dossier-line">
                    發現：{f}
                  </p>
                ))}
              </div>
            )}

            {detail.reports.length > 0 ? (
              <div className="modal-section">
                <h3>報告索引</h3>
                <ul className="strategy-report-list">
                  {detail.reports.slice(0, 12).map((r) => (
                    <li key={r.id}>
                      <span className="title">{r.title}</span>
                      <span className="muted">{r.chars.toLocaleString("zh-TW")} 字</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function LedgerRoadmapPanel({ ledger }: { ledger: StrategyLedger | null }) {
  if (!ledger) {
    return (
      <div className="modal-section">
        <h3>路線圖進度</h3>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          載入中…
        </p>
      </div>
    );
  }
  if (!ledger.items?.length && !ledger.brief && !ledger.currentPackage) {
    return (
      <div className="modal-section">
        <h3>路線圖進度</h3>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          尚無路線圖。討論定案後由主持人排項目；完成時由主持人打勾，此處僅供查看。
        </p>
      </div>
    );
  }
  const items = ledger.items ?? [];
  const done = items.filter((i) => i.status === "done").length;
  const children = new Map<string, StrategyLedgerItem[]>();
  const roots: StrategyLedgerItem[] = [];
  const ids = new Set(items.map((i) => i.id));
  for (const it of items) {
    if (it.parentId && ids.has(it.parentId)) {
      const arr = children.get(it.parentId) ?? [];
      arr.push(it);
      children.set(it.parentId, arr);
    } else {
      roots.push(it);
    }
  }
  const pkg = ledger.currentPackage;
  const rows: { item: StrategyLedgerItem; depth: number }[] = [];
  const walk = (it: StrategyLedgerItem, depth: number) => {
    rows.push({ item: it, depth });
    for (const c of children.get(it.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  return (
    <div className="modal-section">
      <h3>
        路線圖進度
        {items.length ? `（${done}/${items.length}）` : ""}
      </h3>
      <p className="muted strategy-ledger-hint">進度由主持人更新，此處不可點選。</p>
      {ledger.brief?.topic ? (
        <p className="strategy-ledger-topic">主題：{ledger.brief.topic}</p>
      ) : null}
      {pkg ? (
        <p className="strategy-ledger-pkg">
          目前工作包：{pkg.goal}
          {pkg.status === "escalated" ? "（僵局）" : ""}
          {pkg.rejectCount > 0 ? `｜退回 ${pkg.rejectCount}` : ""}
        </p>
      ) : null}
      {rows.length ? (
        <ul className="strategy-ledger-list" aria-label="路線圖項目">
          {rows.map(({ item, depth }) => {
            const current = ledger.currentItemId === item.id;
            const checked = item.status === "done";
            return (
              <li
                key={item.id}
                className={`strategy-ledger-item status-${item.status}${current ? " is-current" : ""}`}
                style={{ paddingLeft: depth * 14 }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled
                  readOnly
                  tabIndex={-1}
                  aria-label={`${item.title}（${LEDGER_STATUS_LABEL[item.status]}）`}
                />
                <div className="strategy-ledger-body">
                  <div className="strategy-ledger-title">
                    <span className="id">{item.id}</span>
                    <span>{item.title}</span>
                    {current ? <span className="strategy-ledger-now">目前</span> : null}
                  </div>
                  <div className="strategy-ledger-meta muted">
                    {LEDGER_STATUS_LABEL[item.status]}
                    {item.conclusion ? `｜${item.conclusion}` : item.note ? `｜${item.note}` : ""}
                    {item.parkedReason ? `｜暫停：${item.parkedReason}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function DispatchDrawer(props: {
  pending: StrategyDispatchItem[];
  recent: StrategyDispatchItem[];
  selected: Set<string>;
  paused: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectAll: () => void;
  onDecide: (action: "dispatch" | "reject") => void;
  onMarkDone: (id: string) => void;
}) {
  const { pending, recent, selected, paused, onToggle, onSelectAll, onDecide, onMarkDone } = props;
  if (!pending.length && !recent.length) return null;
  return (
    <div className="modal-section">
      <h3>待派送給 Cursor{pending.length ? `（${pending.length}）` : ""}</h3>
      {paused ? (
        <p className="muted" style={{ fontSize: 12 }}>
          會議室暫停中，無法新派送；仍可駁回或標記完成。
        </p>
      ) : null}
      {pending.length > 0 ? (
        <>
          <ul className="strategy-dispatch-list">
            {pending.map((d) => (
              <li key={d.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={(e) => onToggle(d.id, e.target.checked)}
                  />
                  <span>{dispatchText(d.instruction)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="ghost" onClick={onSelectAll}>
              {selected.size === pending.length ? "取消全選" : "全選"}
            </button>
            <button type="button" disabled={!selected.size || paused} onClick={() => onDecide("dispatch")}>
              派給 Cursor
            </button>
            <button type="button" className="ghost" disabled={!selected.size} onClick={() => onDecide("reject")}>
              駁回
            </button>
          </div>
        </>
      ) : null}
      {recent.length > 0 ? (
        <ul className="strategy-dispatch-list strategy-dispatch-history">
          {recent.map((d) => (
            <li key={d.id}>
              <span className={`strategy-dispatch-chip is-${d.status}`}>{DISPATCH_STATUS_LABEL[d.status]}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{dispatchText(d.instruction)}</span>
              {d.status === "dispatched" ? (
                <button type="button" className="ghost" onClick={() => onMarkDone(d.id)}>
                  標記完成
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
