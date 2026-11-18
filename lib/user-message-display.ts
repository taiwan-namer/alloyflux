/**
 * 使用者訊息在對話欄的顯示用解析：
 * - 附件全文仍存在 content（給模型／複製），畫面只秀檔名
 * - 過長本文預設收合，避免歷史捲軸被文字牆拖長
 */

/** 容許結尾前換行可有可無；全形／半形冒號都認 */
export const ATTACHMENT_BLOCK_RE =
  /\n*--- \[附件檔案[:：]([^\]]+)\] ---\r?\n([\s\S]*?)\r?\n?--- \[附件結束\] ---/g;

const IMAGE_UPLOAD_PREFIX_RE = /^\[已上傳 \d+ 張圖片\]\n?/;
const ATTACHMENT_START_RE = /--- \[附件檔案[:：]([^\]]+)\] ---/;
const ATTACHMENT_END_MARK = "--- [附件結束] ---";

/** 超過此字數（或行數）→ 對話氣泡預設收合 */
export const USER_TEXT_COLLAPSE_CHARS = 360;
export const USER_TEXT_COLLAPSE_LINES = 6;
/** 收合時預覽長度 */
export const USER_TEXT_PREVIEW_CHARS = 160;
export const USER_TEXT_PREVIEW_LINES = 4;

export type ParsedUserAttachment = {
  name: string;
  text: string;
  charCount: number;
};

export type ParsedUserMessage = {
  /** 例如「[已上傳 2 張圖片]」 */
  imageNote: string | null;
  /** 使用者輸入的對話文字（不含附件區塊） */
  text: string;
  attachments: ParsedUserAttachment[];
};

function pushAttachment(attachments: ParsedUserAttachment[], name: string, body: string) {
  const text = String(body ?? "");
  attachments.push({
    name: String(name ?? "").trim() || "未命名附件",
    text,
    charCount: text.length,
  });
}

/** 正則失敗時用掃行／標記位置再剝一次，避免附件正文漏網 */
function stripAttachmentsFallback(raw: string, attachments: ParsedUserAttachment[]): string {
  let rest = raw;
  // 若正文裡仍看得到標記，逐段切除
  while (true) {
    const start = rest.search(ATTACHMENT_START_RE);
    if (start < 0) break;
    const startMatch = rest.slice(start).match(ATTACHMENT_START_RE);
    if (!startMatch) break;
    const name = startMatch[1] ?? "";
    const afterHeader = start + startMatch[0].length;
    // 跳過 header 後的單一換行
    const bodyStart =
      rest[afterHeader] === "\n" ? afterHeader + 1 : afterHeader;
    const end = rest.indexOf(ATTACHMENT_END_MARK, bodyStart);
    if (end < 0) {
      // 有開頭無結尾：整段後面當附件，避免文字牆
      pushAttachment(attachments, name, rest.slice(bodyStart));
      rest = rest.slice(0, start);
      break;
    }
    pushAttachment(attachments, name, rest.slice(bodyStart, end).replace(/\n$/, ""));
    rest = `${rest.slice(0, start)}${rest.slice(end + ATTACHMENT_END_MARK.length)}`;
  }
  return rest;
}

export function parseUserMessageContent(raw: string): ParsedUserMessage {
  const source = (raw ?? "").replace(/\r\n/g, "\n");
  let rest = source;
  let imageNote: string | null = null;

  const img = rest.match(IMAGE_UPLOAD_PREFIX_RE);
  if (img) {
    imageNote = img[0].trim();
    rest = rest.slice(img[0].length);
  }

  const attachments: ParsedUserAttachment[] = [];
  const blockRe = new RegExp(ATTACHMENT_BLOCK_RE.source, "g");
  let withoutAttachments = rest.replace(blockRe, (_, name: string, body: string) => {
    pushAttachment(attachments, name, body);
    return "";
  });

  if (ATTACHMENT_START_RE.test(withoutAttachments) || withoutAttachments.includes(ATTACHMENT_END_MARK)) {
    withoutAttachments = stripAttachmentsFallback(withoutAttachments, attachments);
  }

  return {
    imageNote,
    text: withoutAttachments.replace(/^\n+/, "").replace(/\n+$/, "").trim(),
    attachments,
  };
}

export function shouldCollapseUserText(text: string): boolean {
  if (!text) return false;
  if (text.length > USER_TEXT_COLLAPSE_CHARS) return true;
  return text.split("\n").length > USER_TEXT_COLLAPSE_LINES;
}

/** 收合預覽：優先在換行處切斷，避免半行怪異截斷 */
export function previewUserText(text: string): string {
  const lines = text.split("\n");
  if (lines.length > USER_TEXT_PREVIEW_LINES) {
    return `${lines.slice(0, USER_TEXT_PREVIEW_LINES).join("\n").trimEnd()}…`;
  }
  if (text.length <= USER_TEXT_PREVIEW_CHARS) return text;

  const slice = text.slice(0, USER_TEXT_PREVIEW_CHARS);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(" "));
  const cut = lastBreak > USER_TEXT_PREVIEW_CHARS * 0.55 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}…`;
}
