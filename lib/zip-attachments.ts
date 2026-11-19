/**
 * 瀏覽器端解壓 ZIP，抽取文字／Office 內容，合成單一對話附件。
 * 防護：檔案數、壓縮前總量、路徑穿越、略過巢狀 zip／系統垃圾檔。
 */

import { unzipSync, strFromU8 } from "fflate";
import { extractOfficeAttachmentText, OFFICE_FILE_RE } from "./office-attachments";

/**
 * 壓縮檔大小上限：對齊 Gemini Apps ZIP 100MB（ChatGPT／Claude 單檔約 500–512MB，
 * 但瀏覽器端 fflate 全量解壓記憶體壓力大，採 100MB 較穩）。
 */
export const MAX_ZIP_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 100;
/** 解壓後總量上限（防 zip bomb；約為壓縮上限的 2 倍） */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const ZIP_FILE_RE = /\.zip$/i;

const ZIP_MIME = new Set(["application/zip", "application/x-zip-compressed", "multipart/x-zip"]);

/** 與對話欄文字附件對齊的可讀副檔名 */
export const ZIP_TEXT_FILE_RE =
  /\.(txt|csv|md|json|js|ts|tsx|jsx|py|html|htm|xml|log|css|sql|yaml|yml|toml|ini|cfg|env|sh|bash|zsh|rs|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|vue|svelte)$/i;

const SKIP_PATH_RE =
  /(^|\/)(__MACOSX|\.git|node_modules|\.svn|\.hg)(\/|$)/i;

export function isZipAttachment(file: File): boolean {
  if (ZIP_FILE_RE.test(file.name)) return true;
  if (file.type && ZIP_MIME.has(file.type)) return true;
  return false;
}

function truncateText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n...[檔案過長已截斷]`;
}

function normalizeZipPath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.endsWith("/")) return null;
  if (path.includes("..")) return null;
  if (SKIP_PATH_RE.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  if (!base || base.startsWith(".")) return null;
  return path;
}

function looksLikeBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 800);
  let weird = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) weird++;
  }
  return weird / n > 0.3;
}

function decodeTextBytes(bytes: Uint8Array): string {
  // 先 UTF-8；若大量替換字元再試 Big5（本機常見中文壓縮檔）
  const utf8 = strFromU8(bytes);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0 || bad / Math.max(utf8.length, 1) < 0.02) return utf8;
  try {
    return new TextDecoder("big5", { fatal: false }).decode(bytes);
  } catch {
    return utf8;
  }
}

export type ZipExtractResult = {
  text: string;
  fileCount: number;
  skipped: string[];
};

/**
 * 解壓 ZIP 並合併可讀內容。office 檔（pdf/docx/xlsx）會再走既有抽取。
 */
export async function extractZipAttachmentText(
  file: File,
  maxChars: number,
): Promise<ZipExtractResult> {
  if (file.size > MAX_ZIP_FILE_BYTES) {
    throw new Error(`「${file.name}」超過 ${Math.round(MAX_ZIP_FILE_BYTES / (1024 * 1024))}MB 上限`);
  }

  const data = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        if (file.originalSize > MAX_ZIP_UNCOMPRESSED_BYTES) return false;
        return true;
      },
    });
  } catch {
    throw new Error(`「${file.name}」不是有效的 ZIP，或已損壞`);
  }

  const names = Object.keys(entries).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  if (names.length === 0) {
    throw new Error(`「${file.name}」是空的壓縮檔`);
  }

  const parts: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  let fileCount = 0;
  let uncompressed = 0;

  for (const rawName of names) {
    if (fileCount >= MAX_ZIP_ENTRIES) {
      skipped.push(`…其餘略過（最多 ${MAX_ZIP_ENTRIES} 個檔）`);
      break;
    }
    const path = normalizeZipPath(rawName);
    if (!path) continue;

    const bytes = entries[rawName];
    if (!bytes) continue;
    uncompressed += bytes.byteLength;
    if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      skipped.push("…解壓總量超限，其餘略過");
      break;
    }

    const lower = path.toLowerCase();
    if (lower.endsWith(".zip")) {
      skipped.push(`${path}（巢狀 zip）`);
      continue;
    }

    let body = "";
    if (ZIP_TEXT_FILE_RE.test(path)) {
      if (looksLikeBinary(bytes)) {
        skipped.push(`${path}（二進位）`);
        continue;
      }
      body = decodeTextBytes(bytes).trim();
    } else if (OFFICE_FILE_RE.test(path)) {
      try {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const inner = new File([copy], path.split("/").pop() || path, {
          type: "application/octet-stream",
        });
        // 內層 office 各留一段額度，避免單一檔吃光
        const budget = Math.max(2_000, Math.floor((maxChars - used) / 2));
        body = await extractOfficeAttachmentText(inner, budget);
      } catch (e) {
        skipped.push(`${path}（${e instanceof Error ? e.message : "無法擷取"}）`);
        continue;
      }
    } else {
      skipped.push(path);
      continue;
    }

    if (!body) {
      skipped.push(`${path}（空白）`);
      continue;
    }

    const chunk = `### ${path}\n${body}`;
    if (used + chunk.length + 2 > maxChars) {
      const remain = maxChars - used - 20;
      if (remain > 80) {
        parts.push(truncateText(chunk, remain));
        used = maxChars;
      }
      skipped.push("…內容過長已截斷");
      break;
    }
    parts.push(chunk);
    used += chunk.length + 2;
    fileCount += 1;
  }

  const text = parts.join("\n\n").trim();
  if (!text) {
    const hint = skipped.length ? `；略過：${skipped.slice(0, 6).join("、")}` : "";
    throw new Error(`「${file.name}」內沒有可讀取的文字／Office 檔${hint}`);
  }

  return {
    text: truncateText(text, maxChars),
    fileCount,
    skipped: skipped.slice(0, 12),
  };
}
