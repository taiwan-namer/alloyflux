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
/** 一般歷史 assistant 合計硬鎖 */
export const MAX_HISTORY_ASSISTANT_CHARS = 8000;
/** 上一則含 HTML 時合計硬鎖（連動放寬） */
export const MAX_HISTORY_ASSISTANT_CHARS_WITH_HTML = 10000;

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

/** 超出合計額度的舊 assistant：固定只留開頭（重複套用結果不變） */
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

/**
 * 對滑動視窗內的歷史 assistant 做字元級瘦身（不改 DB；user 全文保留）。
 * - 最後一則 assistant：≤1000（頭 650 + 尾 350）；含 ```html 時 ≤2400（頭 1600 + 尾 800）
 * - 更早的 assistant：≤300
 * - 合計硬鎖：一般 2200；上一則含 HTML 時 3600
 */
export function slimAssistantHistory(messages: ChatMessage[]): ChatMessage[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  const out = messages.map((m, i) => {
    if (m.role !== "assistant") return m;
    const scrubbed = scrubRetractMetaTone(m.content);
    const content =
      i === lastAssistantIdx ? compressLastAssistant(scrubbed) : compressOlderAssistant(scrubbed);
    return content === m.content ? m : { ...m, content };
  });

  const lastHasHtml =
    lastAssistantIdx >= 0 && hasHtmlFence(out[lastAssistantIdx]?.content ?? "");
  const totalCap = lastHasHtml ? MAX_HISTORY_ASSISTANT_CHARS_WITH_HTML : MAX_HISTORY_ASSISTANT_CHARS;

  let total = 0;
  for (const m of out) {
    if (m.role === "assistant") total += m.content.length;
  }
  if (total <= totalCap) return out;

  // 從最新往回分配額度；額度用完後，更早的一律折成固定長度。
  // 每則只依自身內容與「是否在額度內」決定結果，不會隨總長逐輪微調 → 視窗開頭跨輪一致，才吃得到 prompt cache
  const result = out.map((m) => ({ ...m }));
  // 預留固定額度給上一則（不用它的實際長度，否則分界會隨上一則長短來回跳）
  let budget = MAX_HISTORY_ASSISTANT_CHARS - LAST_ASSISTANT_MAX_CHARS;
  let foldRest = false;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role !== "assistant" || i === lastAssistantIdx) continue;
    const len = result[i].content.length;
    if (!foldRest && len <= budget) {
      budget -= len;
      continue;
    }
    foldRest = true;
    const next = foldToFixed(result[i].content);
    total -= len - next.length;
    result[i] = { ...result[i], content: next };
  }
  if (total > totalCap && lastAssistantIdx >= 0) {
    const m = result[lastAssistantIdx];
    const room = total - totalCap;
    const keep = Math.max(200, m.content.length - room);
    result[lastAssistantIdx] = {
      ...m,
      content: alreadyFolded(m.content)
        ? m.content.slice(0, keep)
        : compressLastAssistant(m.content.slice(0, keep)),
    };
  }
  return result;
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
