"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  DISPATCH_STATUS_LABEL,
  MEMBER_ROLE_LABEL,
  PAUSE_STATE_LABEL,
  dispatchText,
  speakerBadge,
  strategyStatusLabel,
  type PauseAction,
  type StrategyDispatchItem,
  type StrategyMemberConfig,
  type StrategyMemberRole,
  type StrategyModelOption,
  type StrategySessionDetail,
  type StrategyStreamEvent,
  type StrategySyncResponse,
  type StrategyTemplateInfo,
  type StreamingMemberBubble,
  type ViewMode,
} from "@/components/strategy-types";

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
  onPatchSessionMeta: (patch: {
    models?: StrategyMemberConfig[];
    templateId?: string;
  }) => Promise<boolean>;
  wsMemorySaving?: boolean;
};

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
    onPatchSessionMeta,
    wsMemorySaving,
  } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streamBubbles, setStreamBubbles] = useState<StreamingMemberBubble[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [degradedHint, setDegradedHint] = useState(false);
  const [memberDraft, setMemberDraft] = useState<StrategyMemberConfig[]>([]);
  const [templateDraft, setTemplateDraft] = useState("");
  const [metaSaving, setMetaSaving] = useState(false);

  const roomScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const syncAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const abortReasonRef = useRef<"user" | "switch" | null>(null);
  const lastUpdatedAtRef = useRef(detail.session.updatedAt || 0);
  const sessionIdRef = useRef(detail.session.id);
  const streamingRef = useRef(false);
  const onSyncPatchRef = useRef(onSyncPatch);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pauseState = detail.session.pauseState ?? "none";
  const paused = pauseState !== "none";
  const pending = detail.dispatch.filter((d) => d.status === "pending");
  const dispatchedCount = detail.dispatch.filter((d) => d.status === "dispatched").length;
  const sessionId = detail.session.id;

  const activeTemplateId =
    templateDraft ||
    detail.session.templateId ||
    templates.find((t) => t.id === "automax")?.id ||
    templates[0]?.id ||
    "automax";
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? templates[0];

  streamingRef.current = streaming;
  onSyncPatchRef.current = onSyncPatch;

  useEffect(() => {
    onStreamingChange(streaming);
  }, [streaming, onStreamingChange]);

  useEffect(() => {
    const prev = sessionIdRef.current;
    if (prev !== detail.session.id) {
      abortReasonRef.current = "switch";
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      setStreaming(false);
      setPendingUser(null);
      setStreamBubbles([]);
      setNotices([]);
      setDegradedHint(false);
      setSettingsOpen(false);
    }
    sessionIdRef.current = detail.session.id;
    lastUpdatedAtRef.current = detail.session.updatedAt || 0;
  }, [detail.session.id, detail.session.updatedAt]);

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
    setTemplateDraft(detail.session.templateId || "");
  }, [detail.session.id, detail.session.models, detail.session.model, detail.session.templateId]);

  useEffect(() => {
    const el = roomScrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [detail.messages.length, streaming, pendingUser, streamBubbles, notices]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 72), 220)}px`;
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    const sid = sessionId;

    async function pull(force = false) {
      if (cancelled) return;
      if (!force && (document.visibilityState === "hidden" || streamingRef.current)) return;

      syncAbortRef.current?.abort();
      const ac = new AbortController();
      syncAbortRef.current = ac;
      const since = lastUpdatedAtRef.current || 0;
      try {
        const res = await fetch(
          `/api/strategy/sessions/${encodeURIComponent(sid)}/sync?since=${encodeURIComponent(String(since))}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!res.ok || cancelled || ac.signal.aborted) return;
        const data = (await res.json()) as StrategySyncResponse;
        if (!data || typeof data !== "object") return;
        if (!data.changed) {
          if (typeof data.updatedAt === "number" && data.updatedAt > lastUpdatedAtRef.current) {
            lastUpdatedAtRef.current = data.updatedAt;
          }
          return;
        }
        if (sid !== sessionIdRef.current) return;
        if (streamingRef.current) return;
        if (data.updatedAt < lastUpdatedAtRef.current) return;
        lastUpdatedAtRef.current = data.updatedAt;
        onSyncPatchRef.current(data);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      }
    }

    void pull(true);
    const timer = window.setInterval(() => void pull(false), 3000);
    const onVis = () => {
      if (document.visibilityState === "visible") void pull(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      syncAbortRef.current?.abort();
      abortReasonRef.current = "switch";
      streamAbortRef.current?.abort();
    };
  }, [sessionId]);

  function onScroll() {
    const el = roomScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist < 60;
  }

  function stopGeneration() {
    abortReasonRef.current = "user";
    streamAbortRef.current?.abort();
  }

  async function sendStream(text: string) {
    const sid = sessionId;
    const content = text.trim();
    if (!content || streaming || detail.session.status === "closed") return;

    onError(null);
    setDegradedHint(false);
    setNotices([]);
    setPendingUser(content);
    setStreamBubbles([]);
    onDraftChange("");
    setStreaming(true);
    abortReasonRef.current = null;

    const controller = new AbortController();
    streamAbortRef.current = controller;

    let lineBuffer = "";
    let sawDone = false;
    let completion: StrategyStreamEvent & { type: "done" } | null = null;

    try {
      const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sid)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (sid === sessionIdRef.current) {
          onError(data.error || "送出失敗");
          onDraftChange(content);
          setPendingUser(null);
          setStreamBubbles([]);
        }
        return;
      }
      if (!res.body) throw new Error("無串流回應");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
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
          if (sid !== sessionIdRef.current) continue;
          handleStreamEvent(ev);
          if (ev.type === "done") {
            sawDone = true;
            completion = ev;
          }
        }
      }

      if (sid !== sessionIdRef.current) return;

      if (completion?.aborted || completion?.completionStatus === "failed") {
        if (abortReasonRef.current === "user") {
          setPendingUser(null);
          setStreamBubbles([]);
          onDraftChange(content);
          requestAnimationFrame(() => textareaRef.current?.focus());
          void onRefreshWallet();
        } else if (abortReasonRef.current === "switch") {
          setPendingUser(null);
          setStreamBubbles([]);
        } else {
          onError("生成失敗或已中斷");
          setPendingUser(null);
          setStreamBubbles([]);
          onDraftChange(content);
        }
        return;
      }

      if (sawDone && (completion?.completionStatus === "ok" || completion?.completionStatus === "degraded")) {
        if (completion.completionStatus === "degraded") setDegradedHint(true);
        await onStreamCommitted(sid);
        if (sid === sessionIdRef.current) {
          setPendingUser(null);
          setStreamBubbles([]);
          void onRefreshWallet();
        }
        return;
      }

      // 無 done：當失敗處理
      if (abortReasonRef.current === "user") {
        setPendingUser(null);
        setStreamBubbles([]);
        onDraftChange(content);
        requestAnimationFrame(() => textareaRef.current?.focus());
        void onRefreshWallet();
      } else if (abortReasonRef.current !== "switch") {
        onError("連線中斷，回覆未完成");
        setPendingUser(null);
        setStreamBubbles([]);
        onDraftChange(content);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        if (sid === sessionIdRef.current && abortReasonRef.current === "user") {
          setPendingUser(null);
          setStreamBubbles([]);
          onDraftChange(content);
          requestAnimationFrame(() => textareaRef.current?.focus());
          void onRefreshWallet();
        } else if (sid === sessionIdRef.current && abortReasonRef.current === "switch") {
          setPendingUser(null);
          setStreamBubbles([]);
        }
      } else if (sid === sessionIdRef.current) {
        onError(e instanceof Error ? e.message : String(e));
        setPendingUser(null);
        setStreamBubbles([]);
        onDraftChange(content);
      }
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      if (sid === sessionIdRef.current) setStreaming(false);
      abortReasonRef.current = null;
    }
  }

  function handleStreamEvent(ev: StrategyStreamEvent) {
    if (ev.type === "notice" && ev.message) {
      setNotices((prev) => [...prev, ev.message]);
      return;
    }
    if (ev.type === "error" && ev.message && !ev.aborted) {
      onError(ev.message);
      return;
    }
    if (ev.type === "member_start") {
      const key = `${ev.role || "m"}-${ev.modelId || "x"}-${Date.now()}`;
      setStreamBubbles((prev) => [
        ...prev,
        {
          key,
          role: String(ev.role || "custom"),
          modelId: String(ev.modelId || ""),
          label: String(ev.label || ev.role || "AI"),
          content: "",
          thinking: "",
          thinkingOpen: false,
          done: false,
        },
      ]);
      return;
    }
    if (ev.type === "text" && ev.text) {
      setStreamBubbles((prev) => {
        if (!prev.length) {
          return [
            {
              key: `lead-${Date.now()}`,
              role: String(ev.role || "lead"),
              modelId: String(ev.modelId || ""),
              label: "主導",
              content: ev.text,
              thinking: "",
              thinkingOpen: false,
              done: false,
            },
          ];
        }
        const next = [...prev];
        const last = { ...next[next.length - 1]! };
        last.content += ev.text;
        next[next.length - 1] = last;
        return next;
      });
      return;
    }
    if (ev.type === "thinking" && ev.text) {
      setStreamBubbles((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        const last = { ...next[next.length - 1]! };
        last.thinking += ev.text;
        last.thinkingOpen = true;
        next[next.length - 1] = last;
        return next;
      });
      return;
    }
    if (ev.type === "member_done") {
      setStreamBubbles((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1]!, done: true, thinkingOpen: false };
        return next;
      });
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || streaming || detail.session.status === "closed") return;
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
      return [{ modelId: "gemini-4-neon-high", role: "lead", label: "主導" }];
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
      const pick = models.find((m) => m.available && !prev.some((p) => p.modelId === m.id));
      const modelId = pick?.id || models.find((m) => m.available)?.id || "gemini-4-neon-high";
      return ensureOneLead([
        ...prev,
        { modelId, role: "custom", label: pick?.label?.split("·")[0]?.trim() || "顧問" },
      ]);
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

  const modelOptionsForSelect = (selectedId: string) => {
    const selected = models.find((m) => m.id === selectedId);
    const avail = models.filter((m) => m.available || m.id === selectedId);
    if (selected && !avail.some((m) => m.id === selected.id)) avail.unshift(selected);
    return avail;
  };

  return (
    <section className="strategy-room-view" aria-label="策略會議室">
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
            資訊{pending.length ? `（${pending.length}）` : ""}
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
                onChange={(e) => setTemplateDraft(e.target.value)}
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
            {memberDraft.map((m, i) => (
              <li key={`${m.modelId}-${i}`}>
                <select
                  value={m.modelId}
                  disabled={metaSaving || streaming}
                  onChange={(e) => {
                    const id = e.target.value;
                    const opt = models.find((x) => x.id === id);
                    setMemberDraft((prev) =>
                      prev.map((row, j) =>
                        j === i
                          ? {
                              ...row,
                              modelId: id,
                              label: row.role === "lead" ? row.label : opt?.label?.split("·")[0]?.trim() || row.label,
                            }
                          : row,
                      ),
                    );
                  }}
                >
                  {modelOptionsForSelect(m.modelId).map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                      {!opt.available ? "（暫不可用）" : ""}
                    </option>
                  ))}
                </select>
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
            ))}
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
            {detail.messages.length === 0 && !pendingUser && streamBubbles.length === 0 ? (
              <div className="muted" style={{ fontSize: 13, padding: "12px 0" }}>
                尚無訊息
              </div>
            ) : (
              detail.messages.map((m) => (
                <div key={m.id} className={`strategy-msg strategy-msg-${m.role}`}>
                  <div className="strategy-msg-role">
                    {m.role === "assistant" ? (
                      <>
                        <span className="strategy-role-badge">{speakerBadge(m)}</span>
                        {m.speakerModel ? <span className="muted"> · {m.speakerModel}</span> : null}
                      </>
                    ) : m.role === "user" ? (
                      m.structured?.source === "web" ? (
                        "你（網頁）"
                      ) : m.structured?.source === "cursor" ? (
                        "Cursor"
                      ) : (
                        "Cursor／你"
                      )
                    ) : (
                      "系統"
                    )}
                  </div>
                  <pre className="strategy-msg-body">{m.content}</pre>
                </div>
              ))
            )}

            {pendingUser ? (
              <div className="strategy-msg strategy-msg-user is-pending">
                <div className="strategy-msg-role">你（網頁）· 送出中</div>
                <pre className="strategy-msg-body">{pendingUser}</pre>
              </div>
            ) : null}

            {streamBubbles.map((b) => (
              <div key={b.key} className={`strategy-msg strategy-msg-assistant is-streaming${b.done ? " is-done" : ""}`}>
                <div className="strategy-msg-role">
                  <span className={`strategy-role-badge is-${b.role}`}>{b.label}</span>
                  {b.modelId ? <span className="muted"> · {b.modelId}</span> : null}
                  {!b.done ? <span className="muted"> · 生成中</span> : null}
                </div>
                {b.thinking ? (
                  <details
                    className="strategy-thinking"
                    open={b.thinkingOpen}
                    onToggle={(e) => {
                      const open = (e.target as HTMLDetailsElement).open;
                      setStreamBubbles((prev) =>
                        prev.map((x) => (x.key === b.key ? { ...x, thinkingOpen: open } : x)),
                      );
                    }}
                  >
                    <summary>思考過程</summary>
                    <pre className="strategy-msg-body">{b.thinking}</pre>
                  </details>
                ) : null}
                <pre className="strategy-msg-body">{b.content || "…"}</pre>
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
              disabled={streaming || detail.session.status === "closed"}
              placeholder={
                detail.session.status === "closed"
                  ? "會議室已關閉"
                  : streaming
                    ? "生成中…可按停止"
                    : "在會議室發言（Enter 送出，Shift+Enter 換行）"
              }
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {streaming ? "逐字生成中…" : "每次發言會依 token 扣點"}
              </span>
              {streaming ? (
                <button type="button" className="strategy-stop-btn" onClick={stopGeneration}>
                  停止生成
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
