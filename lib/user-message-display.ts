/**
 * 使用者訊息在對話欄的顯示用解析：
 * - 附件全文仍存在 content（給模型／複製），畫面只秀檔名
 * - 過長本文預設收合，避免歷史捲軸被文字牆拖長
 */

export const ATTACHMENT_BLOCK_RE =
  /\n*--- \[附件檔案：([^\]]+)\] ---\n([\s\S]*?)\n--- \[附件結束\] ---/g;

const IMAGE_UPLOAD_PREFIX_RE = /^\[已上傳 \d+ 張圖片\]\n?/;

/** 超過此字數（或行數）→ 對話氣泡預設收合 */
export const USER_TEXT_COLLAPSE_CHARS = 480;
export const USER_TEXT_COLLAPSE_LINES = 8;
/** 收合時預覽長度 */
export const USER_TEXT_PREVIEW_CHARS = 280;
export const USER_TEXT_PREVIEW_LINES = 6;

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
  // 每次新建，避免全域 /g 的 lastIndex 殘留
  const blockRe = new RegExp(ATTACHMENT_BLOCK_RE.source, "g");
  const withoutAttachments = rest.replace(blockRe, (_, name: string, body: string) => {
    const text = String(body ?? "");
    attachments.push({
      name: String(name ?? "").trim() || "未命名附件",
      text,
      charCount: text.length,
    });
    return "";
  });

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
