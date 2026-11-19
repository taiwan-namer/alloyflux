/**
 * 超長文字／貼上 → 拆成多個 ≤ maxCharsPerPart 的附件片段。
 * 例如 34,733 字、每段 15,000 → 3 個檔。
 */

export const DEFAULT_MAX_CHARS_PER_PART = 15_000;

export type TextAttachmentPart = {
  name: string;
  text: string;
  size: number;
};

export type SplitTextAttachmentsResult = {
  parts: TextAttachmentPart[];
  originalLen: number;
  keptChars: number;
  truncated: boolean;
  /** 若不限 maxParts，理論上需要幾段 */
  totalPartsNeeded: number;
};

/** report.txt + (1,3) → report_1-3.txt；無副檔名則補 .txt */
export function partFileName(baseName: string, index: number, total: number): string {
  const raw = (baseName || "attachment").trim() || "attachment";
  const m = raw.match(/^(.*?)(\.[^.]+)?$/);
  const stem = (m?.[1] || raw).replace(/_+\d+-\d+$/, "") || "attachment";
  const ext = m?.[2] || ".txt";
  if (total <= 1) return `${stem}${ext}`;
  return `${stem}_${index + 1}-${total}${ext}`;
}

export function splitTextIntoAttachmentParts(input: {
  text: string;
  baseName: string;
  maxCharsPerPart?: number;
  maxParts: number;
}): SplitTextAttachmentsResult {
  const maxCharsPerPart = Math.max(1, input.maxCharsPerPart ?? DEFAULT_MAX_CHARS_PER_PART);
  const maxParts = Math.max(0, Math.floor(input.maxParts));
  const original = input.text ?? "";
  const originalLen = original.length;

  if (!originalLen || maxParts <= 0) {
    return { parts: [], originalLen, keptChars: 0, truncated: originalLen > 0, totalPartsNeeded: 0 };
  }

  const totalPartsNeeded = Math.ceil(originalLen / maxCharsPerPart);
  const partCount = Math.min(maxParts, totalPartsNeeded);
  const keptChars = Math.min(originalLen, partCount * maxCharsPerPart);
  const truncated = keptChars < originalLen;

  const parts: TextAttachmentPart[] = [];
  for (let i = 0; i < partCount; i++) {
    const start = i * maxCharsPerPart;
    const end = Math.min(originalLen, start + maxCharsPerPart);
    let chunk = original.slice(start, end);
    if (truncated && i === partCount - 1) {
      chunk = `${chunk}\n...[後續內容因附件數量上限已省略]`;
    }
    const name = partFileName(input.baseName, i, partCount);
    parts.push({
      name,
      text: chunk,
      size: new Blob([chunk], { type: "text/plain;charset=utf-8" }).size,
    });
  }

  return { parts, originalLen, keptChars, truncated, totalPartsNeeded };
}

export function splitTextAttachHint(result: SplitTextAttachmentsResult): string {
  const { parts, originalLen, keptChars, truncated, totalPartsNeeded } = result;
  if (parts.length === 0) return "文字過長但無法建立附件";
  if (parts.length === 1 && !truncated) {
    return `長文已轉成附件「${parts[0]!.name}」（${originalLen.toLocaleString("zh-TW")} 字）`;
  }
  if (parts.length === 1 && truncated) {
    return `長文已轉成附件「${parts[0]!.name}」（${originalLen.toLocaleString("zh-TW")} 字 → 保留前 ${keptChars.toLocaleString("zh-TW")} 字）`;
  }
  const names = parts.map((p) => p.name).join("、");
  if (truncated) {
    return `長文已拆成 ${parts.length} 個附件（需要 ${totalPartsNeeded} 個；${originalLen.toLocaleString("zh-TW")} 字 → 保留前 ${keptChars.toLocaleString("zh-TW")} 字）：${names}`;
  }
  return `長文已拆成 ${parts.length} 個附件（${originalLen.toLocaleString("zh-TW")} 字）：${names}`;
}
