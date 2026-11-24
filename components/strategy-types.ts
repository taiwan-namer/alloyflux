export type PauseState = "none" | "pausing" | "paused";
export type PauseAction = "graceful_pause" | "force_pause" | "resume";
export type ViewMode = "chat" | "strategy" | "split";

export interface StrategySessionBrief {
  id: string;
  name: string;
  status: string;
  model?: string;
  topic?: string;
  summary?: string;
  autoDispatch?: boolean;
  pauseState?: PauseState;
  updatedAt: number;
}

export interface StrategyWorkspaceBrief {
  id: string;
  name: string;
  memory: { notes: string };
  rooms: StrategySessionBrief[];
}

export interface StrategySessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  structured?: { source?: string };
  createdAt: number;
}

export interface StrategyDispatchItem {
  id: string;
  instruction: unknown;
  status: "pending" | "dispatched" | "done" | "rejected";
  note: string;
  createdAt: number;
}

export interface StrategySessionDetail {
  session: StrategySessionBrief & {
    profileId?: string;
    strategyVersion?: string;
    pendingInstructions?: unknown[];
    workspaceId?: string;
    summaryUpdatedAt?: number;
  };
  dispatch: StrategyDispatchItem[];
  dossier: {
    strategies: Record<string, string>;
    findings: string[];
    decisions: string[];
    fPlan: Record<string, unknown> | null;
  };
  messages: StrategySessionMessage[];
  reports: { id: string; title: string; chars: number; createdAt: number }[];
  runs: { id: string; profileId?: string; createdAt?: number }[];
}

export type StrategySyncResponse =
  | {
      changed: false;
      updatedAt: number;
      sessionUpdatedAt?: number;
      workspaceUpdatedAt?: number;
    }
  | {
      changed: true;
      updatedAt: number;
      sessionUpdatedAt?: number;
      workspaceUpdatedAt?: number;
      workspaceMemoryNotes?: string;
      session: StrategySessionDetail["session"];
      dossier: StrategySessionDetail["dossier"];
      messages: StrategySessionDetail["messages"];
      runs: StrategySessionDetail["runs"];
      reports: StrategySessionDetail["reports"];
      dispatch: StrategySessionDetail["dispatch"];
      limits?: unknown;
    };

export const DISPATCH_STATUS_LABEL: Record<StrategyDispatchItem["status"], string> = {
  pending: "待確認",
  dispatched: "已派送",
  done: "Cursor 已完成",
  rejected: "已駁回",
};

export const STRATEGY_STATUS_LABEL: Record<string, string> = {
  discovery: "探索中",
  designing: "設計中",
  ready_to_run: "可開跑",
  running: "進行中",
  collecting: "收集中",
  reviewing: "復盤中",
  await_code: "待改碼",
  ready_next_run: "可再開下一輪",
  closed: "已關閉",
};

export const PAUSE_STATE_LABEL: Record<PauseState, string> = {
  none: "正常",
  pausing: "暫停中",
  paused: "已暫停",
};

export function strategyStatusLabel(status: string): string {
  return STRATEGY_STATUS_LABEL[status] ?? status;
}

export function dispatchText(instruction: unknown): string {
  if (typeof instruction === "string") return instruction;
  if (instruction && typeof instruction === "object") {
    const o = instruction as { title?: unknown; spec?: unknown };
    if (typeof o.title === "string") {
      return `報告：${o.title}${typeof o.spec === "string" ? `｜${o.spec}` : ""}`;
    }
  }
  return JSON.stringify(instruction);
}
