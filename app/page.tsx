"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { extractOfficeAttachmentText, isOfficeAttachment } from "@/lib/office-attachments";
import {
  DEFAULT_MAX_CHARS_PER_PART,
  splitTextAttachHint,
  splitTextIntoAttachmentParts,
} from "@/lib/split-text-attachments";
import { extractZipAttachmentText, isZipAttachment } from "@/lib/zip-attachments";
import {
  parseUserMessageContent,
  previewUserText,
  shouldCollapseUserText,
} from "@/lib/user-message-display";
import StrategyRoomView from "@/components/StrategyRoomView";
import {
  strategyStatusLabel,
  type PauseAction,
  type StrategyDispatchItem,
  type StrategyMemberConfig,
  type StrategySessionDetail,
  type StrategySyncResponse,
  type StrategyTemplateInfo,
  type StrategyWorkspaceBrief,
  type ViewMode,
} from "@/components/strategy-types";

type Effort = "low" | "medium" | "high";
type Brand = "gpt" | "claude" | "gemini" | "grok";

interface ModelOption {
  id: string;
  label: string;
  familyId: string;
  familyLabel: string;
  provider: string;
  category?: string;
  categoryLabel?: string;
  quotaPool?: string;
  tier?: "top" | "main" | "light";
  freeTier?: boolean;
  effort?: Effort | null;
  available: boolean;
  note?: string;
}

interface FreeQuota {
  used: number;
  limit: number;
  remaining: number;
  resetAtMs: number;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
}

/** 進入對話先顯示最近幾則，往上滑再載入更舊（降低長串 Markdown 卡頓） */
const INITIAL_MESSAGE_WINDOW = 5;
const OLDER_MESSAGE_PAGE = 10;

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  /** 模型內部思考過程（可摺疊顯示） */
  thinking?: string;
  model?: string | null;
  sourceLabel?: string;
  sourceKind?: "supplier" | "platform";
  upstreamModelId?: string;
  upstreamModelVersion?: string;
  viaDailyBypass?: boolean;
  groundingSources?: { title: string; uri: string }[];
  webSearchQueries?: string[];
  /** Research V2：complete｜truncated｜failed｜unknown */
  completionStatus?: "complete" | "truncated" | "failed" | "unknown";
  quotaLabel?: string;
  quotaUsedPct?: number;
  quotaBeforePct?: number;
  quotaAfterPct?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  officialCostPoints?: number | null;
  chargedPoints?: number | null;
  notices?: string[];
  error?: string;
  /** 由 ⚡ Auto 派發 */
  autoRouted?: boolean;
  autoLane?: "light" | "main";
  /** 實際思考檔（深度思考後可能是 medium） */
  effort?: Effort | null;
  deepThink?: boolean;
}

interface Wallet {
  balance: number;
  /** 高水位分母（最後一次儲值後峰值，保底 1000） */
  quotaCap: number;
  usage: { messages: number; chargedPoints: number; officialPoints: number };
  apiKey?: string;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  apiKey: string;
  role: "buyer" | "supplier";
  isAdmin: boolean;
  isSupplier: boolean;
  isBuyer: boolean;
}

interface ApiKeyRow {
  id: string;
  label: string;
  keyHint: string;
  createdAt: number;
}

const ATTACHED_WORKSPACE_KEY = "alloyflux.attachedWorkspace";

interface UserMemoryItem {
  id: string;
  fact: string;
  category: "fact" | "style";
  updatedAt: number;
}

/** 語氣快速範本：點選後寫入全局 style 記憶 */
const STYLE_QUICK_TEMPLATES: { label: string; text: string }[] = [
  { label: "⚡ 極簡重點（不講廢話）", text: "回答極簡重點，不講廢話，先給結論" },
  { label: "👨‍💻 資深工程師（先給 Code）", text: "用資深工程師口吻；先給程式碼，少解釋" },
  { label: "🔥 毒舌顧問（直接點出盲點）", text: "毒舌顧問口吻，直接點出盲點與風險，不要客套" },
  { label: "🧒 白話文（像對國中生解釋）", text: "用白話文、像對國中生解釋，避免術語堆疊" },
];

const fmt = (n: number | null | undefined, digits = 2) =>
  (n ?? 0).toLocaleString("zh-TW", { maximumFractionDigits: digits });

const QUOTA_FLOOR = 1000;

function normalizeQuotaCap(balance: number, quotaCap?: number | null): number {
  return Math.max(QUOTA_FLOOR, quotaCap ?? QUOTA_FLOOR, balance);
}

function quotaSegmentCount(cap: number): 1 | 2 | 3 {
  if (cap <= 1000) return 1;
  if (cap <= 2000) return 2;
  return 3;
}

function quotaTierLabel(cap: number): string {
  if (cap <= 1000) return "標準容量";
  if (cap <= 2000) return "進階雙倍池";
  return "PRO 旗艦池";
}

/** 各格容量：前幾格滿 1000，最後一格吃剩餘 */
function quotaSegmentSizes(cap: number): number[] {
  const n = quotaSegmentCount(cap);
  const sizes: number[] = [];
  let left = cap;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) sizes.push(left);
    else {
      const take = Math.min(1000, left);
      sizes.push(take);
      left -= take;
    }
  }
  return sizes;
}

function quotaSegmentFills(balance: number, cap: number): number[] {
  const sizes = quotaSegmentSizes(cap);
  let left = Math.max(0, balance);
  return sizes.map((size) => {
    if (size <= 0) return 0;
    const fill = Math.min(1, left / size);
    left = Math.max(0, left - size);
    return fill;
  });
}

const EFFORTS: Effort[] = ["low", "medium", "high"];

const AUTO_FAMILY_ID = "auto";
const AUTO_LABEL = "⚡ Auto（智慧最佳模型）";
/** 與 lib/auto-router.ts AUTO_LIGHT_MODEL_IDS 一致 */
const AUTO_LIGHT_MODEL_IDS = ["gemini-3.8-flash-low", "gemini-3.5-flash-lite"];

/** 載入歷史時：標記 Auto 派發，並從 model id 還原 effort／深度思考顯示 */
function markAutoRouted(list: Message[]): Message[] {
  return list.map((m, i) => {
    if (m.role !== "assistant") return m;
    const fromId = m.model ? splitModelId(m.model).effort : null;
    const effort = m.effort ?? fromId;
    const deepThink = m.deepThink || effort === "medium" || effort === "high";
    const prevUser = list[i - 1];
    const autoRouted =
      m.autoRouted || (prevUser?.role === "user" && prevUser.model === AUTO_FAMILY_ID);
    return {
      ...m,
      effort,
      deepThink: Boolean(deepThink),
      autoRouted: Boolean(autoRouted),
      autoLane:
        m.autoLane ??
        (autoRouted && m.model && AUTO_LIGHT_MODEL_IDS.includes(m.model) ? "light" : autoRouted ? "main" : undefined),
    };
  });
}

function splitModelId(id: string): { familyId: string; effort: Effort | null } {
  const m = id.match(/^(.*)-(low|medium|high)$/);
  if (m) return { familyId: m[1], effort: m[2] as Effort };
  return { familyId: id, effort: null };
}

/** 頁腳模型名：medium／深度思考時顯示「深度思考」，勿卡在占位的 Low */
function footerModelLabel(
  modelId: string | null | undefined,
  catalog: ModelOption[],
  opts?: { effort?: Effort | null; deepThink?: boolean; autoRouted?: boolean },
): string {
  const raw = catalog.find((x) => x.id === modelId)?.label ?? modelId ?? "助理";
  const fromId = modelId ? splitModelId(modelId).effort : null;
  const effort = opts?.effort ?? fromId;
  const deep = opts?.deepThink || effort === "medium" || effort === "high";
  if (!deep) return raw;
  const base = raw
    .replace(/\s*·\s*(Low|Medium|High)\s*/gi, "")
    .replace(/\s*\((?:low|medium|high)\)\s*/gi, "")
    .trim();
  if (opts?.autoRouted) return base;
  return `${base} · 深度思考`;
}

function brandFromModel(familyId: string, provider?: string, category?: string): Brand {
  const s = `${familyId} ${provider ?? ""} ${category ?? ""}`.toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (s.includes("grok") || s.includes("xai")) return "grok";
  if (
    s.includes("gpt") ||
    s.includes("openai") ||
    s.includes("chatgpt") ||
    /\bsol\b/.test(s) ||
    s.includes("luna") ||
    s.includes("terra") ||
    s.includes("astra")
  ) {
    return "gpt";
  }
  if (s.includes("gemini") || s.includes("argon") || s.includes("google") || s.includes("antigravity")) {
    return "gemini";
  }
  return "gemini";
}

const STREAM_STATUS: Record<Brand, { think: string; write: string }> = {
  claude: { think: "Extended thinking", write: "撰寫中" },
  gpt: { think: "Thinking...", write: "生成中" },
  gemini: { think: "推理中", write: "回應中" },
  grok: { think: "THINKING", write: "GENERATING" },
};

type BrandTypewriter = {
  push: (text: string) => void;
  drain: () => Promise<void>;
  flush: () => void;
  stop: () => void;
};

/**
 * 全品牌統一：零人為延遲 + 單幀合併 setState。
 */
function createBrandTypewriter(_brand: Brand, onChunk: (chunk: string) => void): BrandTypewriter {
  let pending = "";
  let raf = 0;
  let stopped = false;
  let waiting: Promise<void> | null = null;
  let resolveWait: (() => void) | null = null;

  function armWait() {
    if (!waiting) {
      waiting = new Promise((r) => {
        resolveWait = r;
      });
    }
  }
  function clearWait() {
    resolveWait?.();
    resolveWait = null;
    waiting = null;
  }

  function flushFrame() {
    raf = 0;
    if (stopped) {
      clearWait();
      return;
    }
    if (!pending) {
      clearWait();
      return;
    }
    const slice = pending;
    pending = "";
    onChunk(slice);
    if (pending) schedule();
    else clearWait();
  }

  function schedule() {
    if (stopped || raf) return;
    armWait();
    raf = requestAnimationFrame(flushFrame);
  }

  return {
    push(text) {
      if (stopped || !text) return;
      pending += text;
      schedule();
    },
    async drain() {
      if (stopped || (!pending && !raf)) return;
      armWait();
      await waiting;
    },
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pending) {
        const rest = pending;
        pending = "";
        onChunk(rest);
      }
      clearWait();
    },
    stop() {
      stopped = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      pending = "";
      clearWait();
    },
  };
}

function hostnameOfUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || raw;
  }
}

function cleanHref(raw: string): string {
  // 去掉句尾誤吃的標點；拒絕含省略號的截斷假網址
  const t = raw.replace(/[),.;:!?，。；：！？]+$/g, "").trim();
  if (!t || t.includes("…") || t.includes("...")) return "";
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

