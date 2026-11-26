export type PauseState = "none" | "pausing" | "paused";
export type PauseAction = "graceful_pause" | "force_pause" | "resume";
export type ViewMode = "chat" | "strategy" | "split";

export type StrategyMemberRole = "lead" | "critic" | "engineer" | "custom";

export type StrategyMemberConfig = {
  modelId: string;
  role: StrategyMemberRole;
  label: string;
};

export type StrategyTemplateInfo = {
  id: string;
  name: string;
  description: string;
  stages: string[];
  quickPrompts: string[];
  recommendedModels: StrategyMemberConfig[];
};

export type StrategyModelOption = {
  id: string;
  label: string;
  familyId?: string;
  familyLabel?: string;
  provider?: string;
  category?: string;
  categoryLabel?: string;
  tier?: "top" | "main" | "light";
  /** 推理強度（如 low / medium / high），僅供下拉顯示 */
  effort?: string | null;
  available: boolean;
  note?: string;
};

/** 後台 SOP 範本（GET /api/admin/strategy-templates，camelCase） */
export type AdminStrategyTemplate = {
  id: string;
  name: string;
  description: string;
  stages: string[];
  quickPrompts: string[];
  recommendedModels: { role: string; modelId: string; label: string }[];
  systemPrompt: string;
  streamLeadPreface: string;
  enabled?: boolean;
  sortOrder?: number;
  isBuiltin?: boolean;
};

export type StrategyStreamEvent =
  | { type: "member_start"; role?: string; modelId?: string; label?: string }
  | { type: "thinking"; text: string; modelId?: string }
  | { type: "text"; text: string; modelId?: string; role?: string }
  | { type: "stage"; stage: string }
  | { type: "member_done"; role?: string; modelId?: string; label?: string }
  /** 可見文字已結束；落庫／派送仍在背景——前端應立刻解鎖輸入 */
  | { type: "input_ready" }
  | { type: "notice"; message: string }
  | { type: "error"; message: string; aborted?: boolean }
  | {
      type: "done";
      completionStatus?: "ok" | "degraded" | "failed";
      aborted?: boolean;
      assistant?: {
        reply?: string;
        phase?: string;
        dispatchIds?: string[];
        pauseState?: PauseState;
      };
      limits?: unknown;
    };

export type StreamingMemberBubble = {
  key: string;
  role: string;
  modelId: string;
  label: string;
  content: string;
  done: boolean;
};

export interface StrategySessionBrief {
  id: string;
  name: string;
  status: string;
  model?: string;
  models?: StrategyMemberConfig[] | null;
  templateId?: string | null;
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
  structured?: { source?: string; kind?: string; turnId?: string; completionStatus?: string };
  createdAt: number;
  speakerModel?: string | null;
  speakerRole?: string | null;
  speakerLabel?: string | null;
  turnId?: string | null;
  completionStatus?: "ok" | "degraded" | "partial" | "aborted" | "failed" | null;
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
  /** 4A：尚有更舊訊息（超過 hardCap／單頁） */
  hasMore?: boolean;
  nextCursor?: string | null;
  messageTotal?: number;
  reports: { id: string; title: string; chars: number; createdAt: number }[];
  runs: { id: string; profileId?: string; createdAt?: number }[];
}

export type StrategySyncResponse =
  | {
      changed: false;
      updatedAt: number;
      sessionUpdatedAt?: number;
      workspaceUpdatedAt?: number;
      messageCount?: number;
    }
  | {
      changed: true;
      updatedAt: number;
      sessionUpdatedAt?: number;
      workspaceUpdatedAt?: number;
      messageCount?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
      messageTotal?: number;
      /** 新增量超過補齊上限，本頁與本機之間仍有缺口，需整房重載 */
      gap?: boolean;
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

export const MEMBER_ROLE_LABEL: Record<StrategyMemberRole, string> = {
  lead: "主導",
  critic: "審查",
  engineer: "工程",
  custom: "顧問",
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

export function speakerBadge(m: StrategySessionMessage): string {
  if (m.role !== "assistant") return "";
  if (m.speakerLabel) return m.speakerLabel;
  if (m.speakerRole && m.speakerRole in MEMBER_ROLE_LABEL) {
    return MEMBER_ROLE_LABEL[m.speakerRole as StrategyMemberRole];
  }
  return "會議室";
}
