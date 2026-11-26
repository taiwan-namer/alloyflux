/**
 * 4B：自適應拆吐（依積壓量逐幀取碼點，非整段 rAF flush、非固定 ms/字）。
 */

export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

export function joinCodePoints(points: string[]): string {
  return points.join("");
}

/** 跟聊天一樣：本幀把已到的字一次接上，不逐字拖、不製造空等。 */
export function adaptiveTakeCount(backlog: number): number {
  return backlog > 0 ? backlog : 0;
}

/** @deprecated 遠端回覆已改為直接顯示；保留給舊測試。 */
export function typewriterTakeCount(backlog: number): number {
  return adaptiveTakeCount(backlog);
}

export function takeAdaptiveSlice(
  pending: string,
  takeCount: (backlog: number) => number = adaptiveTakeCount,
): { take: string; rest: string } {
  if (!pending) return { take: "", rest: "" };
  const pts = toCodePoints(pending);
  const n = takeCount(pts.length);
  if (n >= pts.length) return { take: pending, rest: "" };
  return {
    take: joinCodePoints(pts.slice(0, n)),
    rest: joinCodePoints(pts.slice(n)),
  };
}

export type DripBubbleState = {
  key: string;
  role: string;
  modelId: string;
  label: string;
  /** 已接收全文（權威；動畫不得改此契約內容） */
  received: string;
  /** 已顯示前綴 */
  displayed: string;
  done: boolean;
};

export type AdaptiveDripDriver = {
  upsert: (bubble: {
    key: string;
    role: string;
    modelId: string;
    label: string;
    received: string;
    done?: boolean;
    /** 只在新建時使用，避免一進房把已經寫好的字再打一遍 */
    displayed?: string;
  }) => void;
  markDone: (key: string) => void;
  /** 顯示立刻對齊已接收（done／進入 committing 前） */
  flushDisplay: () => DripBubbleState[];
  /** 停止：取消排程並清空 */
  stopAndClear: () => void;
  /** 僅取消排程，保留狀態（少用） */
  cancelSchedule: () => void;
  snapshot: () => DripBubbleState[];
  /** 有積壓則排程；回傳本幀是否仍有待吐 */
  tick: () => boolean;
  schedule: (onFrame: (snap: DripBubbleState[]) => void) => void;
};

export function createAdaptiveDripDriver(
  raf: (cb: FrameRequestCallback) => number = typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
  caf: (id: number) => void = typeof cancelAnimationFrame !== "undefined"
    ? cancelAnimationFrame
    : (id) => clearTimeout(id),
  takeCount: (backlog: number) => number = adaptiveTakeCount,
): AdaptiveDripDriver {
  const byKey = new Map<string, DripBubbleState>();
  const order: string[] = [];
  let rafId = 0;
  let frameCb: ((snap: DripBubbleState[]) => void) | null = null;

  function list(): DripBubbleState[] {
    return order.map((k) => byKey.get(k)!).filter(Boolean);
  }

  function cancelSchedule() {
    if (rafId) {
      caf(rafId);
      rafId = 0;
    }
  }

  function tick(): boolean {
    let pending = false;
    for (const key of order) {
      const b = byKey.get(key);
      if (!b) continue;
      if (b.displayed === b.received) continue;
      // 以碼點對齊：displayed 必為 received 前綴
      const recvPts = toCodePoints(b.received);
      const dispPts = toCodePoints(b.displayed);
      const backlogPts = recvPts.slice(dispPts.length);
      const { take, rest } = takeAdaptiveSlice(joinCodePoints(backlogPts), takeCount);
      b.displayed = joinCodePoints(dispPts) + take;
      if (rest) pending = true;
      else if (b.displayed !== b.received) pending = true;
    }
    return pending;
  }

  function schedule(onFrame: (snap: DripBubbleState[]) => void) {
    frameCb = onFrame;
    if (rafId) return;
    const step = () => {
      rafId = 0;
      const more = tick();
      frameCb?.(list().map((b) => ({ ...b })));
      if (more && frameCb) {
        rafId = raf(step);
      }
    };
    rafId = raf(step);
  }

  return {
    upsert(bubble) {
      const prev = byKey.get(bubble.key);
      if (!prev) {
        order.push(bubble.key);
        byKey.set(bubble.key, {
          key: bubble.key,
          role: bubble.role,
          modelId: bubble.modelId,
          label: bubble.label,
          received: bubble.received,
          displayed:
            bubble.displayed && bubble.received.startsWith(bubble.displayed) ? bubble.displayed : "",
          done: Boolean(bubble.done),
        });
      } else {
        prev.role = bubble.role;
        prev.modelId = bubble.modelId;
        prev.label = bubble.label;
        prev.received = bubble.received;
        if (bubble.done) prev.done = true;
        // 若 received 縮短（不應發生），夾住 displayed
        if (!prev.received.startsWith(prev.displayed)) {
          prev.displayed = "";
        }
      }
    },
    markDone(key) {
      const b = byKey.get(key);
      if (b) b.done = true;
    },
    flushDisplay() {
      cancelSchedule();
      for (const b of byKey.values()) {
        b.displayed = b.received;
      }
      return list().map((b) => ({ ...b }));
    },
    stopAndClear() {
      cancelSchedule();
      frameCb = null;
      byKey.clear();
      order.length = 0;
    },
    cancelSchedule,
    snapshot: () => list().map((b) => ({ ...b })),
    tick,
    schedule,
  };
}