/** 內文來源：顯示短標籤／網域 chip，完整可點網址放 href（不得使用 … 截斷） */
function SourceChip({ href, label }: { href: string; label?: string }) {
  const url = cleanHref(href);
  if (!url) {
    const host = hostnameOfUrl(href);
    return (
      <span className="md-link-chip md-link-chip-dead" title={href || "unresolved"}>
        <span className="md-link-label">{(label?.trim() || host || "來源").slice(0, 42)}</span>
      </span>
    );
  }
  const host = hostnameOfUrl(url);
  const text = (label?.trim() || host).replace(/^https?:\/\//i, "");
  const display = text.length > 42 ? `${host}` : text;
  return (
    <a className="md-link-chip" href={url} target="_blank" rel="noreferrer" title={url}>
      <span className="md-link-icon" aria-hidden>
        ↗
      </span>
      <span className="md-link-label">{display}</span>
    </a>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 順序：<br> 換行 → 粗斜體 → 粗體 → 斜體 → 行內碼 → Markdown 連結 → 裸 URL
  const re =
    /(<br\s*\/?>|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>\[\]（）]+)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (/^<br\s*\/?>$/i.test(token)) {
      nodes.push(<br key={`br${key++}`} />);
    } else if (token.startsWith("***") && token.endsWith("***")) {
      nodes.push(
        <strong key={`bi${key++}`}>
          <em>{token.slice(3, -3)}</em>
        </strong>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={`i${key++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`c${key++}`} className="inline">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (lm) {
        nodes.push(<SourceChip key={`l${key++}`} label={lm[1]} href={lm[2]} />);
      } else {
        nodes.push(token);
      }
    } else if (/^https?:\/\//i.test(token)) {
      nodes.push(<SourceChip key={`u${key++}`} href={token} />);
    } else {
      nodes.push(token);
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isTableSeparator(line: string) {
  return /^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function ThinkingIndicator() {
  return (
    <div className="thinking" aria-live="polite" aria-label="AI 回應中">
      <span className="thinking-label">回應中</span>
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

type MdBlock =
  | { type: "code"; lang: string; body: string; open?: boolean }
  | { type: "math"; body: string; open?: boolean }
  | { type: "text"; body: string };

/** 串流穩定切塊：未閉合的 ``` / $$ 先淡色預覽，完整才高亮，避免版面跳動 */
function splitMarkdownBlocks(content: string, streaming: boolean): MdBlock[] {
  const parts: MdBlock[] = [];
  let i = 0;
  while (i < content.length) {
    const fence = content.indexOf("```", i);
    const math = content.indexOf("$$", i);
    let next = -1;
    let kind: "code" | "math" | null = null;
    if (fence >= 0 && (math < 0 || fence <= math)) {
      next = fence;
      kind = "code";
    } else if (math >= 0) {
      next = math;
      kind = "math";
    }
    if (next < 0 || !kind) {
      parts.push({ type: "text", body: content.slice(i) });
      break;
    }
    if (next > i) parts.push({ type: "text", body: content.slice(i, next) });

    if (kind === "code") {
      const after = next + 3;
      const nl = content.indexOf("\n", after);
      const lang = content.slice(after, nl < 0 ? content.length : nl).trim();
      const bodyStart = nl < 0 ? content.length : nl + 1;
      const close = content.indexOf("```", bodyStart);
      if (close < 0) {
        parts.push({ type: "code", lang, body: content.slice(bodyStart), open: streaming || undefined });
        break;
      }
      parts.push({ type: "code", lang, body: content.slice(bodyStart, close).replace(/\n$/, "") });
      i = close + 3;
      if (content[i] === "\n") i += 1;
      continue;
    }

    const bodyStart = next + 2;
    const close = content.indexOf("$$", bodyStart);
    if (close < 0) {
      parts.push({ type: "math", body: content.slice(bodyStart), open: streaming || undefined });
      break;
    }
    parts.push({ type: "math", body: content.slice(bodyStart, close).replace(/^\n|\n$/g, "") });
    i = close + 2;
    if (content[i] === "\n") i += 1;
  }
  if (parts.length === 0) parts.push({ type: "text", body: content });
  return parts;
}

/**
 * 串流時：只對「已換行的完整行」做標題／清單／表格格式化；
 * 最後一行未完成前以純文字浮現，避免版面劇烈閃爍。
 */
function splitStableText(body: string, streaming: boolean): { stable: string; tail: string } {
  if (!streaming) return { stable: body, tail: "" };
  const lastNl = body.lastIndexOf("\n");
  if (lastNl < 0) return { stable: "", tail: body };
  let stable = body.slice(0, lastNl + 1);
  let tail = body.slice(lastNl + 1);

  const core = stable.length ? stable.slice(0, -1).split("\n") : [];
  if (!core.length) return { stable: "", tail };

  // 尾端連續 | 行若還沒出現 separator，整段先當純文字，等語法完整再表格化
  let from = core.length;
  while (from > 0 && core[from - 1].includes("|")) from -= 1;
  if (from < core.length) {
    const tableChunk = core.slice(from);
    if (!tableChunk.some(isTableSeparator)) {
      stable = core.slice(0, from).join("\n");
      if (stable) stable += "\n";
      tail = `${tableChunk.join("\n")}\n${tail}`;
    }
  }

  return { stable, tail };
}

function LightMarkdown({
  content,
  thinking,
  streaming,
}: {
  content: string;
  thinking?: boolean;
  streaming?: boolean;
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  /** undefined = 串流結束後預設預覽；false = 使用者切回原始碼 */
  const [previewOn, setPreviewOn] = useState<Record<number, boolean | undefined>>({});
  const [previewTall, setPreviewTall] = useState<Record<number, boolean>>({});

  const blocks = useMemo(() => splitMarkdownBlocks(content, Boolean(streaming)), [content, streaming]);

  async function copyCode(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      // ignore
    }
  }

  function renderTextBlock(body: string, keyBase: number) {
    const { stable, tail } = splitStableText(body, Boolean(streaming));
    const lines = stable.length ? stable.split("\n") : [];
    // split 會在結尾 \n 產生空字串；保留邏輯與先前一致
    const out: ReactNode[] = [];
    let listItems: { ordered: boolean; text: string }[] = [];
    let listOrdered = false;
    let para: string[] = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(<p key={`p${keyBase}-${out.length}`}>{renderInline(para.join("\n"))}</p>);
      para = [];
    };
    const flushList = () => {
      if (!listItems.length) return;
      const Tag = listOrdered ? "ol" : "ul";
      out.push(
        <Tag key={`l${keyBase}-${out.length}`}>
          {listItems.map((item, i) => (
            <li key={i}>{renderInline(item.text)}</li>
          ))}
        </Tag>,
      );
      listItems = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 因 stable 以 \n 結尾，最後一個空行代表段落結束，交給 trim === "" 處理
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      const bullet = /^[-*]\s+(.+)$/.exec(line);
      const numbered = /^(\d+)\.\s+(.+)$/.exec(line);
      const hr = /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
      const tableStart =
        line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);

      if (tableStart) {
        flushList();
        flushPara();
        const header = parseTableRow(line);
        i += 1; // skip separator
        const rows: string[][] = [];
        while (i + 1 < lines.length && lines[i + 1].includes("|") && !isTableSeparator(lines[i + 1])) {
          i += 1;
          rows.push(parseTableRow(lines[i]));
        }
        // 串流中：若表格列可能還在繼續，且下一 peek 在 tail，先輸出已有列；新列進 tail 即可
        out.push(
          <div className="md-table-wrap" key={`t${keyBase}-${out.length}`}>
            <table>
              <thead>
                <tr>
                  {header.map((h, hi) => (
                    <th key={hi}>{renderInline(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {header.map((_, ci) => (
                      <td key={ci}>{renderInline(row[ci] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      } else if (heading) {
        flushList();
        flushPara();
        const level = heading[1].length;
        const Tag = `h${level}` as "h1" | "h2" | "h3";
        out.push(<Tag key={`h${keyBase}-${out.length}`}>{renderInline(heading[2])}</Tag>);
      } else if (hr) {
        flushList();
        flushPara();
        out.push(<hr key={`hr${keyBase}-${out.length}`} />);
      } else if (bullet) {
        flushPara();
        if (listItems.length && listOrdered) flushList();
        listOrdered = false;
        listItems.push({ ordered: false, text: bullet[1] });
      } else if (numbered) {
        flushPara();
        if (listItems.length && !listOrdered) flushList();
        listOrdered = true;
        listItems.push({ ordered: true, text: numbered[2] });
      } else if (line.trim() === "") {
        flushList();
        flushPara();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushList();
    flushPara();
    if (tail) {
      out.push(
        <p key={`tail${keyBase}`} className="md-stream-tail">
          {tail}
        </p>,
      );
    }
    return out;
  }

  if (!content) {
    return thinking ? <ThinkingIndicator /> : null;
  }

  return (
    <div className={`md${streaming ? " is-streaming-md" : ""}`}>
      {blocks.map((b, i) => {
        if (b.type === "code") {
          const meta = parseCodeFenceMeta(b.lang || "");
          const previewable = isHtmlPreviewable(meta);
          const inPreview = previewable && !b.open && previewOn[i] !== false;
          const tall = Boolean(previewTall[i]);
          return (
            <div
              className={`md-code${meta.downloadable ? " is-file" : ""}${previewable ? " is-previewable" : ""}${b.open ? " is-open" : ""}${inPreview ? " is-previewing" : ""}`}
              key={i}
            >
              <div className="md-code-head">
                <span>
                  {previewable
                    ? `🌐 ${meta.label || "preview.html"}`
                    : meta.downloadable
                      ? `📦 ${meta.label}`
                      : meta.label || (b.open ? "code…" : "code")}
                </span>
                {!b.open && (
                  <div className="md-code-actions">
                    {previewable && (
                      <>
                        <button
                          type="button"
                          className={inPreview ? "is-active" : ""}
                          onClick={() => setPreviewOn((prev) => ({ ...prev, [i]: true }))}
                        >
                          ▶️ 預覽互動
                        </button>
                        <button
                          type="button"
                          className={!inPreview ? "is-active" : ""}
                          onClick={() => setPreviewOn((prev) => ({ ...prev, [i]: false }))}
                        >
                          💻 原始碼
                        </button>
                        {inPreview && (
                          <button
                            type="button"
                            onClick={() => setPreviewTall((prev) => ({ ...prev, [i]: !prev[i] }))}
                          >
                            {tall ? "⤓ 標準高度" : "⤢ 加高預覽"}
                          </button>
                        )}
                      </>
                    )}
                    <button type="button" onClick={() => void copyCode(i, b.body)}>
                      {copiedIdx === i ? "已複製 ✓" : "📋 複製內容"}
                    </button>
                    {meta.downloadable && meta.filename && (
                      <button type="button" onClick={() => downloadTextFile(meta.filename!, b.body)}>
                        ⬇️ 下載檔案
                      </button>
                    )}
                  </div>
                )}
              </div>
              {inPreview ? (
                <div className={`md-preview-frame${tall ? " is-tall" : ""}`}>
                  <iframe
                    title={`preview-${meta.label || i}`}
                    srcDoc={b.body}
                    sandbox="allow-scripts allow-modals"
                    className="md-preview-iframe"
                  />
                </div>
              ) : (
                <pre>
                  <code>{b.body}</code>
                </pre>
              )}
            </div>
          );
        }
        if (b.type === "math") {
          return (
            <pre key={i} className={`md-math${b.open ? " is-open" : ""}`}>
              <code>{b.open ? `$$${b.body}` : b.body}</code>
            </pre>
          );
        }
        return <Fragment key={i}>{renderTextBlock(b.body, i)}</Fragment>;
      })}
    </div>
  );
}

function CopyReplyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // ignore
        }
      }}
    >
      {done ? "已複製 ✓" : "📋 複製回覆"}
    </button>
  );
}

/** 使用者提問旁的圖示複製鈕（如 ChatGPT 氣泡下方） */
function CopyIconButton({ text, label = "複製" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msg-icon-btn"
      title={done ? "已複製" : label}
      aria-label={done ? "已複製" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // ignore
        }
      }}
    >
      {done ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}

/** 使用者氣泡：附件只顯示檔名；過長本文預設收合（收合時不把全文掛進 DOM） */
function UserMessageBubble({ content }: { content: string }) {
  const parsed = useMemo(() => parseUserMessageContent(content), [content]);
  const collapse = shouldCollapseUserText(parsed.text);
  const [expanded, setExpanded] = useState(false);
  const preview = collapse ? previewUserText(parsed.text) : parsed.text;

  useEffect(() => {
    setExpanded(false);
  }, [content]);

  return (
    <div className="user-msg-body">
      {parsed.imageNote ? <div className="user-msg-note">{parsed.imageNote}</div> : null}
      {parsed.attachments.length > 0 ? (
        <div className="user-msg-attachments" aria-label="附件">
          {parsed.attachments.map((a, i) => (
            <span className="user-msg-file-chip" key={`${a.name}-${i}`} title={a.name}>
              <span className="user-msg-file-icon" aria-hidden>
                📄
              </span>
              <span className="user-msg-file-name">{a.name}</span>
              {a.charCount > 0 ? (
                <span className="user-msg-file-meta">{formatCharCount(a.charCount)} 字</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {parsed.text ? (
        collapse ? (
          <div className="user-msg-collapse">
            <div className="user-msg-text">{expanded ? parsed.text : preview}</div>
            <button
              type="button"
              className="ghost user-msg-collapse-btn"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收合" : `展開全文（${formatCharCount(parsed.text.length)} 字）`}
            </button>
          </div>
        ) : (
          <div className="user-msg-text">{parsed.text}</div>
        )
      ) : null}
      {!parsed.text && parsed.attachments.length === 0 && !parsed.imageNote ? content : null}
    </div>
  );
}

const DOWNLOADABLE_EXTS = new Set([
  "csv",
  "html",
  "htm",
  "json",
  "md",
  "txt",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "xml",
  "css",
  "sql",
  "log",
  "yaml",
  "yml",
]);

function parseCodeFenceMeta(langRaw: string): {
  label: string;
  filename: string | null;
  language: string;
  downloadable: boolean;
} {
  const raw = langRaw.trim();
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const language = raw.slice(0, colon).trim() || "txt";
    const filename = raw.slice(colon + 1).trim();
    return {
      label: filename || language,
      filename: filename || `download.${language}`,
      language,
      downloadable: true,
    };
  }
  const lower = raw.toLowerCase();
  if (DOWNLOADABLE_EXTS.has(lower)) {
    return { label: raw || "code", filename: `download.${lower}`, language: raw, downloadable: true };
  }
  return { label: raw || "code", filename: null, language: raw, downloadable: false };
}

function isHtmlPreviewable(meta: { language: string; filename: string | null }): boolean {
  const lang = meta.language.toLowerCase();
  const name = (meta.filename || "").toLowerCase();
  return (
    lang === "html" ||
    lang === "htm" ||
    lang === "svg" ||
    name.endsWith(".html") ||
    name.endsWith(".htm") ||
    name.endsWith(".svg")
  );
}

function downloadTextFile(filename: string, body: string) {
  const isCsv = /\.csv$/i.test(filename);
  const text = isCsv ? `\uFEFF${body}` : body;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type PendingImage = { id: string; mimeType: string; data: string; previewUrl: string };
type PendingFile = { id: string; name: string; size: number; text: string };

const MAX_PENDING_IMAGES = 3;
/** 附件不設數量上限；拆段時用此值作為 maxParts 上界（實務上等同無限制） */
const UNLIMITED_FILE_PARTS = Number.MAX_SAFE_INTEGER;
/** 文字檔上傳位元組上限（超長會再拆成多個 ≤15,000 字附件） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 單個文字附件淨化後上限 */
const MAX_FILE_CHARS = DEFAULT_MAX_CHARS_PER_PART;
/** 貼上／輸入超過此字數 → 自動收成 TXT 附件（避免對話欄／氣泡變文字牆） */
const LONG_PASTE_TO_FILE_CHARS = 1_500;
const TEXT_FILE_RE =
  /\.(txt|csv|md|json|jsonl|js|ts|tsx|jsx|py|html|htm|xml|log|css|sql|yaml|yml)$/i;
/** 純圖片：Android 才會走相簿／相機，勿與文件副檔名混在同一個 accept */
const IMAGE_ACCEPT = "image/*";
const DOC_ACCEPT =
  ".txt,.csv,.md,.json,.jsonl,.js,.ts,.tsx,.jsx,.py,.html,.htm,.xml,.log,.css,.sql,.yaml,.yml,.pdf,.docx,.xlsx,.xls,.zip";

function formatCharCount(n: number): string {
  return n.toLocaleString("zh-TW");
}

function pasteBaseFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `貼上文字_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

function pendingFilesFromLongText(raw: string, maxParts: number, baseName?: string): {
  files: PendingFile[];
  hint: string;
} {
  const result = splitTextIntoAttachmentParts({
    text: raw,
    baseName: baseName || pasteBaseFileName(),
    maxCharsPerPart: MAX_FILE_CHARS,
    maxParts,
  });
  const files: PendingFile[] = result.parts.map((p) => ({
    id: crypto.randomUUID(),
    name: p.name,
    size: p.size,
    text: p.text,
  }));
  return { files, hint: splitTextAttachHint(result) };
}

function pendingFilesFromRawText(raw: string, baseName: string, maxParts: number): PendingFile[] {
  return pendingFilesFromLongText(raw, maxParts, baseName).files;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function compressImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取圖片失敗"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("圖片損壞"));
      img.onload = () => {
        const max = 1280;
        let { width, height } = img;
        if (width > max || height > max) {
          const scale = Math.min(max / width, max / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("無法壓縮圖片"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        const comma = dataUrl.indexOf(",");
        const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        resolve({
          id: crypto.randomUUID(),
          mimeType: "image/jpeg",
          data,
          previewUrl: dataUrl,
        });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function readTextAttachment(file: File, maxParts: number): Promise<PendingFile[]> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`「${file.name}」超過 ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB 上限`);
  }
  const text = await file.text();
  return pendingFilesFromRawText(text, file.name, maxParts);
}

async function readOfficeAttachment(file: File, maxParts: number): Promise<PendingFile[]> {
  const budget = Math.max(MAX_FILE_CHARS, maxParts * MAX_FILE_CHARS);
  const text = await extractOfficeAttachmentText(file, budget);
  return pendingFilesFromRawText(text, file.name, maxParts);
}

async function readZipAttachment(file: File, maxParts: number): Promise<PendingFile[]> {
  const budget = Math.max(MAX_FILE_CHARS, maxParts * MAX_FILE_CHARS);
  const { text, fileCount, skipped } = await extractZipAttachmentText(file, budget);
  const note =
    skipped.length > 0
      ? `\n\n（已讀 ${fileCount} 個檔；略過：${skipped.slice(0, 8).join("、")}）`
      : `\n\n（已讀 ${fileCount} 個檔）`;
  return pendingFilesFromRawText(`${text}${note}`, file.name, maxParts);
}

export default function ChatPage() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [familyId, setFamilyId] = useState(AUTO_FAMILY_ID);
  /** 僅手動選 top 模型時可開；預設關閉 */
  const [deepThink, setDeepThink] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [listening, setListening] = useState(false);
  const [composerHint, setComposerHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [hasPaidAccess, setHasPaidAccess] = useState(false);
  const [freeQuota, setFreeQuota] = useState<FreeQuota>({
    used: 0,
    limit: 20,
    remaining: 20,
    resetAtMs: 0,
  });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authRole, setAuthRole] = useState<"buyer" | "supplier">("buyer");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemMsg, setRedeemMsg] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);
  const [apiKeysBusy, setApiKeysBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<UserMemoryItem[]>([]);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryCategory, setMemoryCategory] = useState<"style" | "fact">("style");
  const [memoryMsg, setMemoryMsg] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [convMenuId, setConvMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashedConversations, setTrashedConversations] = useState<Conversation[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);
  const [strategyWorkspaces, setStrategyWorkspaces] = useState<StrategyWorkspaceBrief[]>([]);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newRoomWsId, setNewRoomWsId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomTopic, setNewRoomTopic] = useState("");
  const [newRoomTemplateId, setNewRoomTemplateId] = useState("automax");
  const [strategyTemplates, setStrategyTemplates] = useState<StrategyTemplateInfo[]>([]);
  const [strategyDefault3Ai, setStrategyDefault3Ai] = useState<StrategyMemberConfig[]>([]);
  const [strategyCreating, setStrategyCreating] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const [canSplit, setCanSplit] = useState(false);
  const [strategyBusy, setStrategyBusy] = useState(false);
  const [strategyDetail, setStrategyDetail] = useState<StrategySessionDetail | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [strategyDraft, setStrategyDraft] = useState("");
  const [strategySending, setStrategySending] = useState(false);
  const [dispatchSelected, setDispatchSelected] = useState<Set<string>>(() => new Set());
  const [wsMemoryDraft, setWsMemoryDraft] = useState("");
  const [wsMemoryDirty, setWsMemoryDirty] = useState(false);
  const [wsMemorySaving, setWsMemorySaving] = useState(false);
  const [attachedWorkspaceId, setAttachedWorkspaceId] = useState<string>("");
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  const [mintMsg, setMintMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void; abort?: () => void } | null>(null);
  /** Windows 注音等 IME：compositionend 後同一下 Enter 常會再觸發送出 */
  const imeComposingRef = useRef(false);
  const imeJustEndedRef = useRef(false);
  const imeJustEndedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 僅在使用者本來就在底部附近時，才跟隨 AI 串流往下捲；往上閱讀時不強迫跟隨 */
  const stickToBottomRef = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }

  function updateStickFromScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = dist < 96;
    stickToBottomRef.current = nearBottom;
    setShowJumpLatest(!nearBottom && messages.length > 0);
    // 靠近頂部：載入更舊紀錄
    if (el.scrollTop < 72) {
      void loadOlderMessages();
    }
  }

  const loadOlderMessages = useCallback(async () => {
    if (!activeId || !hasOlderMessages || loadingOlder || busy) return;
    const oldest = messages[0];
    if (!oldest?.createdAt || !oldest.id) return;
    const el = messagesRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingOlder(true);
    try {
      const qs = new URLSearchParams({
        limit: String(OLDER_MESSAGE_PAGE),
        beforeCreatedAt: String(oldest.createdAt),
        beforeId: oldest.id,
      });
      const res = await fetch(`/api/conversations/${activeId}?${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      const older = markAutoRouted((data.messages as Message[]) ?? []);
      setHasOlderMessages(Boolean(data.hasMore));
      if (!older.length) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...older.filter((m) => !seen.has(m.id)), ...prev];
        return merged;
      });
      requestAnimationFrame(() => {
        const box = messagesRef.current;
        if (!box) return;
        box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [activeId, hasOlderMessages, loadingOlder, busy, messages]);

  const refreshConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (!res.ok) {
      setConversations([]);
      return;
    }
    setConversations(await res.json());
  }, []);
  const refreshTrashed = useCallback(async () => {
    const res = await fetch("/api/conversations?trash=1");
    if (!res.ok) {
      setTrashedConversations([]);
      return;
    }
    setTrashedConversations(await res.json());
  }, []);
  const refreshStrategySessions = useCallback(async () => {
    if (!authUser) {
      setStrategyWorkspaces([]);
      return;
    }
    const res = await fetch("/api/strategy/workspaces", { cache: "no-store" });
    if (!res.ok) {
      setStrategyWorkspaces([]);
      return;
    }
    const data = (await res.json()) as { workspaces?: StrategyWorkspaceBrief[] };
    setStrategyWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
  }, [authUser]);

  useEffect(() => {
    try {
      setAttachedWorkspaceId(localStorage.getItem(ATTACHED_WORKSPACE_KEY) || "");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!attachedWorkspaceId || !strategyWorkspaces.length) return;
    if (!strategyWorkspaces.some((w) => w.id === attachedWorkspaceId)) setAttachedWorkspaceId("");
  }, [attachedWorkspaceId, strategyWorkspaces]);

  function changeAttachedWorkspace(id: string) {
    setAttachedWorkspaceId(id);
    try {
      if (id) localStorage.setItem(ATTACHED_WORKSPACE_KEY, id);
      else localStorage.removeItem(ATTACHED_WORKSPACE_KEY);
    } catch {
      /* ignore */
    }
  }
  const refreshWallet = useCallback(async () => {
    const res = await fetch("/api/wallet", { cache: "no-store" });
    if (!res.ok) {
      setWallet(null);
      return;
    }
    const data = (await res.json()) as Wallet & { hasPaidAccess?: boolean; freeQuota?: FreeQuota };
    const next: Wallet = {
      ...data,
      balance: data.balance ?? 0,
      quotaCap: normalizeQuotaCap(data.balance ?? 0, data.quotaCap),
      usage: data.usage ?? { messages: 0, chargedPoints: 0, officialPoints: 0 },
    };
    setWallet(next);
    if (typeof data.hasPaidAccess === "boolean") setHasPaidAccess(data.hasPaidAccess);
    if (data.freeQuota) setFreeQuota(data.freeQuota);
    return next;
  }, []);
  const refreshModels = useCallback(async () => {
    const list = (await (await fetch("/api/models", { cache: "no-store" })).json()) as ModelOption[];
    setModels(list);
    setFamilyId((cur) => {
      if (cur === AUTO_FAMILY_ID) return cur;
      const families = [...new Set(list.map((m) => m.familyId))];
      if (families.includes(cur) && list.some((m) => m.familyId === cur && m.available)) return cur;
      const first = list.find((m) => m.available);
      return first?.familyId ?? cur;
    });
  }, []);

  const refreshStrategyTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/strategy/templates", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        templates?: StrategyTemplateInfo[];
        default3AiPreset?: StrategyMemberConfig[];
      };
      if (Array.isArray(data.templates)) setStrategyTemplates(data.templates);
      if (Array.isArray(data.default3AiPreset)) setStrategyDefault3Ai(data.default3AiPreset);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshMe = useCallback(async () => {
    setAuthLoading(true);
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), 8_000);
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store", signal: ac.signal });
      const data = await res.json().catch(() => ({}));
      setGoogleEnabled(Boolean(data.googleEnabled));
      if (data.freeQuota) setFreeQuota(data.freeQuota);
      if (data.user) {
        setAuthUser(data.user);
        const bal = data.balance ?? 0;
        setHasPaidAccess(Boolean(data.hasPaidAccess ?? (data.user.isAdmin || bal > 0)));
        setWallet({
          balance: bal,
          quotaCap: normalizeQuotaCap(bal, data.quotaCap),
          usage: data.usage ?? { messages: 0, chargedPoints: 0, officialPoints: 0 },
          apiKey: data.user.apiKey,
        });
      } else {
        setAuthUser(null);
        setHasPaidAccess(false);
        setWallet(null);
      }
    } catch {
      // 網路／API 逾時：仍解除載入，讓訪客可進聊天室
      setAuthUser(null);
      setHasPaidAccess(false);
      setWallet(null);
    } finally {
      clearTimeout(kill);
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
    void refreshModels();
  }, [refreshMe, refreshModels]);

  useEffect(() => {
    if (authUser) void refreshStrategyTemplates();
  }, [authUser, refreshStrategyTemplates]);

  useEffect(() => {
    if (authLoading) return;
    void refreshConversations();
    if (authUser) void refreshWallet();
    void refreshStrategySessions();
  }, [authLoading, authUser, refreshConversations, refreshWallet, refreshStrategySessions]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // 串流中用 auto，避免每幾個字 smooth 捲動搶視線
    scrollToBottom(busy ? "auto" : "smooth");
  }, [messages, busy]);

  useEffect(() => {
    if (!trashOpen) return;
    void refreshTrashed();
  }, [trashOpen, refreshTrashed]);

  useEffect(() => {
    if (!convMenuId) return;
    const close = () => setConvMenuId(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConvMenuId(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [convMenuId]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const familyOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        familyId: string;
        familyLabel: string;
        categoryLabel: string;
        category?: string;
        provider?: string;
        quotaPool?: string;
        tier?: ModelOption["tier"];
        freeTier: boolean;
        available: boolean;
        note?: string;
        efforts: Effort[];
        sort: number;
      }
    >();
    const anyUpstreamReady = models.some((m) => m.category !== "node-agent" && m.available);
    for (const m of models) {
      if (m.category === "node-agent") continue;
      // 若全站已有可用貨源，隱藏目錄未開的模型；若全站尚無貨源，保留顯示讓介面完整可見
      if (anyUpstreamReady && !m.available) continue;
      const prev = map.get(m.familyId);
      const efforts = new Set(prev?.efforts ?? []);
      if (m.effort) efforts.add(m.effort);
      const sort =
        m.familyId.includes("3.5-flash-lite")
          ? 10
          : m.familyId.includes("3.8-flash")
            ? 20
            : m.familyId.includes("3.1-pro")
              ? 30
              : m.familyId.includes("argon")
                ? 40
                : m.category === "antigravity-claude"
                  ? 50
                  : m.category === "antigravity-gpt"
                    ? 60
                    : m.category === "chatgpt"
                      ? m.familyId.includes("astra")
                        ? 70
                        : m.familyId.includes("6.1-sol")
                          ? 71
                          : m.familyId.includes("6.1-terra")
                            ? 72
                            : m.familyId === "gpt-6-sol"
                              ? 73
                              : m.familyId.includes("6-luna")
                                ? 74
                                : m.familyId.includes("5.6")
                                  ? 80
                                  : 85
                      : m.category === "grok"
                        ? m.familyId.includes("4.7") && !m.familyId.includes("fast")
                          ? 90
                          : m.familyId.includes("build-fast")
                            ? 91
                            : m.familyId.includes("4.6")
                              ? 92
                              : 93
                        : 100;
      map.set(m.familyId, {
        familyId: m.familyId,
        familyLabel: m.familyLabel || m.label,
        categoryLabel: m.categoryLabel ?? m.category ?? m.provider,
        category: m.category,
        provider: m.provider,
        quotaPool: m.quotaPool,
        tier: prev?.tier ?? m.tier,
        freeTier: Boolean(prev?.freeTier || (m.freeTier && (!m.effort || m.effort === "low" || m.effort === "medium"))),
        available: (prev?.available ?? false) || m.available,
        note: m.available ? prev?.note : m.note ?? prev?.note,
        efforts: [...efforts].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b)),
        sort: prev?.sort ?? sort,
      });
    }
    return [...map.values()].sort((a, b) => a.sort - b.sort || a.familyLabel.localeCompare(b.familyLabel));
  }, [models]);

  const isAuto = familyId === AUTO_FAMILY_ID;
  const anyAvailable = models.some((m) => m.category !== "node-agent" && m.available);
  const currentFamily = isAuto ? undefined : familyOptions.find((f) => f.familyId === familyId);
  const currentLocked = Boolean(!isAuto && currentFamily && !hasPaidAccess && !currentFamily.freeTier);
  // 網頁版一律送 low 變體；深度思考由 deepThink 旗標交給後端換 medium
  const baseEffort: Effort | null = currentFamily?.efforts.length
    ? currentFamily.efforts.includes("low")
      ? "low"
      : currentFamily.efforts[0]
    : null;

  const modelId = isAuto ? AUTO_FAMILY_ID : baseEffort ? `${familyId}-${baseEffort}` : familyId;
  const currentModel: ModelOption | undefined = isAuto
    ? {
        id: AUTO_FAMILY_ID,
        label: AUTO_LABEL,
        familyId: AUTO_FAMILY_ID,
        familyLabel: AUTO_LABEL,
        provider: "auto",
        available: anyAvailable,
      }
    : (models.find((m) => m.id === modelId) ?? models.find((m) => m.familyId === familyId));
  const brand = brandFromModel(familyId, currentModel?.provider ?? currentFamily?.provider, currentFamily?.category);
  const showDeepThink = !isAuto && hasPaidAccess && currentFamily?.tier === "top";

  useEffect(() => {
    setDeepThink(false);
  }, [familyId]);

  // 選到的模型已從選單拿掉（目錄未開／無貨源）→ 退回 Auto
  useEffect(() => {
    if (familyId === AUTO_FAMILY_ID) return;
    if (!familyOptions.some((f) => f.familyId === familyId)) setFamilyId(AUTO_FAMILY_ID);
  }, [familyId, familyOptions]);

  function applyModelSelection(fullId: string) {
    setFamilyId(splitModelId(fullId).familyId);
  }

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const coarse = window.matchMedia("(hover: none), (pointer: coarse)");
    const sync = () => {
      const next = wide.matches && !coarse.matches;
      setCanSplit(next);
      if (!next) {
        setViewMode((m) => (m === "split" ? "strategy" : m));
      }
    };
    sync();
    wide.addEventListener("change", sync);
    coarse.addEventListener("change", sync);
    return () => {
      wide.removeEventListener("change", sync);
      coarse.removeEventListener("change", sync);
    };
  }, []);

  async function openConversation(id: string) {
    setActiveId(id);
    setViewMode((m) => (m === "split" && canSplit ? "split" : "chat"));
    setSidebarOpen(false);
    stickToBottomRef.current = true;
    setShowJumpLatest(false);
    setHasOlderMessages(false);
    setLoadingOlder(false);
    const res = await fetch(`/api/conversations/${id}?limit=${INITIAL_MESSAGE_WINDOW}`);
    if (!res.ok) {
      // 常見於：電腦斷線時伺服器刪掉未完成的新對話 → 列表殘留／點進去 404
      setActiveId(null);
      setMessages([]);
      setHasOlderMessages(false);
      setComposerHint(
        res.status === 404
          ? "找不到這則對話（可能在電腦斷線時尚未存檔就被清除）。請重新整理列表，或用原裝置重開。"
          : "載入對話失敗，請稍後再試。",
      );
      void refreshConversations();
      return;
    }
    const data = await res.json();
    if (data.conversation?.model) applyModelSelection(data.conversation.model);
    setMessages(markAutoRouted(data.messages as Message[]));
    setHasOlderMessages(Boolean(data.hasMore));
    setComposerHint(null);
    requestAnimationFrame(() => scrollToBottom("auto"));
  }

  function newConversation() {
    if (busy) return;
    setActiveId(null);
    setMessages([]);
    setHasOlderMessages(false);
    setLoadingOlder(false);
    setFamilyId(AUTO_FAMILY_ID);
    setSidebarOpen(false);
    stickToBottomRef.current = true;
    setShowJumpLatest(false);
  }

  /** 移入垃圾桶：跨對話記憶會排除此串，還原後訊息與記憶仍在 */
  async function trashConversation(id: string) {
    setConvMenuId(null);
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === activeId) newConversation();
    if (renamingId === id) {
      setRenamingId(null);
      setRenameDraft("");
    }
    await refreshConversations();
    if (trashOpen) void refreshTrashed();
  }

  function startRename(c: Conversation) {
    setConvMenuId(null);
    setRenamingId(c.id);
    setRenameDraft(c.title);
  }

  async function commitRename(id: string) {
    const title = renameDraft.trim().slice(0, 80);
    setRenamingId(null);
    setRenameDraft("");
    if (!title) return;
    const prev = conversations.find((c) => c.id === id)?.title;
    if (prev === title) return;
    setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    const res = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) void refreshConversations();
  }

  async function restoreConversation(id: string) {
    setTrashBusy(true);
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restore: true }),
      });
      await Promise.all([refreshConversations(), refreshTrashed()]);
    } finally {
      setTrashBusy(false);
    }
  }

  async function permanentDeleteConversation(id: string) {
    setTrashBusy(true);
    try {
      await fetch(`/api/conversations/${id}?permanent=1`, { method: "DELETE" });
      await refreshTrashed();
    } finally {
      setTrashBusy(false);
    }
  }

  async function purgeTrash() {
    if (trashedConversations.length === 0) return;
    if (!confirm(`確定永久刪除垃圾桶內全部 ${trashedConversations.length} 則對話？此操作無法復原。`)) return;
    setTrashBusy(true);
    try {
      await fetch("/api/conversations?trash=1", { method: "DELETE" });
      await refreshTrashed();
    } finally {
      setTrashBusy(false);
    }
  }

  async function openStrategySession(id: string) {
    setStrategyBusy(true);
    setStrategyError(null);
    setViewMode((m) => (m === "split" && canSplit ? "split" : "strategy"));
    if (!canSplit) setSidebarOpen(false);
    const switching = strategyDetail?.session.id !== id;
    if (switching) {
      setStrategyDraft("");
      setDispatchSelected(new Set());
      setWsMemoryDirty(false);
    }
    try {
      const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStrategyDetail(null);
        setStrategyError(typeof data.error === "string" ? data.error : "無法載入會議室");
        return;
      }
      const detail = data as StrategySessionDetail;
      setStrategyDetail({ ...detail, dispatch: Array.isArray(detail.dispatch) ? detail.dispatch : [] });
      const ws = strategyWorkspaces.find((w) => w.id === detail.session.workspaceId);
      if (switching || !wsMemoryDirty) setWsMemoryDraft(ws?.memory.notes ?? "");
    } catch (e) {
      setStrategyDetail(null);
      setStrategyError(e instanceof Error ? e.message : "無法載入會議室");
    } finally {
      setStrategyBusy(false);
    }
  }

  async function createStrategyWorkspace() {
    const name = newWsName.trim();
    if (!name || strategyCreating) return;
    setStrategyCreating(true);
    try {
      const res = await fetch("/api/strategy/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setNewWsOpen(false);
        setNewWsName("");
        await refreshStrategySessions();
      }
    } finally {
      setStrategyCreating(false);
    }
  }

  async function createStrategyRoom(workspaceId: string) {
    const name = newRoomName.trim();
    if (!name || strategyCreating) return;
    setStrategyCreating(true);
    try {
      const res = await fetch("/api/strategy/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          topic: newRoomTopic.trim(),
          workspaceId,
          templateId: newRoomTemplateId || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { session?: { id: string } };
      if (res.ok && data.session?.id) {
        setNewRoomWsId(null);
        setNewRoomName("");
        setNewRoomTopic("");
        setNewRoomTemplateId("automax");
        await refreshStrategySessions();
        await openStrategySession(data.session.id);
      }
    } finally {
      setStrategyCreating(false);
    }
  }

  async function patchStrategySessionMeta(patch: {
    models?: StrategyMemberConfig[];
    templateId?: string;
  }): Promise<boolean> {
    const sessionId = strategyDetail?.session.id;
    if (!sessionId) return false;
    const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    await openStrategySession(sessionId);
    await refreshStrategySessions();
    return true;
  }

  async function decideDispatch(action: "dispatch" | "reject") {
    const sessionId = strategyDetail?.session.id;
    const ids = [...dispatchSelected];
    if (!sessionId || !ids.length) return;
    setStrategyError(null);
    const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sessionId)}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ids }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      items?: StrategyDispatchItem[];
      error?: string;
      code?: string;
    };
    if (res.status === 409 || data.code === "SESSION_PAUSED") {
      setStrategyError(data.error || "會議室目前處於暫停狀態，無法派送指令，請先恢復執行。");
      return;
    }
    if (res.ok && Array.isArray(data.items)) {
      setStrategyDetail((d) => (d ? { ...d, dispatch: data.items! } : d));
      setDispatchSelected(new Set());
    } else if (!res.ok) {
      setStrategyError(data.error || "派送失敗");
    }
  }

  async function toggleAutoDispatch(next: boolean) {
    const sessionId = strategyDetail?.session.id;
    if (!sessionId) return;
    const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoDispatch: next }),
    });
    if (res.ok) {
      setStrategyDetail((d) => (d ? { ...d, session: { ...d.session, autoDispatch: next } } : d));
      void refreshStrategySessions();
    }
  }

  async function handlePauseAction(action: PauseAction) {
    const sessionId = strategyDetail?.session.id;
    if (!sessionId) return;
    setStrategyBusy(true);
    setStrategyError(null);
    try {
      const res = await fetch(`/api/strategy/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pauseAction: action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session?: StrategySessionDetail["session"];
        error?: string;
      };
      if (!res.ok) {
        setStrategyError(data.error || "暫停操作失敗");
        return;
      }
      if (data.session) {
        setStrategyDetail((d) => (d ? { ...d, session: { ...d.session, ...data.session! } } : d));
      }
      await openStrategySession(sessionId);
    } finally {
      setStrategyBusy(false);
    }
  }

  async function handleMarkDispatchDone(dispatchId: string) {
    setStrategyError(null);
    const res = await fetch(`/api/strategy/dispatch/${encodeURIComponent(dispatchId)}/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "marked done from web" }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setStrategyError(data.error || "標記完成失敗");
      return;
    }
    const sessionId = strategyDetail?.session.id;
    if (sessionId) await openStrategySession(sessionId);
  }

  function handleSyncPatch(data: Extract<StrategySyncResponse, { changed: true }>) {
    if (strategySending) return;
    if (!strategyDetail || strategyDetail.session.id !== data.session.id) return;
    const nextDispatch = Array.isArray(data.dispatch) ? data.dispatch : strategyDetail.dispatch;
    const pendingIds = new Set(nextDispatch.filter((d) => d.status === "pending").map((d) => d.id));
    setDispatchSelected((sel) => new Set([...sel].filter((id) => pendingIds.has(id))));
    setStrategyDetail({
      ...strategyDetail,
      session: { ...strategyDetail.session, ...data.session },
      dossier: data.dossier ?? strategyDetail.dossier,
      messages: Array.isArray(data.messages) ? data.messages : strategyDetail.messages,
      runs: Array.isArray(data.runs) ? data.runs : strategyDetail.runs,
      reports: Array.isArray(data.reports) ? data.reports : strategyDetail.reports,
      dispatch: nextDispatch,
    });
    if (!wsMemoryDirty && typeof data.workspaceMemoryNotes === "string") {
      setWsMemoryDraft(data.workspaceMemoryNotes);
    }
  }

  async function saveWorkspaceMemory() {
    const workspaceId = strategyDetail?.session.workspaceId;
    if (!workspaceId || wsMemorySaving) return;
    setWsMemorySaving(true);
    try {
      const res = await fetch(`/api/strategy/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryNotes: wsMemoryDraft }),
      });
      if (res.ok) {
        setWsMemoryDirty(false);
        await refreshStrategySessions();
      }
    } finally {
      setWsMemorySaving(false);
    }
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: authEmail,
        password: authPassword,
        name: authName || undefined,
        role: authMode === "register" ? authRole : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthError(data.error || "登入失敗");
      return;
    }
    if (data.redirect && data.redirect !== "/" && authRole === "supplier") {
      window.location.href = data.redirect;
      return;
    }
    const bal = data.balance ?? 0;
    setAuthUser(data.user);
    setHasPaidAccess(Boolean(data.user?.isAdmin || bal > 0));
    setWallet({
      balance: bal,
      quotaCap: normalizeQuotaCap(bal, data.quotaCap),
      usage: { messages: 0, chargedPoints: 0, officialPoints: 0 },
      apiKey: data.user.apiKey,
    });
    setAuthModalOpen(false);
    void refreshMe();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthUser(null);
    setHasPaidAccess(false);
    setWallet(null);
    setConversations([]);
    setMessages([]);
    setActiveId(null);
    setHasOlderMessages(false);
    setLoadingOlder(false);
    setAccountOpen(false);
    setMemoryOpen(false);
    setTrashOpen(false);
    setTrashedConversations([]);
    setViewMode("chat");
    setStrategyWorkspaces([]);
    setStrategyDetail(null);
    changeAttachedWorkspace("");
    setConvMenuId(null);
    setRenamingId(null);
    setMemories([]);
    setSidebarOpen(false);
    if (currentLocked) setFamilyId(AUTO_FAMILY_ID);
    void refreshMe();
    void refreshConversations();
  }

  async function redeem() {
    setRedeemMsg(null);
    const res = await fetch("/api/wallet/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ code: redeemInput }),
    });
    const data = await res.json();
    if (!res.ok) {
      setRedeemMsg(data.error || "兌換失敗");
      return;
    }
    setRedeemMsg(data.message || "兌換成功");
    setRedeemInput("");
    if (typeof data.hasPaidAccess === "boolean") setHasPaidAccess(data.hasPaidAccess);
    if (data.freeQuota) setFreeQuota(data.freeQuota);
    if (typeof data.balance === "number") {
      const bal = data.balance as number;
      if (bal > 0) setHasPaidAccess(true);
      const cap = normalizeQuotaCap(bal, data.quotaCap);
      setWallet((prev) =>
        prev
          ? { ...prev, balance: bal, quotaCap: cap }
          : {
              balance: bal,
              quotaCap: cap,
              usage: { messages: 0, chargedPoints: 0, officialPoints: 0 },
              apiKey: authUser?.apiKey,
            },
      );
    }
    await refreshWallet();
  }

  async function mintCode(points: number, planLabel: string) {
    setMintMsg(null);
    setMintedCode(null);
    const res = await fetch("/api/admin/redeem-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        points,
        maxUses: 1,
        note: `admin mint · ${planLabel} · ${points} 額度`,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMintMsg(data.error || "產碼失敗");
      return;
    }
    setMintedCode(data.code);
    setMintMsg(`已產生 ${planLabel}（${points.toLocaleString("zh-TW")} 額度）兌換碼`);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setRedeemMsg("已複製 API Key");
    } catch {
      setRedeemMsg("複製失敗，請手動選取");
    }
  }

  async function refreshApiKeys() {
    try {
      const res = await fetch("/api/account/api-keys", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setRedeemMsg(data.error ?? "無法載入 API Key 列表");
        return;
      }
      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (e) {
      setRedeemMsg(e instanceof Error ? e.message : "無法載入 API Key 列表");
    }
  }

  async function createApiKey() {
    if (apiKeysBusy) return;
    setApiKeysBusy(true);
    try {
      const res = await fetch("/api/account/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: apiKeyLabel.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRedeemMsg(data.error ?? "新增金鑰失敗");
        return;
      }
      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
      setFreshApiKey(String(data.apiKey ?? ""));
      setApiKeyLabel("");
      setRedeemMsg("已新增金鑰，請立即複製保存（之後只會顯示末四碼）");
      if (data.apiKey && authUser) {
        setAuthUser({ ...authUser, apiKey: String(data.apiKey) });
      }
    } catch (e) {
      setRedeemMsg(e instanceof Error ? e.message : "新增金鑰失敗");
    } finally {
      setApiKeysBusy(false);
    }
  }

  async function revokeApiKey(id: string, hint: string) {
    if (apiKeysBusy) return;
    if (!confirm(`確定刪除金鑰 ${hint}？刪除後立即失效，外部工具需改用其他金鑰。`)) return;
    setApiKeysBusy(true);
    try {
      const res = await fetch(`/api/account/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setRedeemMsg(data.error ?? "刪除金鑰失敗");
        return;
      }
      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
      if (freshApiKey) setFreshApiKey(null);
      setRedeemMsg(`已刪除金鑰 ${hint}`);
    } catch (e) {
      setRedeemMsg(e instanceof Error ? e.message : "刪除金鑰失敗");
    } finally {
      setApiKeysBusy(false);
    }
  }

  useEffect(() => {
    if (accountOpen && authUser) void refreshApiKeys();
  }, [accountOpen, authUser?.id]);

  async function refreshMemories() {
    if (!authUser) return;
    try {
      const res = await fetch("/api/user-memories");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "讀取記憶失敗");
      setMemories(Array.isArray(data.memories) ? (data.memories as UserMemoryItem[]) : []);
    } catch (e) {
      setMemoryMsg(e instanceof Error ? e.message : "讀取記憶失敗");
    }
  }

  async function addMemory(text: string, category: "style" | "fact") {
    const trimmed = text.trim();
    if (!trimmed || memoryBusy) return;
    setMemoryBusy(true);
    setMemoryMsg(null);
    try {
      const res = await fetch("/api/user-memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, category }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "新增失敗");
      setMemoryDraft("");
      setMemoryMsg(category === "style" ? "已記住語氣偏好（跨模型生效）" : "已記住背景事實");
      await refreshMemories();
    } catch (e) {
      setMemoryMsg(e instanceof Error ? e.message : "新增失敗");
    } finally {
      setMemoryBusy(false);
    }
  }

  async function removeMemory(id: string) {
    if (memoryBusy) return;
    setMemoryBusy(true);
    setMemoryMsg(null);
    try {
      const res = await fetch(`/api/user-memories?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "刪除失敗");
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setMemoryMsg(e instanceof Error ? e.message : "刪除失敗");
    } finally {
      setMemoryBusy(false);
    }
  }

  useEffect(() => {
    if (memoryOpen && authUser) void refreshMemories();
  }, [memoryOpen, authUser?.id]);

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "48px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  useEffect(() => {
    resizeTextarea();
  }, [input]);

  function flashComposerHint(msg: string) {
    setComposerHint(msg);
    window.setTimeout(() => setComposerHint((cur) => (cur === msg ? null : cur)), 3200);
  }

  async function ingestFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const addImgs: PendingImage[] = [];
    const addFiles: PendingFile[] = [];
    let splitHint: string | null = null;
    for (const file of files) {
      try {
        if (file.type.startsWith("image/")) {
          addImgs.push(await compressImageFile(file));
        } else if (isZipAttachment(file)) {
          flashComposerHint(`正在解壓「${file.name}」…`);
          const parts = await readZipAttachment(file, UNLIMITED_FILE_PARTS);
          addFiles.push(...parts);
          if (parts.length > 1) {
            splitHint = `「${file.name}」已拆成 ${parts.length} 個附件`;
          }
        } else if (isOfficeAttachment(file)) {
          flashComposerHint(`正在解析「${file.name}」…`);
          const parts = await readOfficeAttachment(file, UNLIMITED_FILE_PARTS);
          addFiles.push(...parts);
          if (parts.length > 1) {
            splitHint = `「${file.name}」已拆成 ${parts.length} 個附件`;
          }
        } else if (
          TEXT_FILE_RE.test(file.name) ||
          file.type.startsWith("text/") ||
          file.type === "application/json" ||
          file.type === "application/x-ndjson" ||
          file.type === "application/jsonl"
        ) {
          const parts = await readTextAttachment(file, UNLIMITED_FILE_PARTS);
          addFiles.push(...parts);
          if (parts.length > 1) {
            splitHint = `「${file.name}」已拆成 ${parts.length} 個附件（每段最多 ${formatCharCount(MAX_FILE_CHARS)} 字）`;
          }
        } else {
          flashComposerHint(
            `不支援的檔案類型：${file.name}（可上傳圖片、文字檔、PDF、Word .docx、Excel、ZIP）`,
          );
        }
      } catch (e) {
        flashComposerHint(e instanceof Error ? e.message : String(e));
      }
    }
    if (addImgs.length) {
      setPendingImages((prev) => {
        const next = [...prev, ...addImgs].slice(0, MAX_PENDING_IMAGES);
        if (prev.length + addImgs.length > MAX_PENDING_IMAGES) {
          flashComposerHint(`圖片最多 ${MAX_PENDING_IMAGES} 張`);
        }
        return next;
      });
    }
    if (addFiles.length) {
      setPendingFiles((prev) => [...prev, ...addFiles]);
      if (splitHint) flashComposerHint(splitHint);
    }
  }

  function stopVoiceInput() {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    setListening(false);
    if (!rec) return;
    try {
      // abort 會丟掉尚未回傳的辨識結果，避免送出後又把文字塞回輸入框
      if (rec.abort) rec.abort();
      else rec.stop();
    } catch {
      /* 已停止 */
    }
  }

  function toggleVoiceInput() {
    if (listening) {
      stopVoiceInput();
      return;
    }
    type SpeechRec = {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      start: () => void;
      stop: () => void;
      abort?: () => void;
      onresult: ((ev: { resultIndex: number; results: ArrayLike<{ 0?: { transcript?: string } }> }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
    };
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      flashComposerHint("您的瀏覽器環境不支援原生語音輸入，建議使用 Chrome / Edge 瀏覽器");
      return;
    }
    const rec = new SR();
    rec.lang = "zh-TW";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (event) => {
      if (recognitionRef.current !== rec) return;
      let chunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        chunk += event.results[i][0]?.transcript ?? "";
      }
      if (chunk) setInput((prev) => `${prev}${chunk}`);
    };
    rec.onerror = () => {
      if (recognitionRef.current !== rec) return;
      setListening(false);
      recognitionRef.current = null;
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  function buildOutgoingContent(base: string, files: PendingFile[]) {
    let content = base.trim();
    for (const f of files) {
      content += `\n\n--- [附件檔案：${f.name}] ---\n${f.text}\n--- [附件結束] ---`;
    }
    return content.trim();
  }

  async function send(opts?: {
    text?: string;
    images?: PendingImage[];
    files?: PendingFile[];
    /** 重新生成：不清 composer，也不帶當前附件 */
    regenerate?: boolean;
    /** Auto：強制改派 L3 主力重答 */
    forceMain?: boolean;
  }) {
    if (busy || !currentModel?.available) return;
    // 組字中勿送出，避免注音半成品（如「ㄎ」）變成對話訊息
    if (!opts?.regenerate && imeComposingRef.current) return;
    if (currentLocked) {
      flashComposerHint("此為高階模型，請先登入並開通雲端工作台服務費方案，或改選各家免費入門模型");
      if (authUser) setAccountOpen(true);
      else setAuthModalOpen(true);
      return;
    }
    const imgs = opts?.regenerate ? [] : (opts?.images ?? pendingImages);
    let files = opts?.regenerate ? [] : (opts?.files ?? pendingFiles);
    let boxText = opts?.text ?? input;

    // 送出前雙保險：對話欄仍有超長本文 → 收成 TXT（可拆多段）
    if (!opts?.regenerate && !opts?.files && boxText.trim().length >= LONG_PASTE_TO_FILE_CHARS) {
      const { files: parts, hint } = pendingFilesFromLongText(boxText.trim(), UNLIMITED_FILE_PARTS);
      if (parts.length === 0) return;
      files = [...files, ...parts];
      boxText =
        parts.length === 1
          ? `請依附件「${parts[0]!.name}」內容處理。`
          : `請依附件 ${parts.map((p) => `「${p.name}」`).join("、")} 內容處理。`;
      flashComposerHint(hint);
    }

    const content = buildOutgoingContent(boxText, files);
    if (!content && imgs.length === 0) return;

    // 先掛 AbortController，避免 busy 後立刻按停止卻還抓不到 controller
    const controller = new AbortController();
    abortRef.current = controller;

    // 還原時用送出當下的短提示＋附件 chip（可收合／刪除），不要把長文再塞回 textarea
    const composerDraft = {
      text: boxText,
      images: imgs.map((img) => ({ ...img })),
      files: files.map((f) => ({ ...f })),
      regenerate: Boolean(opts?.regenerate),
    };
    const startedConvId = activeId;

    stopVoiceInput();

    if (!opts?.regenerate) {
      setInput("");
      setPendingImages([]);
      setPendingFiles([]);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = "48px";
        }
      });
    }

    setBusy(true);
    stickToBottomRef.current = true;
    setShowJumpLatest(false);
    const displayContent =
      imgs.length > 0 ? `[已上傳 ${imgs.length} 張圖片]\n${content || "（見附圖）"}` : content;
    const userMsgId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: displayContent, createdAt: now },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: now + 1,
        model: isAuto ? null : modelId,
        autoRouted: isAuto,
        deepThink: showDeepThink && deepThink,
        effort: showDeepThink && deepThink ? "medium" : baseEffort,
        notices: [],
      },
    ]);
    requestAnimationFrame(() => scrollToBottom("auto"));
    const patch = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

    const contentTw = createBrandTypewriter(brand, (chunk) => {
      patch((m) => ({ ...m, content: m.content + chunk }));
    });
    const thinkingTw = createBrandTypewriter(brand, (chunk) => {
      patch((m) => ({ ...m, thinking: (m.thinking ?? "") + chunk }));
    });

    let streamOk = false;
    let hadAssistantText = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: activeId,
          model: modelId,
          content: content || "（見附圖）",
          images: imgs.map((img) => ({ mimeType: img.mimeType, data: img.data })),
          deepThink: showDeepThink && deepThink,
          autoForce: isAuto && opts?.forceMain ? "main" : undefined,
          strategyWorkspaceId: authUser && attachedWorkspaceId ? attachedWorkspaceId : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const { error, code } = await res.json();
        patch((m) => ({ ...m, error }));
        if (res.status === 402) {
          if (authUser) await refreshWallet();
          else void refreshMe();
          if (code === "MODEL_LOCKED" || code === "FREE_QUOTA_EXHAUSTED") {
            if (authUser) setAccountOpen(true);
            else setAuthModalOpen(true);
          }
        }
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "conversation") setActiveId(ev.conversationId);
          if (ev.type === "auto_route")
            patch((m) => ({ ...m, model: ev.modelId, autoRouted: true, autoLane: ev.lane }));
          if (ev.type === "source") patch((m) => ({ ...m, sourceLabel: ev.label, sourceKind: ev.kind }));
          if (ev.type === "failover")
            patch((m) => ({
              ...m,
              notices: [...(m.notices ?? []), `${ev.from} 滿載或受限（${ev.reason}），已自動無縫接力下一個帳號`],
            }));
          if (ev.type === "thinking") thinkingTw.push(ev.text);
          if (ev.type === "text") {
            hadAssistantText = true;
            contentTw.push(ev.text);
          }
          if (ev.type === "done") {
            if (ev.freeQuota) setFreeQuota(ev.freeQuota as FreeQuota);
            if (typeof ev.hasPaidAccess === "boolean") setHasPaidAccess(ev.hasPaidAccess);
            patch((m) => ({
              ...m,
              model: typeof ev.modelId === "string" ? ev.modelId : m.model,
              effort: (ev.effort as Effort | null | undefined) ?? m.effort ?? splitModelId(ev.modelId ?? m.model ?? "").effort,
              deepThink: Boolean(ev.deepThink) || m.deepThink,
              inputTokens: ev.usage.inputTokens,
              outputTokens: ev.usage.outputTokens,
              officialCostPoints: ev.officialCostPoints,
              chargedPoints: ev.chargedPoints,
              upstreamModelId: ev.upstreamModelId ?? ev.usage?.upstreamModelId,
              upstreamModelVersion: ev.upstreamModelVersion ?? ev.usage?.upstreamModelVersion,
              viaDailyBypass: false,
              groundingSources: ev.groundingSources ?? ev.usage?.groundingSources,
              webSearchQueries: ev.webSearchQueries ?? ev.usage?.webSearchQueries,
              completionStatus:
                (ev.completionStatus as Message["completionStatus"] | undefined) ??
                m.completionStatus,
              quotaLabel: ev.usage?.quotaLabel,
              quotaUsedPct: ev.usage?.quotaUsedPct,
              quotaBeforePct: ev.usage?.quotaRemainingBeforePct,
              quotaAfterPct: ev.usage?.quotaRemainingAfterPct,
            }));
          }
          if (ev.type === "error") patch((m) => ({ ...m, error: ev.message }));
        }
      }
      streamOk = !controller.signal.aborted;
      if (streamOk) {
        await thinkingTw.drain();
        await contentTw.drain();
      } else {
        thinkingTw.flush();
        contentTw.flush();
      }
    } catch (e) {
      thinkingTw.flush();
      contentTw.flush();
      if (!controller.signal.aborted) patch((m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (!streamOk) {
        thinkingTw.flush();
        contentTw.flush();
      }
      thinkingTw.stop();
      contentTw.stop();
      const aborted = controller.signal.aborted;
      abortRef.current = null;
      if (aborted) {
        // 已有半截回覆：保留氣泡（伺服器也會存檔），方便手機等裝置查看
        // 完全沒字才撤回並把原文跳回對話欄
        if (!hadAssistantText) {
          setMessages((prev) => prev.filter((m) => m.id !== userMsgId && m.id !== assistantId));
          if (!startedConvId) setActiveId(null);
          if (!composerDraft.regenerate) {
            imeComposingRef.current = false;
            imeJustEndedRef.current = false;
            if (imeJustEndedTimerRef.current) {
              clearTimeout(imeJustEndedTimerRef.current);
              imeJustEndedTimerRef.current = null;
            }
            setInput(composerDraft.text);
            setPendingImages(composerDraft.images);
            setPendingFiles(composerDraft.files);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.style.height = "48px";
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              el.focus();
              const len = el.value.length;
              try {
                el.setSelectionRange(len, len);
              } catch {
                /* ignore */
              }
            });
          }
        } else {
          patch((m) => ({
            ...m,
            error: m.error || "連線中斷或已停止，回覆未完成",
            completionStatus: m.completionStatus ?? "failed",
          }));
        }
      }
      setBusy(false);
      refreshConversations();
      if (authUser) refreshWallet();
      else void refreshMe();
    }
  }

  function regenerateLast(forceMain = false) {
    if (busy) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
      flashComposerHint("找不到可重新生成的上一題");
      return;
    }
    const text = lastUser.content.replace(/^\[已上傳 \d+ 張圖片\]\n/, "").trim();
    void send({ text, regenerate: true, forceMain });
  }

  const apiBase =
    typeof window !== "undefined" ? `${window.location.origin}/api/v1` : "https://你的網域/api/v1";

  if (authLoading) {
    return (
      <div className="page" style={{ placeItems: "center", display: "grid", minHeight: "100vh" }}>
        <p className="muted">載入中…</p>
      </div>
    );
  }

  return (
    <div className={`app view-${viewMode}${sidebarOpen ? " sidebar-open" : ""}`} data-brand={brand}>
      {sidebarOpen && (
        <button type="button" className="sidebar-backdrop" aria-label="關閉選單" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="sidebar-head-row">
            <button className="primary new-chat-btn" onClick={newConversation} disabled={busy}>
              ＋ 新對話
            </button>
            <button
              type="button"
              className="sidebar-close-btn"
              aria-label="收合對話欄"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="conv-list">
          <div className="conv-section-label">對話</div>
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => {
                if (renamingId === c.id) return;
                openConversation(c.id);
              }}
            >
              {renamingId === c.id ? (
                <input
                  className="conv-rename-input"
                  value={renameDraft}
                  autoFocus
                  maxLength={80}
                  aria-label="重新命名對話"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename(c.id);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setRenamingId(null);
                      setRenameDraft("");
                    }
                  }}
                />
              ) : (
                <span className="title">{c.title}</span>
              )}
              <div className="conv-menu-wrap">
                <button
                  type="button"
                  className="conv-more"
                  aria-label="對話選項"
                  aria-expanded={convMenuId === c.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConvMenuId((prev) => (prev === c.id ? null : c.id));
                  }}
                >
                  ⋯
                </button>
                {convMenuId === c.id && (
                  <div
                    className="conv-menu"
                    role="menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button type="button" role="menuitem" onClick={() => startRename(c)}>
                      重新命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => void trashConversation(c.id)}
                    >
                      刪除
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="muted" style={{ padding: "8px 12px", fontSize: 13 }}>
              還沒有對話
            </div>
          )}

          <div className="conv-section-label strategy-section-label">
            <span>會議室</span>
            {authUser && (
              <button
                type="button"
                className="strategy-add-btn"
                title="新增主體"
                aria-label="新增主體"
                onClick={() => setNewWsOpen((v) => !v)}
              >
                ＋主體
              </button>
            )}
          </div>
          {authUser && newWsOpen && (
            <form
              className="strategy-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void createStrategyWorkspace();
              }}
            >
              <input
                autoFocus
                value={newWsName}
                maxLength={120}
                placeholder="主體名稱，例如：automax 交易策略"
                onChange={(e) => setNewWsName(e.target.value)}
              />
              <div className="row" style={{ gap: 6 }}>
                <button type="submit" disabled={!newWsName.trim() || strategyCreating}>
                  建立
                </button>
                <button type="button" className="ghost" onClick={() => setNewWsOpen(false)}>
                  取消
                </button>
              </div>
            </form>
          )}
          {!authUser ? (
            <div className="muted" style={{ padding: "8px 12px", fontSize: 13 }}>
              登入後可查看策略會議室
            </div>
          ) : strategyWorkspaces.length === 0 ? (
            <div className="muted" style={{ padding: "8px 12px", fontSize: 13 }}>
              還沒有會議室
            </div>
          ) : (
            strategyWorkspaces.map((ws) => {
              const collapsed = collapsedWorkspaces.has(ws.id);
              return (
                <div key={ws.id} className="strategy-ws">
                  <div className="strategy-ws-head">
                    <button
                      type="button"
                      className="strategy-ws-toggle"
                      onClick={() =>
                        setCollapsedWorkspaces((prev) => {
                          const next = new Set(prev);
                          if (next.has(ws.id)) next.delete(ws.id);
                          else next.add(ws.id);
                          return next;
                        })
                      }
                      title={ws.name}
                    >
                      <span className="strategy-ws-caret">{collapsed ? "▸" : "▾"}</span>
                      <span className="title">{ws.name || "未命名主體"}</span>
                    </button>
                    <button
                      type="button"
                      className="strategy-add-btn"
                      title="在此主體開新會議室"
                      aria-label="在此主體開新會議室"
                      onClick={() => {
                        setNewRoomWsId(newRoomWsId === ws.id ? null : ws.id);
                        setNewRoomName("");
                        setNewRoomTopic("");
                        setNewRoomTemplateId("automax");
                      }}
                    >
                      ＋
                    </button>
                  </div>
                  {newRoomWsId === ws.id && (
                    <form
                      className="strategy-inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void createStrategyRoom(ws.id);
                      }}
                    >
                      <input
                        autoFocus
                        value={newRoomName}
                        maxLength={120}
                        placeholder="會議室名稱，例如：G 方案"
                        onChange={(e) => setNewRoomName(e.target.value)}
                      />
                      <input
                        value={newRoomTopic}
                        maxLength={500}
                        placeholder="討論主題（選填）"
                        onChange={(e) => setNewRoomTopic(e.target.value)}
                      />
                      {strategyTemplates.length > 0 ? (
                        <select
                          value={newRoomTemplateId}
                          onChange={(e) => setNewRoomTemplateId(e.target.value)}
                          aria-label="SOP 範本"
                        >
                          {strategyTemplates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <div className="row" style={{ gap: 6 }}>
                        <button type="submit" disabled={!newRoomName.trim() || strategyCreating}>
                          開會議室
                        </button>
                        <button type="button" className="ghost" onClick={() => setNewRoomWsId(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  )}
                  {!collapsed &&
                    (ws.rooms.length === 0 ? (
                      <div className="muted strategy-room-empty">還沒有會議室，按 ＋ 開一間</div>
                    ) : (
                      ws.rooms.map((s) => (
                        <div
                          key={s.id}
                          className={`conv-item strategy-session-item${strategyDetail?.session.id === s.id && viewMode !== "chat" ? " active" : ""}`}
                          onClick={() => void openStrategySession(s.id)}
                          title={`${s.name}（${strategyStatusLabel(s.status)}）${s.topic ? `\n主題：${s.topic}` : ""}`}
                        >
                          <span className="title">{s.name || "未命名會議室"}</span>
                          <span className="strategy-status-chip">{strategyStatusLabel(s.status)}</span>
                        </div>
                      ))
                    ))}
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-trash-bar">
          <button
            type="button"
            className="trash-entry-btn"
            title="垃圾桶"
            aria-label="開啟垃圾桶"
            onClick={() => {
              setConvMenuId(null);
              setTrashOpen(true);
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>垃圾桶</span>
          </button>
        </div>

        <div className="sidebar-foot">
          <div className="account-chip">
            {authUser ? (
              <>
                <div className="account-chip-top">
                  <div className="account-name-row">
                    <div className="name" title={authUser.email}>
                      {authUser.name}
                    </div>
                    <button type="button" className="ghost account-logout-btn" title="登出" onClick={() => void logout()}>
                      登出
                    </button>
                  </div>
                  <button
                    type="button"
                    className="ghost quota-expand-btn"
                    onClick={() => setAccountOpen(true)}
                    title={hasPaidAccess ? "擴充雲端工作台額度" : "開通雲端工作台方案"}
                  >
                    {hasPaidAccess ? "＋擴充" : "＋開通"}
                  </button>
                </div>
                {hasPaidAccess && wallet ? (
                  <div
                    className={`quota-meter quota-${
                      wallet.balance / Math.max(1, wallet.quotaCap) < 0.2
                        ? "low"
                        : wallet.balance / Math.max(1, wallet.quotaCap) < 0.5
                          ? "mid"
                          : "high"
                    }`}
                  >
                    <div className="quota-meter-head">
                      <span className="quota-meter-title">可用額度</span>
                      <span className="quota-tier-badge">{quotaTierLabel(wallet.quotaCap)}</span>
                    </div>
                    <div className="quota-meter-nums">
                      {fmt(wallet.balance, 0)} / {fmt(wallet.quotaCap, 0)}
                      <span className="muted">
                        （{Math.round((100 * wallet.balance) / Math.max(1, wallet.quotaCap))}%）
                      </span>
                    </div>
                    <div className="quota-segments" aria-hidden>
                      {quotaSegmentFills(wallet.balance, wallet.quotaCap).map((fill, i) => (
                        <div key={i} className="quota-seg">
                          <div className="quota-seg-fill" style={{ width: `${Math.round(fill * 100)}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    className={`quota-meter quota-${
                      freeQuota.remaining / Math.max(1, freeQuota.limit) <= 0.2
                        ? "low"
                        : freeQuota.remaining / Math.max(1, freeQuota.limit) <= 0.5
                          ? "mid"
                          : "high"
                    }`}
                  >
                    <div className="quota-meter-head">
                      <span className="quota-meter-title">今日免費額度</span>
                      <span className="quota-tier-badge">入門模型</span>
                    </div>
                    <div className="quota-meter-nums">
                      剩餘 {freeQuota.remaining} / {freeQuota.limit} 則
                    </div>
                    <div className="quota-segments" aria-hidden>
                      <div className="quota-seg">
                        <div
                          className="quota-seg-fill"
                          style={{ width: `${Math.round((100 * freeQuota.remaining) / Math.max(1, freeQuota.limit))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12, marginTop: 4, gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="ghost memory-entry-btn"
                    onClick={() => {
                      setMemoryMsg(null);
                      setMemoryOpen(true);
                    }}
                    title="跨模型生效的語氣與背景記憶"
                  >
                    🧠 記憶與語氣
                  </button>
                  <span className="row" style={{ gap: 10 }}>
                    <Link href="/vendor">算力節點夥伴 →</Link>
                    {authUser.isAdmin && <Link href="/admin">管理後台 →</Link>}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="account-chip-top">
                  <div className="account-name-row">
                    <div className="name">訪客體驗</div>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600 }}
                    onClick={() => setAuthModalOpen(true)}
                  >
                    登入
                  </button>
                </div>
                <div
                  className={`quota-meter quota-${
                    freeQuota.remaining / Math.max(1, freeQuota.limit) <= 0.2
                      ? "low"
                      : freeQuota.remaining / Math.max(1, freeQuota.limit) <= 0.5
                        ? "mid"
                        : "high"
                  }`}
                >
                  <div className="quota-meter-head">
                    <span className="quota-meter-title">今日免費額度</span>
                    <span className="quota-tier-badge">四大廠入門</span>
                  </div>
                  <div className="quota-meter-nums">
                    剩餘 {freeQuota.remaining} / {freeQuota.limit} 則
                  </div>
                  <div className="quota-segments" aria-hidden>
                    <div className="quota-seg">
                      <div
                        className="quota-seg-fill"
                        style={{ width: `${Math.round((100 * freeQuota.remaining) / Math.max(1, freeQuota.limit))}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12, marginTop: 4 }}>
                  <Link href="/vendor">成為算力節點夥伴 →</Link>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="main" aria-hidden={viewMode === "strategy"}>
        <div className="topbar">
          <button type="button" className="menu-btn" aria-label="開啟對話紀錄" onClick={() => setSidebarOpen(true)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
            <span className="menu-btn-label">對話</span>
          </button>
          <div className="topbar-title">
            <strong className={brand === "gemini" ? "brand-gradient-text" : undefined}>
              {isAuto
                ? hasPaidAccess
                  ? "⚡ Auto"
                  : "⚡ Auto（免費）"
                : familyOptions.find((f) => f.familyId === familyId)?.familyLabel ?? "雲端工作台"}
            </strong>
            <span className="topbar-desktop-hint muted">
              {isAuto
                ? "依問題自動派發：日常→Flash，程式／分析→主力模型"
                : brand === "gpt"
                  ? "OpenAI 氛圍"
                  : brand === "claude"
                    ? "Anthropic 書卷氛圍"
                    : brand === "grok"
                      ? "xAI 極客氛圍"
                      : "Gemini 星光氛圍"}
            </span>
          </div>
          {canSplit ? (
            <button
              type="button"
              className={`ghost topbar-split-btn${viewMode === "split" ? " is-active" : ""}`}
              disabled={!strategyDetail}
              title={strategyDetail ? "一般聊天｜會議室並排" : "請先從左側選擇一間會議室"}
              onClick={() => {
                if (!strategyDetail) return;
                setViewMode((m) => (m === "split" ? "strategy" : "split"));
              }}
            >
              {viewMode === "split" ? "取消並排" : "並排檢視"}
            </button>
          ) : null}
          <button
            type="button"
            className="topbar-new-chat"
            aria-label="新對話"
            disabled={busy}
            onClick={newConversation}
            title="新對話"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="messages-wrap">
          <div className="messages" ref={messagesRef} onScroll={updateStickFromScroll}>
            {messages.length > 0 && (hasOlderMessages || loadingOlder) && (
              <div className="msg-history-loader" aria-live="polite">
                {loadingOlder ? "載入更早的對話…" : "上滑載入更早的對話"}
              </div>
            )}
            {messages.length === 0 && (
              <div className="empty">
                <h2 className={brand === "gemini" ? "brand-gradient-text" : undefined}>
                  四大頂級 AI 雲端工作台・多節點智慧路由
                </h2>
                {anyAvailable ? (
                  <p>
                    {hasPaidAccess
                      ? "預設 ⚡ Auto 會依問題自動挑最佳模型；也可在對話欄左下角手動指定全系列模型。"
                      : `免登入即可直接對話：每日免費 ${freeQuota.limit} 則，可自由選擇 Gemini、Claude、GPT、Grok 入門模型；登入並開通雲端工作台方案即可解鎖全系列高階模型。`}
                  </p>
                ) : (
                  <p>目前尚無在線算力節點。請稍後再試，或由管理員接入節點貨源。</p>
                )}
                {!hasPaidAccess && freeQuota.remaining <= 0 && (
                  <p className="notice">
                    今日免費體驗額度已用完。{authUser ? "請點左下「＋開通」輸入雲端工作台服務費序號。" : "請點左下「登入」並開通雲端工作台服務費方案。"}
                  </p>
                )}
              </div>
            )}
            {messages.map((m, i) => {
              const isStreaming =
                busy && m.role === "assistant" && m.id === messages[messages.length - 1]?.id && !m.error;
              return (
              <div key={m.id} className={`msg ${m.role}${isStreaming ? " is-streaming" : ""}`}>
                {authUser?.isAdmin &&
                  m.notices?.map((n, i) => (
                    <div key={i} className="notice">
                      ↻ {n}
                    </div>
                  ))}
                {m.role === "assistant" && isStreaming && m.content && (
                  <div className="stream-status" aria-hidden>
                    <span className="stream-pulse" />
                    <span className="stream-status-label">{STREAM_STATUS[brand].write}</span>
                  </div>
                )}
                <div className={`bubble${isStreaming ? " is-streaming" : ""}`}>
                  {m.role === "assistant" ? (
                    <>
                      <LightMarkdown
                        content={m.content}
                        thinking={!m.content && !m.error && isStreaming}
                        streaming={isStreaming}
                      />
                      {isStreaming && m.content && brand !== "grok" ? (
                        <span className="stream-caret" aria-hidden />
                      ) : null}
                    </>
                  ) : (
                    <UserMessageBubble content={m.content} />
                  )}
                </div>
                {m.role === "user" && m.content && (
                  <div className="msg-toolbar msg-toolbar-user">
                    <CopyIconButton text={m.content} label="複製提問" />
                  </div>
                )}
                {m.error && <div className="meta error">⚠ {m.error}</div>}
                {m.role === "assistant" && m.content && !m.error && (
                  <div className="msg-toolbar">
                    <CopyReplyButton text={m.content} />
                    {i === messages.length - 1 && (
                      <button
                        type="button"
                        title="重新生成僅針對文字內容（圖片不會重送）"
                        disabled={busy}
                        onClick={() => regenerateLast()}
                      >
                        🔄 重新生成
                      </button>
                    )}
                    {i === messages.length - 1 && isAuto && m.autoRouted && m.autoLane === "light" && (
                      <button
                        type="button"
                        title="改派主力模型（Sonnet／Gemini Pro／Terra）重新回答這一題"
                        disabled={busy}
                        onClick={() => regenerateLast(true)}
                      >
                        🚀 改用主力模型重答
                      </button>
                    )}
                    <span className="muted">
                      {m.autoRouted
                        ? `⚡ Auto（由 ${footerModelLabel(m.model, models, { effort: m.effort, deepThink: m.deepThink, autoRouted: true })} 回答）`
                        : footerModelLabel(m.model, models, { effort: m.effort, deepThink: m.deepThink })}
                      {m.chargedPoints != null
                        ? m.chargedPoints > 0
                          ? ` · 本次消耗 ${fmt(m.chargedPoints, 2)} 額度`
                          : " · 免費體驗額度"
                        : ""}
                      {m.groundingSources && m.groundingSources.length > 0
                        ? m.completionStatus === "failed"
                          ? " · 查證未完成"
                          : m.completionStatus === "truncated" ||
                              m.completionStatus === "unknown"
                            ? " · 部分查證"
                            : " · 已上網查證"
                        : ""}
                    </span>
                  </div>
                )}
                {m.role === "assistant" && m.groundingSources && m.groundingSources.length > 0 && (
                  <details className="grounding-box">
                    <summary className="grounding-title">
                      參考來源（{Math.min(m.groundingSources.length, 8)}）
                      {m.completionStatus && m.completionStatus !== "complete"
                        ? ` · ${m.completionStatus}`
                        : ""}
                    </summary>
                    <div className="grounding-chips">
                      {m.groundingSources.slice(0, 8).map((s) => (
                        <SourceChip
                          key={s.uri}
                          href={s.uri}
                          label={s.title && !/^https?:\/\//i.test(s.title) ? s.title : hostnameOfUrl(s.uri)}
                        />
                      ))}
                    </div>
                    {m.webSearchQueries && m.webSearchQueries.length > 0 && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                        搜尋詞：{m.webSearchQueries.join(" · ")}
                      </div>
                    )}
                  </details>
                )}
                {authUser?.isAdmin && m.role === "assistant" && (m.sourceLabel || m.chargedPoints != null) && (
                  <div className="meta">
                    {(m.upstreamModelVersion || m.upstreamModelId) && (
                      <span className="tag">
                        上游確認：{m.upstreamModelVersion ?? m.upstreamModelId}
                      </span>
                    )}
                    {m.quotaUsedPct != null && (
                      <span className="tag" style={{ color: "var(--warn)" }}>
                        扣「{m.quotaLabel}」{m.quotaUsedPct.toFixed(3)}%（{m.quotaBeforePct?.toFixed(2)}% →{" "}
                        {m.quotaAfterPct?.toFixed(2)}%）
                      </span>
                    )}
                    {m.sourceLabel && (
                      <span className={`tag ${m.sourceKind ?? ""}`}>
                        {m.sourceKind === "supplier" ? "供給者訂閱" : "平台直連"}：{m.sourceLabel}
                      </span>
                    )}
                    {m.chargedPoints != null && (
                      <span>
                        官方等值 {fmt(m.officialCostPoints, 4)} · token {m.inputTokens}/{m.outputTokens}
                      </span>
                    )}
                  </div>
                )}
              </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          {showJumpLatest && (
            <button
              type="button"
              className="jump-latest"
              onClick={() => {
                stickToBottomRef.current = true;
                setShowJumpLatest(false);
                scrollToBottom("smooth");
              }}
            >
              ↓ 回到最新
            </button>
          )}
        </div>

        <div className="composer">
          <div className="composer-shell">
            {(pendingImages.length > 0 || pendingFiles.length > 0) && (
              <div className="composer-attachments">
                {pendingImages.map((img) => (
                  <div className="composer-thumb" key={img.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.previewUrl} alt="待傳送圖片" />
                    <button
                      type="button"
                      aria-label="移除圖片"
                      onClick={() => setPendingImages((prev) => prev.filter((x) => x.id !== img.id))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {pendingFiles.map((f) => (
                  <div className="composer-file-chip" key={f.id}>
                    <span>
                      📄 {f.name} ({formatBytes(f.size)})
                    </span>
                    <button
                      type="button"
                      aria-label="移除檔案"
                      onClick={() => setPendingFiles((prev) => prev.filter((x) => x.id !== f.id))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {composerHint && <div className="composer-hint">{composerHint}</div>}
            <div
              className="composer-inner"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={imageInputRef}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void ingestFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept={DOC_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void ingestFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <textarea
                ref={textareaRef}
                value={input}
                placeholder="輸入訊息（手機：換行鍵換行；電腦：Enter 送出／Shift+Enter 換行；可貼圖）"
                onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => {
                  imeComposingRef.current = true;
                  imeJustEndedRef.current = false;
                  if (imeJustEndedTimerRef.current) {
                    clearTimeout(imeJustEndedTimerRef.current);
                    imeJustEndedTimerRef.current = null;
                  }
                }}
                onCompositionEnd={() => {
                  imeComposingRef.current = false;
                  // Windows 注音：compositionend 後常緊接著再派一次 Enter keydown
                  imeJustEndedRef.current = true;
                  if (imeJustEndedTimerRef.current) clearTimeout(imeJustEndedTimerRef.current);
                  imeJustEndedTimerRef.current = setTimeout(() => {
                    imeJustEndedRef.current = false;
                    imeJustEndedTimerRef.current = null;
                  }, 50);
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  const imageFiles: File[] = [];
                  if (items) {
                    for (const item of items) {
                      if (item.type.startsWith("image/")) {
                        const f = item.getAsFile();
                        if (f) imageFiles.push(f);
                      }
                    }
                  }
                  const pastedText = e.clipboardData?.getData("text/plain") ?? "";
                  if (pastedText.length >= LONG_PASTE_TO_FILE_CHARS) {
                    e.preventDefault();
                    if (imageFiles.length) void ingestFiles(imageFiles);
                    const { files: parts, hint } = pendingFilesFromLongText(
                      pastedText,
                      UNLIMITED_FILE_PARTS,
                    );
                    setPendingFiles((prev) => [...prev, ...parts]);
                    flashComposerHint(hint);
                    return;
                  }
                  if (imageFiles.length) {
                    e.preventDefault();
                    void ingestFiles(imageFiles);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  // 注音／IME：組字中或剛結束組字的 Enter 只確認候選，不要送出
                  if (
                    e.nativeEvent.isComposing ||
                    imeComposingRef.current ||
                    imeJustEndedRef.current ||
                    e.keyCode === 229
                  ) {
                    return;
                  }
                  // 手機／觸控：軟體鍵盤「換行」會變成 Enter 且無 Shift → 只插入換行，改點「送出」
                  const touchComposer =
                    typeof window !== "undefined" &&
                    window.matchMedia("(hover: none), (pointer: coarse)").matches;
                  if (touchComposer) return;
                  e.preventDefault();
                  if (busy) return;
                  void send();
                }}
              />
              <div className="composer-bar">
              <button
                type="button"
                className="composer-icon-btn"
                title="上傳圖片（相簿／相機）"
                disabled={busy}
                aria-label="上傳圖片"
                onClick={() => imageInputRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="8.5" cy="10.5" r="1.5" />
                  <path d="M21 16l-5-5-4 4-2-2-5 5" />
                </svg>
              </button>
              <button
                type="button"
                className="composer-icon-btn"
                title="上傳檔案（文字、PDF、Word、Excel、ZIP）"
                disabled={busy}
                aria-label="上傳檔案"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                </svg>
              </button>
              <select
                className="composer-model-select"
                value={familyId}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val !== AUTO_FAMILY_ID && !hasPaidAccess) {
                    const pickedFam = familyOptions.find((x) => x.familyId === val);
                    if (pickedFam && !pickedFam.freeTier) {
                      flashComposerHint("🔒 此為高階模型，開通雲端工作台服務費方案後即可解鎖");
                      if (authUser) setAccountOpen(true);
                      else setAuthModalOpen(true);
                      return;
                    }
                  }
                  setFamilyId(val);
                }}
                disabled={busy}
                title="選擇模型"
              >
                <option value={AUTO_FAMILY_ID} disabled={!anyAvailable && familyOptions.length === 0}>
                  {hasPaidAccess ? AUTO_LABEL : "⚡ Auto（免費智慧入門）"}
                </option>
                {Array.from(
                  familyOptions.reduce((map, f) => {
                    const key = f.categoryLabel;
                    if (!map.has(key)) map.set(key, []);
                    map.get(key)!.push(f);
                    return map;
                  }, new Map<string, typeof familyOptions>()),
                ).map(([group, list]) => (
                  <optgroup key={group} label={group}>
                    {list.map((f) => {
                      const locked = !hasPaidAccess && !f.freeTier;
                      const label = !f.available
                        ? `${f.familyLabel}（待接入）`
                        : locked
                          ? `🔒 ${f.familyLabel}（開通解鎖）`
                          : !hasPaidAccess && f.freeTier
                            ? `✓ ${f.familyLabel}`
                            : f.familyLabel;
                      return (
                        <option key={f.familyId} value={f.familyId} disabled={!f.available}>
                          {label}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              {showDeepThink && (
                <label
                  className="deep-think-toggle"
                  title="適合複雜推理與除錯，回應較慢，單次上限 45 額度"
                >
                  <input
                    type="checkbox"
                    checked={deepThink}
                    disabled={busy}
                    onChange={(e) => setDeepThink(e.target.checked)}
                  />
                  <span>🧠 深度思考</span>
                  <span className="deep-think-warn">高 token</span>
                </label>
              )}
              {authUser && strategyWorkspaces.length > 0 && (
                <select
                  className="composer-model-select composer-ws-select"
                  value={attachedWorkspaceId}
                  onChange={(e) => changeAttachedWorkspace(e.target.value)}
                  disabled={busy}
                  title="附加主體：AI 會讀到主體共用記憶與各會議室的最新摘要"
                >
                  <option value="">不附加主體</option>
                  {strategyWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      📁 {w.name || "未命名主體"}
                    </option>
                  ))}
                </select>
              )}
              <span className="composer-bar-spacer" />
              <button
                type="button"
                className={`composer-icon-btn${listening ? " is-listening" : ""}`}
                title="語音輸入（zh-TW）"
                disabled={busy}
                aria-label="語音輸入"
                onClick={() => toggleVoiceInput()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </button>
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={() => void send()}
                  disabled={(!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || !currentModel?.available}
                >
                  送出
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {viewMode !== "chat" && strategyDetail ? (
        <StrategyRoomView
          detail={strategyDetail}
          draft={strategyDraft}
          onDraftChange={setStrategyDraft}
          dispatchSelected={dispatchSelected}
          onDispatchSelectedChange={setDispatchSelected}
          wsMemoryDraft={wsMemoryDraft}
          onWsMemoryChange={(v) => {
            setWsMemoryDraft(v);
            setWsMemoryDirty(true);
          }}
          wsMemoryDirty={wsMemoryDirty}
          busy={strategyBusy}
          error={strategyError}
          onError={setStrategyError}
          canSplit={canSplit}
          viewMode={viewMode}
          models={models}
          templates={strategyTemplates}
          default3AiPreset={strategyDefault3Ai}
          onToggleSplit={() => setViewMode((m) => (m === "split" ? "strategy" : "split"))}
          onBackToChat={() => setViewMode("chat")}
          onOpenSidebar={() => setSidebarOpen(true)}
          onRefresh={() => {
            if (strategyDetail?.session.id) void openStrategySession(strategyDetail.session.id);
          }}
          onStreamCommitted={async (sid) => {
            await openStrategySession(sid);
            await refreshStrategySessions();
          }}
          onRefreshWallet={() => {
            void refreshWallet();
          }}
          onStreamingChange={setStrategySending}
          onDecideDispatch={(action) => void decideDispatch(action)}
          onToggleAutoDispatch={(next) => void toggleAutoDispatch(next)}
          onSaveMemory={() => void saveWorkspaceMemory()}
          onPauseAction={(action) => void handlePauseAction(action)}
          onMarkDispatchDone={(id) => void handleMarkDispatchDone(id)}
          onSyncPatch={handleSyncPatch}
          onPatchSessionMeta={patchStrategySessionMeta}
          wsMemorySaving={wsMemorySaving}
        />
      ) : null}

      {trashOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTrashOpen(false);
          }}
        >
          <div
            className="modal-panel trash-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trash-modal-title"
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <h2 id="trash-modal-title">垃圾桶</h2>
                <p className="muted memory-hint">
                  刪除的對話會暫存在此。在垃圾桶期間不會注入該對話記憶；還原後訊息與記憶會一併回來。永久刪除後無法復原。
                </p>
              </div>
              <button type="button" className="ghost" onClick={() => setTrashOpen(false)}>
                關閉
              </button>
            </div>

            <div className="modal-section">
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>已刪除對話</h3>
                <button
                  type="button"
                  className="ghost trash-purge-btn"
                  disabled={trashBusy || trashedConversations.length === 0}
                  onClick={() => void purgeTrash()}
                >
                  全部刪除
                </button>
              </div>
              {trashedConversations.length === 0 ? (
                <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>
                  垃圾桶是空的
                </div>
              ) : (
                <div className="trash-list">
                  {trashedConversations.map((c) => (
                    <div key={c.id} className="trash-item">
                      <span className="title" title={c.title}>
                        {c.title}
                      </span>
                      <div className="trash-item-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={trashBusy}
                          onClick={() => void restoreConversation(c.id)}
                        >
                          還原
                        </button>
                        <button
                          type="button"
                          className="ghost trash-purge-btn"
                          disabled={trashBusy}
                          onClick={() => {
                            if (!confirm(`確定永久刪除「${c.title}」？此操作無法復原。`)) return;
                            void permanentDeleteConversation(c.id);
                          }}
                        >
                          永久刪除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {memoryOpen && authUser && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMemoryOpen(false);
          }}
        >
          <div
            className="modal-panel memory-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-modal-title"
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <h2 id="memory-modal-title">🧠 記憶與語氣</h2>
                <p className="muted memory-hint">
                  💡 這裡設定的語氣與記憶會跨模型生效（切換 GPT、Claude、Gemini 皆會自動套用）。你也可以直接在對話中說「以後都用某某語氣回我」讓系統自動記住。
                </p>
              </div>
              <button type="button" className="ghost" onClick={() => setMemoryOpen(false)}>
                關閉
              </button>
            </div>

            <div className="modal-section">
              <h3>快速新增</h3>
              <div className="memory-templates">
                {STYLE_QUICK_TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    className="memory-chip"
                    disabled={memoryBusy}
                    title={`新增語氣：${t.text}`}
                    onClick={() => {
                      setMemoryCategory("style");
                      setMemoryDraft(t.text);
                      void addMemory(t.text, "style");
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="memory-add-row">
                <select
                  className="memory-cat-select"
                  value={memoryCategory}
                  disabled={memoryBusy}
                  onChange={(e) => setMemoryCategory(e.target.value === "fact" ? "fact" : "style")}
                  title="記憶類別"
                >
                  <option value="style">語氣偏好</option>
                  <option value="fact">背景事實</option>
                </select>
                <input
                  value={memoryDraft}
                  disabled={memoryBusy}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  placeholder={
                    memoryCategory === "style"
                      ? "例如：回答簡短、叫我老闆、先給程式碼"
                      : "例如：我是前端工程師、專案叫 AlloyFlux"
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void addMemory(memoryDraft, memoryCategory);
                    }
                  }}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={memoryBusy || !memoryDraft.trim()}
                  onClick={() => void addMemory(memoryDraft, memoryCategory)}
                >
                  新增
                </button>
              </div>
              {memoryMsg && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{memoryMsg}</p>}
            </div>

            <div className="modal-section">
              <h3>語氣與排版偏好 (style)</h3>
              {memories.filter((m) => m.category === "style").length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  尚無語氣偏好。點上方範本，或輸入後新增。
                </p>
              ) : (
                <ul className="memory-list">
                  {memories
                    .filter((m) => m.category === "style")
                    .map((m) => (
                      <li key={m.id} className="memory-item">
                        <span className="memory-item-text">{m.fact}</span>
                        <button
                          type="button"
                          className="memory-del"
                          title="刪除"
                          disabled={memoryBusy}
                          aria-label={`刪除語氣：${m.fact}`}
                          onClick={() => void removeMemory(m.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>

            <div className="modal-section">
              <h3>個人背景記憶 (fact)</h3>
              {memories.filter((m) => m.category === "fact").length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  尚無背景記憶。可在對話自述，或於此手動新增。
                </p>
              ) : (
                <ul className="memory-list">
                  {memories
                    .filter((m) => m.category === "fact")
                    .map((m) => (
                      <li key={m.id} className="memory-item">
                        <span className="memory-item-text">{m.fact}</span>
                        <button
                          type="button"
                          className="memory-del"
                          title="刪除"
                          disabled={memoryBusy}
                          aria-label={`刪除背景：${m.fact}`}
                          onClick={() => void removeMemory(m.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {accountOpen && authUser && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAccountOpen(false);
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <h2 id="account-modal-title">雲端工作台帳戶與方案</h2>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {authUser.email}
                </p>
              </div>
              <button type="button" className="ghost" onClick={() => setAccountOpen(false)}>
                關閉
              </button>
            </div>

            {wallet && (
              <div
                className={`quota-meter quota-meter-lg quota-${
                  wallet.balance / Math.max(1, wallet.quotaCap) < 0.2
                    ? "low"
                    : wallet.balance / Math.max(1, wallet.quotaCap) < 0.5
                      ? "mid"
                      : "high"
                }`}
                style={{ marginBottom: 12 }}
              >
                <div className="quota-meter-head">
                  <span className="quota-meter-title">可用額度</span>
                  <span className="quota-tier-badge">{quotaTierLabel(wallet.quotaCap)}</span>
                </div>
                <div className="quota-meter-nums">
                  {fmt(wallet.balance, 0)} / {fmt(wallet.quotaCap, 0)} 額度
                  <span className="muted">
                    （{Math.round((100 * wallet.balance) / Math.max(1, wallet.quotaCap))}%）
                  </span>
                </div>
                <div className="quota-segments" aria-hidden>
                  {quotaSegmentFills(wallet.balance, wallet.quotaCap).map((fill, i) => (
                    <div key={i} className="quota-seg">
                      <div className="quota-seg-fill" style={{ width: `${Math.round(fill * 100)}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {wallet && wallet.usage.messages > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                已回答 {wallet.usage.messages} 則，共扣 {fmt(wallet.usage.chargedPoints)} 額度
              </p>
            )}

            <div className="modal-section" id="redeem-section">
              <h3>1. 雲端工作台軟體服務費（SaaS 平台技術服務費）</h3>
              <div className="plan-tiers">
                <div className="plan-tier">
                  <strong>NT$ 199 輕量方案</strong>
                  <span>1,000 工作台額度 · 解鎖全系列模型</span>
                </div>
                <div className="plan-tier plan-tier-hot">
                  <strong>NT$ 299 進階方案</strong>
                  <span>1,800 工作台額度（+20%）· 雙格容量</span>
                </div>
                <div className="plan-tier plan-tier-pro">
                  <strong>NT$ 399 旗艦方案</strong>
                  <span>2,800 工作台額度（+40%）· 三格容量</span>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                輸入服務費開通序號立即啟用並解鎖高階推理模型與外部工具連線。
              </p>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <input
                  value={redeemInput}
                  onChange={(e) => setRedeemInput(e.target.value)}
                  placeholder="VIP199-XXXX 或封測儲值金鑰"
                  style={{ flex: 1, minWidth: 160 }}
                />
                <button type="button" className="primary" onClick={() => void redeem()}>
                  兌換開通
                </button>
              </div>
              {redeemMsg && <p className="muted" style={{ fontSize: 12 }}>{redeemMsg}</p>}
            </div>

            <div className="modal-section">
              <h3>2. Cursor / 第三方工具 API Key</h3>
              <p className="muted" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 0 }}>
                Base URL：<code>{apiBase}</code>
                <br />
                可新增多把金鑰、個別刪除（被盜即可立刻撤銷）。完整密鑰只在「新增當下」顯示一次。
              </p>

              {freshApiKey && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--panel-2)",
                  }}
                >
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    新金鑰（請立刻複製）：
                  </div>
                  <code style={{ display: "block", fontSize: 12, wordBreak: "break-all", marginBottom: 8 }}>
                    {freshApiKey}
                  </code>
                  <button type="button" className="primary" onClick={() => void copyText(freshApiKey)}>
                    一鍵複製新金鑰
                  </button>
                </div>
              )}

              <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <input
                  value={apiKeyLabel}
                  onChange={(e) => setApiKeyLabel(e.target.value)}
                  placeholder="金鑰名稱（選填，如 Cursor 筆電）"
                  style={{ flex: 1, minWidth: 160 }}
                  disabled={apiKeysBusy}
                />
                <button type="button" className="primary" disabled={apiKeysBusy} onClick={() => void createApiKey()}>
                  ＋ 新增金鑰
                </button>
              </div>

              {apiKeys.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>尚無金鑰，請先新增一把。</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                  {apiKeys.map((k) => (
                    <li
                      key={k.id}
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px 10px",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: "var(--panel-2)",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{k.label || "未命名"}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {k.keyHint} · {new Date(k.createdAt).toLocaleString("zh-TW")}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={apiKeysBusy}
                        onClick={() => void revokeApiKey(k.id, k.keyHint)}
                        title="刪除後立即失效"
                      >
                        🗑 刪除
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <p className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.55 }}>
                💡 可填入支援 OpenAI 相容接口之工具。注意：外部寫程式工具每次請求會夾帶大量專案上下文，額度消耗速度將高於網頁版聊天。
              </p>
            </div>

            {authUser.isAdmin && (
              <div className="modal-section">
                <h3>3. 管理員專區</h3>
                <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                  快捷產生服務費序號（對應 199／299／399 方案）：
                </p>
                <div className="row" style={{ flexWrap: "wrap", marginBottom: 10, gap: 8 }}>
                  <button type="button" className="primary" onClick={() => void mintCode(1000, "199 輕量")}>
                    1,000 額度
                  </button>
                  <button type="button" onClick={() => void mintCode(1800, "299 進階")}>
                    1,800 額度
                  </button>
                  <button type="button" onClick={() => void mintCode(2800, "399 旗艦")}>
                    2,800 額度
                  </button>
                  <Link href="/admin">管理後台</Link>
                  <Link href="/vendor">節點夥伴頁</Link>
                </div>
                {mintedCode && (
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <code>{mintedCode}</code>
                    <button type="button" onClick={() => void copyText(mintedCode)}>
                      複製序號
                    </button>
                  </div>
                )}
                {mintMsg && <p className="muted" style={{ fontSize: 12 }}>{mintMsg}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {authModalOpen && !authUser && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAuthModalOpen(false);
          }}
        >
          <div className="modal-panel" style={{ maxWidth: 440 }} role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <h2 id="login-modal-title" style={{ margin: 0 }}>登入雲端工作台</h2>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                  登入後可永久保存對話紀錄，並開通方案解鎖全系列高階模型
                </p>
              </div>
              <button type="button" className="ghost" onClick={() => setAuthModalOpen(false)}>
                關閉
              </button>
            </div>

            {googleEnabled && (
              <div style={{ margin: "14px 0" }}>
                <a
                  href="/api/auth/google/start?role=buyer&next=/"
                  className="primary"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: "11px 16px",
                    borderRadius: 10,
                    fontWeight: 600,
                    textDecoration: "none",
                    background: "var(--accent)",
                    color: "#fff",
                  }}
                >
                  使用 Google 帳號一鍵登入
                </a>
              </div>
            )}

            <div className="auth-tabs" style={{ marginTop: 12 }}>
              <button type="button" className={authMode === "login" ? "primary" : ""} onClick={() => setAuthMode("login")}>
                Email 登入
              </button>
              <button
                type="button"
                className={authMode === "register" ? "primary" : ""}
                onClick={() => {
                  setAuthMode("register");
                  setAuthRole("buyer");
                }}
              >
                註冊帳號
              </button>
            </div>

            <form onSubmit={submitAuth} className="form-grid" style={{ gridTemplateColumns: "1fr", marginTop: 10 }}>
              {authMode === "register" && (
                <label>
                  顯示名稱（選填）
                  <input value={authName} onChange={(e) => setAuthName(e.target.value)} />
                </label>
              )}
              <label>
                Email
                <input type="email" required value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
              </label>
              <label>
                密碼
                <input
                  type="password"
                  required
                  minLength={6}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </label>
              <button type="submit" className="primary" style={{ padding: "11px 16px", fontWeight: 600 }}>
                {authMode === "login" ? "登入" : "建立工作台帳號"}
              </button>
            </form>
            {authError && <p style={{ color: "var(--danger)", fontSize: 13 }}>{authError}</p>}

            <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              想加入算力節點託管與開源評測計畫？請前往 <Link href="/vendor">算力節點夥伴專頁（/vendor）→</Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
