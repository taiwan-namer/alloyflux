import type { ChatMessage } from "./providers";

/** 上游至少帶最近 N 輪（1 輪 = user+assistant 各 1，即 2N 則） */
export const UPSTREAM_MAX_TURNS = 8;
export const UPSTREAM_MAX_MESSAGES = UPSTREAM_MAX_TURNS * 2;
/**
 * 視窗起點每 N 輪才前移一次（對齊到 2N 則的倍數），讓連續幾輪的請求開頭維持一致、可命中 prompt cache。
 * 實際帶入 UPSTREAM_MAX_TURNS ～ UPSTREAM_MAX_TURNS + N - 1 輪，永不少於 UPSTREAM_MAX_TURNS。
 */
export const UPSTREAM_WINDOW_STEP_TURNS = 4;
const WINDOW_STEP_MESSAGES = UPSTREAM_WINDOW_STEP_TURNS * 2;

/** 視窗起點：保留至少 minKeep 則，起點對齊 WINDOW_STEP_MESSAGES 的倍數 */
export function alignedWindowStart(length: number, minKeep: number): number {
  if (length <= minKeep) return 0;
  return Math.floor((length - minKeep) / WINDOW_STEP_MESSAGES) * WINDOW_STEP_MESSAGES;
}

/** 從 DB 讀取的歷史上限：最多 maxKeep 則，丟棄量對齊 WINDOW_STEP_MESSAGES，與 alignedWindowStart 起點一致 */
export function alignedTail<T>(items: T[], maxKeep: number): T[] {
  if (items.length <= maxKeep) return items;
  const drop = Math.ceil((items.length - maxKeep) / WINDOW_STEP_MESSAGES) * WINDOW_STEP_MESSAGES;
  return items.slice(drop);
}

/** 緊鄰當前問題的上一則 assistant：頭尾保留總量（多輪深度對照需保留完整分析與結尾表格） */
export const LAST_ASSISTANT_MAX_CHARS = 3600;
const LAST_ASSISTANT_HEAD = 2400;
const LAST_ASSISTANT_TAIL = 1200;

/** 上一則含 ```html 預覽時放寬，避免改色／加按鈕時被迫整份重寫 */
export const LAST_ASSISTANT_HTML_MAX_CHARS = 4800;
const LAST_ASSISTANT_HTML_HEAD = 3200;
const LAST_ASSISTANT_HTML_TAIL = 1600;

/** 更早的舊 assistant 每則上限（頭尾保留，避免前幾輪名單／工具名／法條表格在 300 字處被腰斬） */
export const OLDER_ASSISTANT_MAX_CHARS = 1800;
const OLDER_ASSISTANT_HEAD = 1200;
const OLDER_ASSISTANT_TAIL = 600;

const FOLDED_MARK = "...[歷史長文已折疊]";
const MIDDLE_MARK = "\n...[中略]...\n";

/**
 * 助手「自我元話語」：撤回／不能上網／叫用戶貼連結等。
 * 只剝這類句子，不碰新聞正文裡的「董事會撤回」等（需有「我／前面我」等自指）。
 */
const RETRACT_META_LINE_RE =
  /(?:^|.*?)(?:另外)?先更正|我(?:正式)?撤回|正式撤回|全部撤回|我沒有(?:可操作的)?搜尋工具|我無法(?:自行)?(?:上網|搜尋|操作瀏覽器)|這不是已完成的即時查詢|不能再拿未核實|不足以可靠確認|請不要據此做投資|你把看到的新聞連結貼|如果你貼上其中一篇|請你直接查看|我先前把它們當新聞|超出了證據|目前尚未核實，不是已證實/i;

function alreadyFolded(content: string): boolean {
  return content.includes("[歷史長文已折疊]") || content.includes("[中略]");
}

