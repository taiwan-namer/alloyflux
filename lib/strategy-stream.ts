import { STRATEGY_STATE_DELIMITER } from "./strategy-templates";

export type NdjsonEvent = Record<string, unknown> & { type: string };

/** NDJSON 編碼（與一般聊天 /api/chat 相同慣例） */
export function encodeNdjson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
}

export const STRATEGY_STREAM_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

/**
 * 主導 AI 雙段輸出：可見純文字 + 分隔線後的結構化 JSON。
 * - 未見分隔線：若開頭像 JSON／fence，整段緩衝（不吐字），結束走 extractJsonObject
 * - 見分隔線：分隔前可吐字；分隔後靜默累積 JSON
 */
export class StrategyJsonTailBuffer {
  private buf = "";
  private mode: "unknown" | "prose" | "json_only" | "after_delim" = "unknown";
  private visible = "";
  private jsonPart = "";
  private readonly delim: string;

  constructor(delim = STRATEGY_STATE_DELIMITER) {
    this.delim = delim;
  }

  /** 回傳本次可對前端 emit 的純文字（可能為空） */
  push(chunk: string): string {
    if (!chunk) return "";
    this.buf += chunk;

    if (this.mode === "unknown") {
      const trimmedStart = this.buf.trimStart();
      if (!trimmedStart) return "";
      if (trimmedStart.startsWith("{") || trimmedStart.startsWith("```")) {
        this.mode = "json_only";
        return "";
      }
      // 尚不足以判斷時先不吐，避免把 `{` 前空白吐出去；有明顯非 JSON 字元再切 prose
      if (trimmedStart.length < 1) return "";
      this.mode = "prose";
    }

    if (this.mode === "json_only") {
      return "";
    }

    if (this.mode === "after_delim") {
      this.jsonPart = this.buf;
      return "";
    }

    // prose：找分隔線
    const idx = this.buf.indexOf(this.delim);
    if (idx >= 0) {
      const before = this.buf.slice(0, idx);
      const emit = before.slice(this.visible.length);
      this.visible = before;
      this.mode = "after_delim";
      this.jsonPart = this.buf.slice(idx + this.delim.length);
      // 丟掉已處理的可見部分標記：之後 buf 僅用於 json；簡化為保留全 buf
      return emit.replace(/\s+$/, (m) => (m.includes("\n") ? "\n" : ""));
    }

    // 尚未看到完整 delim：保留尾端可能是 delim 前綴的長度，避免把半截 delim 吐出
    const hold = Math.min(this.buf.length, this.delim.length - 1);
    const safeEnd = this.buf.length - hold;
    if (safeEnd <= this.visible.length) return "";
    const emit = this.buf.slice(this.visible.length, safeEnd);
    this.visible = this.buf.slice(0, safeEnd);
    return emit;
  }

  /** 串流結束：沖出剩餘可見文字（prose 且未進 delim） */
  flushVisible(): string {
    if (this.mode === "prose") {
      const emit = this.buf.slice(this.visible.length);
      // 若尾端剛好是完整 delim（極少見，hold 未觸發）
      const idx = this.buf.indexOf(this.delim);
      if (idx >= 0) {
        const before = this.buf.slice(0, idx);
        const out = before.slice(this.visible.length);
        this.visible = before;
        this.mode = "after_delim";
        this.jsonPart = this.buf.slice(idx + this.delim.length);
        return out;
      }
      this.visible = this.buf;
      return emit;
    }
    return "";
  }

  getVisibleText(): string {
    if (this.mode === "json_only") return "";
    if (this.mode === "after_delim" || this.mode === "prose") return this.visible.trimEnd();
    return "";
  }

  /** 供 extractJsonObject 的原材料 */
  getJsonRaw(): string {
    if (this.mode === "json_only") return this.buf.trim();
    if (this.mode === "after_delim") return this.jsonPart.trim();
    // prose 無分隔：整段當可能含 JSON 的 fallback
    return this.buf.trim();
  }

  getMode(): string {
    return this.mode;
  }
}

/** 從尚未寫完的 JSON 裡取出某個字串欄位。回覆先出現時，不必等後面的欄位寫完 */
export function readPartialJsonStringField(raw: string, field: string): string | null {
  const key = `"${field}"`;
  const at = raw.indexOf(key);
  if (at < 0) return null;
  let i = raw.indexOf(":", at + key.length);
  if (i < 0) return null;
  i += 1;
  while (i < raw.length && raw[i] !== undefined && /\s/.test(raw[i]!)) i += 1;
  if (raw[i] !== '"') return null;
  i += 1;
  let out = "";
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "\\") {
      if (i + 1 >= raw.length) return out || null;
      const n = raw[i + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n ?? "";
      i += 2;
      continue;
    }
    if (c === '"') return out;
    out += c;
    i += 1;
  }
  return out || null;
}
