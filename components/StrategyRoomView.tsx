"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  DISPATCH_STATUS_LABEL,
  PAUSE_STATE_LABEL,
  dispatchText,
  strategyStatusLabel,
  type PauseAction,
  type StrategyDispatchItem,
  type StrategySessionDetail,
  type StrategySyncResponse,
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
  sending: boolean;
  busy: boolean;
  error: string | null;
  canSplit: boolean;
  viewMode: ViewMode;
  onToggleSplit: () => void;
  onBackToChat: () => void;
  onOpenSidebar: () => void;
  onSend: () => void;
  onRefresh: () => void;
  onDecideDispatch: (action: "dispatch" | "reject") => void;
  onToggleAutoDispatch: (next: boolean) => void;
  onSaveMemory: () => void;
  onPauseAction: (action: PauseAction) => void;
  onMarkDispatchDone: (dispatchId: string) => void;
  onSyncPatch: (data: Extract<StrategySyncResponse, { changed: true }>) => void;
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
    sending,
    busy,
    error,
    canSplit,
    viewMode,
    onToggleSplit,
    onBackToChat,
    onOpenSidebar,
    onSend,
    onRefresh,
    onDecideDispatch,
    onToggleAutoDispatch,
    onSaveMemory,
    onPauseAction,
    onMarkDispatchDone,
    onSyncPatch,
    wsMemorySaving,
  } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const roomScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const syncAbortRef = useRef<AbortController | null>(null);
  const lastUpdatedAtRef = useRef(detail.session.updatedAt || 0);
  const sessionIdRef = useRef(detail.session.id);
  const sendingRef = useRef(sending);
  const onSyncPatchRef = useRef(onSyncPatch);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pauseState = detail.session.pauseState ?? "none";
  const paused = pauseState !== "none";
  const pending = detail.dispatch.filter((d) => d.status === "pending");
  const dispatchedCount = detail.dispatch.filter((d) => d.status === "dispatched").length;
  const sessionId = detail.session.id;

  sendingRef.current = sending;
  onSyncPatchRef.current = onSyncPatch;

  useEffect(() => {
    sessionIdRef.current = detail.session.id;
    lastUpdatedAtRef.current = detail.session.updatedAt || 0;
  }, [detail.session.id, detail.session.updatedAt]);

  useEffect(() => {
    const el = roomScrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [detail.messages.length, sending]);

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
      if (!force && (document.visibilityState === "hidden" || sendingRef.current)) return;

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
        if (sendingRef.current) return;
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
    };
  }, [sessionId]);

  function onScroll() {
    const el = roomScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist < 96;
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending || detail.session.status === "closed") return;
    onSend();
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
          <span
            className="strategy-exec-chip"
            title="依平台派送狀態統計；若 CLI 未回報完成，可於抽屜手動標記完成或按強制立即暫停"
          >
            執行中 {dispatchedCount}
          </span>
          {pauseState === "none" ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => onPauseAction("graceful_pause")}>
              優雅暫停
            </button>
          ) : null}
          {pauseState === "pausing" ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => onPauseAction("force_pause")}>
              強制立即暫停
            </button>
          ) : null}
          {pauseState === "pausing" || pauseState === "paused" ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => onPauseAction("resume")}>
              恢復執行
            </button>
          ) : null}
          {canSplit ? (
            <button
              type="button"
              className={`ghost${viewMode === "split" ? " is-active" : ""}`}
              onClick={onToggleSplit}
              title="一般聊天｜會議室並排"
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
          <button type="button" className="ghost" disabled={busy} onClick={onRefresh}>
            重新整理
          </button>
        </div>
      </header>

      <div className={`strategy-room-body${drawerOpen ? " drawer-open" : ""}`}>
        <div className="strategy-room-main">
          <div className="strategy-room-msg-list" ref={roomScrollRef} onScroll={onScroll}>
            {detail.messages.length === 0 ? (
              <div className="muted" style={{ fontSize: 13, padding: "12px 0" }}>
                尚無訊息
              </div>
            ) : (
              detail.messages.map((m) => (
                <div key={m.id} className={`strategy-msg strategy-msg-${m.role}`}>
                  <div className="strategy-msg-role">
                    {m.role === "assistant"
                      ? "會議室"
                      : m.role === "user"
                        ? m.structured?.source === "web"
                          ? "你（網頁）"
                          : m.structured?.source === "cursor"
                            ? "Cursor"
                            : "Cursor／你"
                        : "系統"}
                  </div>
                  <pre className="strategy-msg-body">{m.content}</pre>
                </div>
              ))
            )}
          </div>

          {error ? (
            <div className="strategy-room-error" role="alert">
              {error}
            </div>
          ) : null}

          <form className="strategy-room-composer" onSubmit={submit}>
            <textarea
              ref={textareaRef}
              value={draft}
              maxLength={8000}
              rows={3}
              disabled={sending || detail.session.status === "closed"}
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
                {sending ? "主持人思考中…" : "每次發言會依 token 扣點"}
              </span>
              <button type="submit" disabled={sending || !draft.trim() || detail.session.status === "closed"}>
                送出
              </button>
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
