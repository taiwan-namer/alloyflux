/**
 * 4B SOP：區分伺服器原始 templateId、畫面 fallback、本機待保存／已確認值。
 * 不依賴後端時鐘；用世代＋寬限期擋晚到舊 sync，逾時接受合法外部更新。
 */

export type SopTemplateGate = {
  sessionId: string;
  /** 本機選擇（含明確選預設） */
  localValue: string;
  /** 保存發起時的世代 */
  gen: number;
  /** 成功保存後黏住，直到 server 對齊或寬限逾時 */
  stickyAfterOk: boolean;
  savedAtMs: number;
  /** 保存前的 server 原始值（null = 未設） */
  serverBefore: string | null;
};

export const SOP_STICKY_GRACE_MS = 15_000;

export function displayTemplateId(
  localDraft: string | null | undefined,
  serverRaw: string | null | undefined,
  fallbackId: string,
): string {
  if (localDraft != null && localDraft !== "") return localDraft;
  if (serverRaw != null && serverRaw !== "") return serverRaw;
  return fallbackId;
}

/** 使用者選取是否需要 PATCH（含：畫面已是預設但 server 為 null） */
export function shouldPatchTemplateSelection(
  nextId: string,
  serverRaw: string | null | undefined,
  localDraft: string | null | undefined,
): boolean {
  const server = serverRaw ?? null;
  if (server === nextId) {
    // server 已是此值：若 local 也一致則可跳過
    if ((localDraft ?? server) === nextId) return false;
  }
  // server null／不同，或 local 與 next 不同 → 需要 PATCH
  if (server !== nextId) return true;
  return (localDraft ?? "") !== nextId;
}

export type ApplyServerTemplateResult =
  | { action: "ignore" }
  | { action: "accept"; clearGate: boolean; nextLocal: string };

/**
 * 決定是否接受外部／sync 帶來的 server templateId。
 * - 保存中：忽略
 * - sticky 且 server 已對齊：接受並清 gate
 * - sticky 且未對齊且在寬限內：忽略（晚到舊 sync）
 * - sticky 且寬限外：接受外部更新（合法接管）
 * - 無 gate：接受
 */
export function applyServerTemplateId(opts: {
  sessionId: string;
  serverRaw: string | null | undefined;
  saving: boolean;
  gate: SopTemplateGate | null;
  nowMs: number;
  graceMs?: number;
}): ApplyServerTemplateResult {
  const grace = opts.graceMs ?? SOP_STICKY_GRACE_MS;
  const server = opts.serverRaw ?? "";
  if (opts.saving) return { action: "ignore" };

  const gate = opts.gate;
  if (!gate || gate.sessionId !== opts.sessionId) {
    return { action: "accept", clearGate: true, nextLocal: server };
  }

  if (!gate.stickyAfterOk) {
    // 尚在飛的請求：忽略 props 覆寫
    return { action: "ignore" };
  }

  if (server === gate.localValue) {
    return { action: "accept", clearGate: true, nextLocal: server };
  }

  if (opts.nowMs - gate.savedAtMs < grace) {
    return { action: "ignore" };
  }

  // 寬限過後：允許合法外部更新接管
  return { action: "accept", clearGate: true, nextLocal: server };
}

export function beginTemplateSave(opts: {
  sessionId: string;
  nextId: string;
  serverBefore: string | null;
  prevGen: number;
}): SopTemplateGate {
  return {
    sessionId: opts.sessionId,
    localValue: opts.nextId,
    gen: opts.prevGen + 1,
    stickyAfterOk: false,
    savedAtMs: 0,
    serverBefore: opts.serverBefore,
  };
}

export function markTemplateSaveOk(gate: SopTemplateGate, nowMs: number): SopTemplateGate {
  return { ...gate, stickyAfterOk: true, savedAtMs: nowMs };
}

/** 失敗 rollback：僅當 gate 仍是該世代且值仍為該次選擇時才還原 */
export function shouldRollbackTemplate(opts: {
  gate: SopTemplateGate | null;
  sessionId: string;
  expectedGen: number;
  currentLocal: string;
}): boolean {
  const g = opts.gate;
  if (!g) return false;
  if (g.sessionId !== opts.sessionId) return false;
  if (g.gen !== opts.expectedGen) return false;
  if (g.localValue !== opts.currentLocal) return false;
  return true;
}
