/** 瀏覽器端抽取 PDF／Word／Excel 文字，供對話附件使用。 */

export const MAX_OFFICE_FILE_BYTES = 8 * 1024 * 1024;
export const OFFICE_FILE_RE = /\.(pdf|docx|xlsx|xls)$/i;

const OFFICE_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
]);

export function isOfficeAttachment(file: File): boolean {
  if (OFFICE_FILE_RE.test(file.name)) return true;
  if (file.type && OFFICE_MIME.has(file.type)) return true;
  return false;
}

function truncateText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n...[檔案過長已截斷]`;
}

async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
    return parts.join("\n");
  } finally {
    await doc.cleanup();
  }
}

async function extractDocxText(data: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return result.value ?? "";
}

async function extractSpreadsheetText(data: ArrayBuffer): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "array" });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (!csv) continue;
    parts.push(`### 工作表：${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

export async function extractOfficeAttachmentText(
  file: File,
  maxChars: number,
): Promise<string> {
  if (file.size > MAX_OFFICE_FILE_BYTES) {
    throw new Error(`「${file.name}」超過 ${Math.round(MAX_OFFICE_FILE_BYTES / (1024 * 1024))}MB 上限`);
  }

  const lower = file.name.toLowerCase();
  if (lower.endsWith(".doc") && !lower.endsWith(".docx")) {
    throw new Error(`「${file.name}」為舊版 Word（.doc），請另存為 .docx 後再上傳`);
  }

  const data = await file.arrayBuffer();
  let raw = "";

  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    raw = await extractPdfText(data);
  } else if (
    lower.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    raw = await extractDocxText(data);
  } else if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel"
  ) {
    raw = await extractSpreadsheetText(data);
  } else {
    throw new Error(`不支援的檔案類型：${file.name}`);
  }

  const text = truncateText(raw, maxChars);
  if (!text) {
    throw new Error(`「${file.name}」無法擷取文字（可能是掃描影像或空白檔）`);
  }
  return text;
}