/** 送上游前剝除翻供／不能上網元話語（不改 DB；畫面仍可見原文） */
export function scrubRetractMetaTone(content: string): string {
  const text = content ?? "";
  if (!text.trim()) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      kept.push(line);
      continue;
    }
    // 新聞／公司公告正文：有「撤回」但無助手自指 → 保留
    if (/撤回/.test(t) && /董事會|公司|官方|公告|決議|提名/.test(t) && !/我|前面|先前|正式撤回|全部撤回/.test(t)) {
      kept.push(line);
      continue;
    }
    if (RETRACT_META_LINE_RE.test(t)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 視窗前段的舊 assistant：固定只留開頭（重複套用結果不變） */
export const FOLDED_ASSISTANT_KEEP_CHARS = 200;

function foldToFixed(content: string): string {
  const text = content ?? "";
  if (text.endsWith(FOLDED_MARK) && text.length <= FOLDED_ASSISTANT_KEEP_CHARS + FOLDED_MARK.length) return text;
  if (text.length <= FOLDED_ASSISTANT_KEEP_CHARS) return text;
  return `${text.slice(0, FOLDED_ASSISTANT_KEEP_CHARS)}${FOLDED_MARK}`;
}

function hasHtmlFence(content: string): boolean {
  return /```html/i.test(content ?? "");
}

function compressHeadTail(content: string, max: number, head: number, tail: number): string {
  const text = content ?? "";
  if (text.length <= max || alreadyFolded(text)) return text;
  return `${text.slice(0, head)}${MIDDLE_MARK}${text.slice(-tail)}`;
}

/** 上一則 assistant：一般 ≤1000；含 ```html 時 ≤2400 */
export function compressLastAssistant(content: string): string {
  if (hasHtmlFence(content)) {
    return compressHeadTail(
      content,
      LAST_ASSISTANT_HTML_MAX_CHARS,
      LAST_ASSISTANT_HTML_HEAD,
      LAST_ASSISTANT_HTML_TAIL,
    );
  }
  return compressHeadTail(content, LAST_ASSISTANT_MAX_CHARS, LAST_ASSISTANT_HEAD, LAST_ASSISTANT_TAIL);
}

/** 舊長文採頭尾保留，避免把前幾輪中後段的關鍵名單、數據與結論整段砍掉；已折疊則不再處理 */
export function compressOlderAssistant(content: string): string {
  const text = content ?? "";
  if (text.length <= OLDER_ASSISTANT_MAX_CHARS || alreadyFolded(text)) return text;
  return compressHeadTail(text, OLDER_ASSISTANT_MAX_CHARS, OLDER_ASSISTANT_HEAD, OLDER_ASSISTANT_TAIL);
}

/** 視窗開頭這麼多則（= 前 4 輪）內的舊 assistant 一律折成固定短句 */
export const FOLD_HEAD_MESSAGES = WINDOW_STEP_MESSAGES;

/**
 * 對滑動視窗內的歷史 assistant 做字元級瘦身（不改 DB；user 全文保留）。
 * - 最後一則 assistant：頭尾保留（見 compressLastAssistant）
 * - 視窗前 FOLD_HEAD_MESSAGES 則內的舊 assistant：固定只留開頭 200 字
 * - 其餘舊 assistant：頭尾保留 ≤1800
 *
 * 每則結果只依「自身內容」與「在視窗中的位置」決定，不看後面又來了幾則：
 * 視窗起點每 4 輪才前移，期間已送出的訊息逐字不變，上游 prompt cache 才能命中。
 */
export function slimAssistantHistory(messages: ChatMessage[]): ChatMessage[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((m, i) => {
    if (m.role !== "assistant") return m;
    const scrubbed = scrubRetractMetaTone(m.content);
    const content =
      i === lastAssistantIdx
        ? compressLastAssistant(scrubbed)
        : i < FOLD_HEAD_MESSAGES
          ? foldToFixed(scrubbed)
          : compressOlderAssistant(scrubbed);
    return content === m.content ? m : { ...m, content };
  });
}

/**
 * 滑動視窗：DB 可留全文，送給上游的 payload 至少取最近 maxTurns 輪（起點對齊，見 alignedWindowStart），
 * 並對歷史 assistant 長文做智慧瘦身。
 * 保證開頭是 user（若截斷後首則是 assistant 則丟掉）。
 */
export function slideMessagesForUpstream(
  messages: ChatMessage[],
  maxTurns = UPSTREAM_MAX_TURNS,
): ChatMessage[] {
  const maxMsgs = Math.max(1, maxTurns * 2);
  const filtered = messages.filter((m) => m.content?.trim() || (m.images && m.images.length > 0));
  let sliced = filtered.slice(alignedWindowStart(filtered.length, maxMsgs));
  while (sliced.length && sliced[0].role !== "user") sliced = sliced.slice(1);
  return slimAssistantHistory(sliced);
}
