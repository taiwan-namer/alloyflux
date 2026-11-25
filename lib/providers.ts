import { createHash } from "node:crypto";
import type { ModelInfo, Usage } from "./models";
import {
  CHATGPT_OAUTH,
  GEMINI_OAUTH,
  GROK_OAUTH,
  bootstrapGeminiAccount,
  chatGptWindowLabel,
  fetchAntigravityAvailableModels,
  grokProxyHeaders,
  pickChatGptPrimaryWindow,
  refreshOAuthCredentials,
  resolveChatGptResetAt,
  type OAuthCredentials,
  type QuotaWindow,
  type SubscriptionQuota,
} from "./oauth";
import { saveSourceQuota, saveUpdatedOAuthCreds, syncSourceQuotaById, type Candidate } from "./sources";
import {
  buildContextualResearchQuery,
  formatResearchInjection,
  runLiveResearch,
  shouldSkipLiveResearch,
  type ResearchBundle,
} from "./web-research";
import {
  isResearchPipelineV2Enabled,
  reusePreparedResearch,
  runResearchPipelineV2,
  verdictToLegacyBundle,
  type ResearchVerdict,
} from "./research-v2";
import { appendStyleOverride } from "./persona-style";
import { loadCodexTurnState, saveCodexTurnState } from "./prompt-cache-sticky";
import { assertE2EOrPass } from "@/lib/e2e-isolation";
export interface ChatImage {
  mimeType: string;
  data: string; // 純 base64，不含 data: prefix
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 僅當輪上游使用；不寫入 SQLite */
  images?: ChatImage[];
}

const TEXT_ONLY_MODEL_IDS = new Set(["node-mock", "agy-gpt-oss-120b-medium"]);

/** 明確不支援視覺的型號：略過 images，避免上游 400 */
export function modelAcceptsImages(model: ModelInfo): boolean {
  if (TEXT_ONLY_MODEL_IDS.has(model.id)) return false;
  if (model.category === "antigravity-gpt") return false;
  if (model.category === "node-agent") return false;
  return true;
}

function resolveUserForUpstream(m: ChatMessage, model: ModelInfo): ChatMessage {
  if (m.role !== "user" || !m.images?.length) {
    return { role: m.role, content: m.content };
  }
  if (modelAcceptsImages(model)) {
    return { role: "user", content: m.content, images: m.images.slice(0, 3) };
  }
  const notice = "[系統提示：當前所選模型為純文字模型，已略過圖片輸入]";
  const content = m.content.includes("已略過圖片輸入") ? m.content : `${notice}\n${m.content}`;
  return { role: "user", content };
}

function geminiPartsForMessage(m: ChatMessage, model: ModelInfo): Array<Record<string, unknown>> {
  const resolved = resolveUserForUpstream(m, model);
  const parts: Array<Record<string, unknown>> = [];
  if (resolved.content) parts.push({ text: resolved.content });
  for (const img of resolved.images ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  if (!parts.length) parts.push({ text: "" });
  return parts;
}

/** Chat Completions API：text + image_url 物件 */
function openAiContentForMessage(
  m: ChatMessage,
  model: ModelInfo,
): string | Array<Record<string, unknown>> {
  const resolved = resolveUserForUpstream(m, model);
  if (!resolved.images?.length) return resolved.content;
  return [
    { type: "text", text: resolved.content || " " },
    ...resolved.images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    })),
  ];
}

/** Responses API（Codex／Grok）：input_text + input_image（image_url 為字串） */
function responsesContentForMessage(
  m: ChatMessage,
  model: ModelInfo,
): string | Array<Record<string, unknown>> {
  const resolved = resolveUserForUpstream(m, model);
  if (!resolved.images?.length) return resolved.content;
  return [
    { type: "input_text", text: resolved.content || " " },
    ...resolved.images.map((img) => ({
      type: "input_image",
      image_url: `data:${img.mimeType};base64,${img.data}`,
      detail: "auto",
    })),
  ];
}

function anthropicContentForMessage(
  m: ChatMessage,
  model: ModelInfo,
): string | Array<Record<string, unknown>> {
  const resolved = resolveUserForUpstream(m, model);
  if (!resolved.images?.length) return resolved.content;
  return [
    ...resolved.images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
    })),
    { type: "text", text: resolved.content || " " },
  ];
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: Usage };

/**
 * 跨供應商快取黏著鍵：聊天 conversationId／會議室 sessionId 優先。
 * ChatGPT Codex 看 session-id 標頭；xAI 看 prompt_cache_key／x-grok-conv-id；
 * Gemini Antigravity 看 request.sessionId；Claude 則靠 cache_control＋穩定前綴。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 會進 HTTP 標頭：必須純 ASCII；統一成 Codex CLI 慣用的 UUID 形狀 */
export function resolvePromptCacheKey(affinityId: string | undefined, fallbackSeed: string): string {
  const a = affinityId?.trim();
  if (a && UUID_RE.test(a)) return a.toLowerCase();
  const h = createHash("sha256").update(a ? `aff:${a}` : `seed:${fallbackSeed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Antigravity 既有格式：負數字串；改由親和鍵穩定派生，避免每輪亂數打散快取 */
export function antigravityStableSessionId(affinityKey: string): string {
  const n = createHash("sha256").update(`ag:${affinityKey}`).digest().readUIntBE(0, 6);
  return `-${n}`;
}

/** 未指定 effort 一律視為 low */
export function normalizeEffort(effort?: ModelInfo["effort"]): "low" | "medium" | "high" {
  if (effort === "medium" || effort === "high") return effort;
  return "low";
}

/**
 * 思考預算：永遠正整數（嚴禁 0）。
 * Claude via Antigravity 強制 thinking；傳 0／省略會失控或腰斬可見輸出。
 * low=1024／medium=2048／high=4096
 */
export function thinkingBudgetFor(effort?: ModelInfo["effort"]): number {
  const e = normalizeEffort(effort);
  if (e === "medium") return 2048;
  if (e === "high") return 4096;
  return 1024;
}

/**
 * 總輸出上限（thinking + 可見文字）。
 * 必須明顯大於 thinkingBudget，避免 HTML 被 thoughts 吃光後腰斬空白。
 * low=8192／medium=10240／high=12288
 */
export function maxOutputTokensFor(effort?: ModelInfo["effort"]): number {
  const e = normalizeEffort(effort);
  if (e === "medium") return 10240;
  if (e === "high") return 12288;
  return 8192;
}

/** Antigravity／Gemini：永遠帶正整數 thinkingBudget + 充足 maxOutputTokens */
function geminiGenerationConfig(effort?: ModelInfo["effort"]): Record<string, unknown> {
  return {
    maxOutputTokens: maxOutputTokensFor(effort),
    thinkingConfig: {
      thinkingBudget: thinkingBudgetFor(effort),
      includeThoughts: true,
    },
  };
}

/** Codex／Grok／OpenAI：未指定一律 low */
export function reasoningEffortFor(effort?: ModelInfo["effort"]): "low" | "medium" | "high" {
  return normalizeEffort(effort);
}

/** 診斷：列出上游目錄中 claude／gemini 開頭的 wire id */
function logAntigravityCatalogIds(available: AntigravityCatalog): void {
  const ids = Object.keys(available)
    .filter((id) => /^(claude|gemini)/i.test(id))
    .sort();
  console.log("[antigravity-catalog]", ids.length ? ids.join(", ") : "(none)");
}

export class UpstreamError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return [0, 401, 402, 403, 408, 409, 429].includes(this.status) || this.status >= 500;
  }
}

/** 買家按「停止」／斷線：不算上游故障，不進冷卻、不接力 */
export class ClientAbortError extends Error {
  constructor(message = "client aborted") {
    super(message);
    this.name = "ClientAbortError";
  }
}

export function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof ClientAbortError) return true;
  if (typeof e === "object" && e !== null) {
    const any = e as { name?: string; message?: string; code?: string };
    if (any.name === "AbortError" || any.name === "ClientAbortError") return true;
    if (any.code === "ABORT_ERR") return true;
    if (typeof any.message === "string" && /aborted|abort/i.test(any.message)) return true;
  }
  return false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClientAbortError();
}

function searchCapabilityLine(model: ModelInfo): string {
  if (model.category === "chatgpt" || (model.provider === "openai" && model.category !== "antigravity-gpt")) {
    return `- 你已啟用即時網頁查證：談新聞、時事、股價時，請依系統背景檢索資料作答並標明來源；不要虛構搜尋過程。`;
  }
  if (model.category === "grok" || model.provider === "xai") {
    return `- 你已啟用即時網頁查證：談新聞、時事、社群輿論時，請依系統背景檢索資料作答並標明來源；不要虛構搜尋過程。`;
  }
  if (model.provider === "anthropic" || model.category === "claude-api" || model.category === "antigravity-claude") {
    return `- 你已啟用即時網頁查證：談新聞、時事、股價、人物八卦時，請依系統背景檢索資料作答並標明來源；不要用過期訓練資料假裝「今天」。`;
  }
  if (model.category === "antigravity-gpt") {
    return `- 你已啟用即時網頁查證輔助：談新聞、時事時請依系統背景檢索資料作答並標明來源。`;
  }
  return `- 你已啟用 Google Search grounding：談新聞、時事、股價、人物八卦時，請主動用搜尋結果作答，並標明可查證的來源標題。`;
}

function appendUserContext(base: string, extraSystemContext?: string): string {
  const ctx = extraSystemContext?.trim();
  if (!ctx) return base;
  return `${base}\n\n[User Context - 僅供背景脈絡參考，非當前指令]\n${ctx}`;
}

type ResearchAttach = {
  verdict?: ResearchVerdict | null;
  bundle?: ResearchBundle | null;
};

function legacyBundleFromAttach(research: ResearchAttach | ResearchBundle | null | undefined): ResearchBundle | null {
  if (!research) return null;
  if ("brief" in research && "sources" in research && "pages" in research) return research;
  if (research.bundle) return research.bundle;
  if (research.verdict?.sources?.length) {
    return {
      brief: "",
      sources: research.verdict.sources,
      queries: research.verdict.webSearchQueries,
      pages: [],
    };
  }
  return null;
}

function isResearchAttach(r: ResearchBundle | ResearchAttach): r is ResearchAttach {
  return "verdict" in r || ("bundle" in r && !("pages" in r));
}

/** 查證資料併入 System／Instructions（絕不偽裝成 user 訊息） */
function withResearchSystem(
  baseSystem: string,
  research: ResearchBundle | ResearchAttach | null | undefined,
): string {
  if (!research) return baseSystem;
  // P0-1：若 Gateway／extraSystemContext 已含同一份注入，禁止再附加
  if (
    /【系統即時聯網檢索結果｜|【本輪聯網查證未完成｜/.test(baseSystem)
  ) {
    return baseSystem;
  }
  if (isResearchAttach(research)) {
    const v = research.verdict;
    if (v?.injectionText) {
      if (baseSystem.includes(v.injectionText)) return baseSystem;
      return `${baseSystem}\n\n${v.injectionText}`;
    }
    if (research.bundle) return `${baseSystem}\n\n${formatResearchInjection(research.bundle)}`;
    return baseSystem;
  }
  return `${baseSystem}\n\n${formatResearchInjection(research)}`;
}

/**
 * @param customSystemPrompt 外部 API（/api/v1）客戶端 system／developer 合併結果；
 *   若有值則優先作為上游 System，不套用網頁版下載卡片等引導詞。
 * @param styleOverrideContext 使用者語氣／排版覆蓋；接在預設【說話方式】【排版】（或 custom）之後，
 *   且「絕對不」包進「非當前指令」。
 */
export function systemPromptFor(
  model: ModelInfo,
  upstreamId: string,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
): string {
  const custom = customSystemPrompt?.trim();
  let base: string;
  if (custom) {
    base = custom.slice(0, 20_000);
  } else {
    const brand =
      model.category === "chatgpt"
        ? "OpenAI ChatGPT"
        : model.category === "grok"
          ? "xAI Grok"
          : model.category.startsWith("antigravity")
            ? "Google Antigravity"
            : model.provider === "anthropic"
              ? "Anthropic Claude"
              : "Google Gemini";
    base = [
      `你是 ${brand} 的「${model.label}」（上游代號 ${upstreamId}）。`,
      `若使用者問你是誰／哪個模型，請據實回答上述名稱與代號，不要否認或改稱成其他產品名。`,
      `請使用繁體中文回答，除非使用者使用其他語言。`,
      ``,
      `【說話方式】`,
      `- 像會聊天的資深顧問，不是寫論文或新聞稿。先給結論，再視需要展開。`,
      `- 不要長篇開場白、不要情緒緩衝、不要硬湊「三種可能性」長文；不確定就直接說不確定，並反問來源。`,
      `- 閒聊就短回；深度分析再用標題與條列拆解，避免文字高牆。`,
      `- 遇到需要推理的題目，先在內部思考再給答案；思考過程可能會顯示給使用者看。`,
      ``,
      `【排版】`,
      `- 使用 Markdown：##／### 標題、**粗體**、條列（-）、編號清單（1.）、表格。`,
      `- 比較／數據優先用表格；程式用 fenced code block。`,
      `- 你無法輸出 Cursor 的 GenerateWidget／LMDX 互動元件；改以 Markdown 表格或清晰條列呈現。`,
      `- 引用外部來源時，請用 Markdown 短連結：\`[網站名或簡短標題](https://完整網址)\`，不要把帶一長串 utm 參數的裸 URL 直接貼在句中。`,
      ``,
      `【可下載檔案】`,
      `- 當使用者上傳檔案要求修改回傳、或要求你產出可下載的檔案（如 CSV/Excel 表格、Markdown 報告、HTML 網頁、JSON、程式碼等）時，請務必將完整檔案內容包在三個反引號的程式碼區塊內，並在第一行標註檔名，格式為：\`\`\`語言:檔名.副檔名（例如 \`\`\`csv:修改後報表.csv 或 \`\`\`html:index.html）。`,
      `- 若使用者要求製作小遊戲、互動工具、視覺化圖表或網頁示範，請優先輸出單一完整的 HTML 檔案（將 CSS 與 JavaScript 內嵌於同一個檔案中），並標註為 \`\`\`html:preview.html，以便前端直接渲染互動預覽。`,
      `- 產出單頁 HTML 預覽時，請保持 CSS 與 JS 結構緊湊精煉（目標控制在 220 行以內），避免冗長重複樣式與無用註解，以兼顧載入速度與精準度。`,
      ``,
      `【即時查證】`,
      searchCapabilityLine(model),
      `- 系統後台具備自動聯網檢索能力（當判定需要外部即時資訊時，系統會自動將檢索結果注入於背景提示中）。若本輪未注入檢索資料，代表問題屬於通用專業知識與架構設計，請直接以你的專業知識庫完整解答，切勿向使用者抱怨「我沒有即時瀏覽工具」或「我無法上網」。`,
      `- 若本輪 System 已附上即時檢索結果：請直接整理回答並附來源連結；禁止要求使用者另行貼連結，禁止說「這不是已完成的即時查詢」或「我無法自行搜尋」。`,
      `- 若前幾輪對話中你已引用即時檢索回答了最新時事數據，後續追問時請維持前後文事實連貫，切勿因為當輪歷史訊息經過摘要壓縮而懷疑自己上一輪的查證結果並主動撤回。`,
      `- 若歷史中曾出現撤回／「未證實」語氣，但本輪已有新的檢索注入，以本輪檢索為準重新作答，不要延續撤回。`,
      `- 搜尋不到就直說「查無可靠來源」，不要硬編三種猜測長文。`,
    ].join("\n");
  }
  // 語氣覆蓋緊接在預設說話方式／排版（或 custom）之後；事實背景仍走「非當前指令」
  base = appendStyleOverride(base, styleOverrideContext);
  return appendUserContext(base, extraSystemContext);
}

/**
 * 把 System 拆成「跨輪固定的前段」與「本輪變動的背景」（狀態摘要、跨對話提問、即時查證）。
 * `${stable}\n\n${volatile}` 與 withResearchSystem(systemPromptFor(...), research) 完全相同；
 * 變動段改放在對話歷史之後，請求開頭才能跨輪一致、命中上游 prompt cache。
 */
export function splitSystemPromptForCache(
  model: ModelInfo,
  upstreamId: string,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  research?: ResearchBundle | ResearchAttach | null,
): { stable: string; volatile: string } {
  const stable = systemPromptFor(model, upstreamId, undefined, customSystemPrompt, styleOverrideContext);
  const volatile = withResearchSystem(appendUserContext("", extraSystemContext), research).trim();
  return { stable, volatile };
}

/** 變動背景以 developer 訊息插在本輪 user 之前（Responses API） */
function withDeveloperContextBeforeLast<T extends { role: string }>(
  input: T[],
  volatile: string,
): Array<T | { role: "developer"; content: Array<{ type: "input_text"; text: string }> }> {
  const dev = { role: "developer" as const, content: [{ type: "input_text" as const, text: volatile }] };
  const last = input[input.length - 1];
  if (!last || last.role !== "user") return [...input, dev];
  return [...input.slice(0, -1), dev, last];
}

/** 依帳號實際目錄解析要送出的 Antigravity wire id（選哪個就打哪個） */
type AntigravityCatalog = Awaited<ReturnType<typeof fetchAntigravityAvailableModels>>;

/** 帳號目錄沒有該模型：屬於「模型不適用此帳號」，不是帳號故障（不可冷卻帳號） */
export class ModelNotInCatalogError extends UpstreamError {
  constructor(message: string) {
    super(404, message);
  }
}

/** sourceId → 最近一次 Antigravity 目錄（供串流／Auto／gateway 共用，避免每請求重抓） */
const antigravityCatalogBySource = new Map<string, { catalog: AntigravityCatalog; at: number }>();
const CATALOG_CACHE_TTL_MS = 30 * 60_000;

function rememberAntigravityCatalog(sourceId: string, available: AntigravityCatalog): void {
  if (Object.keys(available).length) {
    antigravityCatalogBySource.set(sourceId, { catalog: available, at: Date.now() });
  }
}

async function loadAntigravityCatalog(
  sourceId: string,
  creds: OAuthCredentials,
  opts?: { force?: boolean },
): Promise<AntigravityCatalog> {
  if (!opts?.force) {
    const cached = antigravityCatalogBySource.get(sourceId);
    if (cached && Date.now() - cached.at <= CATALOG_CACHE_TTL_MS && Object.keys(cached.catalog).length) {
      return cached.catalog;
    }
  }
  const catalog = await fetchAntigravityAvailableModels(creds, { allowDailyFallback: false });
  rememberAntigravityCatalog(sourceId, catalog);
  return catalog;
}

/** true＝已知此貨源目錄沒有該模型；未抓過目錄或已過期一律回 false（交給實際請求判斷） */
export function sourceCatalogLacksModel(sourceId: string, model: ModelInfo): boolean {
  const cached = antigravityCatalogBySource.get(sourceId);
  if (!cached || Date.now() - cached.at > CATALOG_CACHE_TTL_MS) return false;
  return pickAntigravityWireId(Object.keys(cached.catalog), model) === null;
}

function resolveAntigravityWireId(available: AntigravityCatalog, model: ModelInfo): string {
  const ids = Object.keys(available);
  if (ids.length === 0) return model.antigravityId ?? model.id;
  const wire = pickAntigravityWireId(ids, model);
  if (wire) return wire;
  throw new ModelNotInCatalogError(
    `此訂閱帳號目前沒有開放「${model.label}」（目錄無 ${model.antigravityId ?? model.id}）。請改選帳號實際可用的 Gemini 模型。`,
  );
}

function pickAntigravityWireId(allIds: string[], model: ModelInfo): string | null {
  const preferred = model.antigravityId ?? model.id;
  // 禁止落到 *-trial 降智路徑
  const ids = allIds.filter((id) => !/-trial$/i.test(id));
  if (ids.includes(preferred)) return preferred;

  const fallbacks: Record<string, string[]> = {
    "gemini-4-neon-xhigh": ["gemini-4-neon-xhigh"],
    "gemini-4-neon-high": ["gemini-4-neon-high"],
    "gemini-4-neon-medium": ["gemini-4-neon-medium"],
    "gemini-4-neon-low": ["gemini-4-neon-low"],
    "gemini-4-carbon-high": ["gemini-4-carbon-high"],
    "gemini-4-carbon-medium": ["gemini-4-carbon-medium"],
    "gemini-4-carbon-low": ["gemini-4-carbon-low"],
    "gemini-4-hydrogen-xhigh": ["gemini-4-hydrogen-xhigh"],
    "gemini-4-hydrogen-high": ["gemini-4-hydrogen-high"],
    "gemini-4-hydrogen-medium": ["gemini-4-hydrogen-medium"],
    "gemini-4-hydrogen-low": ["gemini-4-hydrogen-low"],
    "gemini-4-argon-high": ["gemini-4-argon-high"],
    "gemini-4-argon-medium": ["gemini-4-argon-medium"],
    "gemini-4-argon-low": ["gemini-4-argon-low"],
    "gemini-3.8-flash-high": ["gemini-3.8-flash-high"],
    "gemini-3.8-flash-medium": ["gemini-3.8-flash-medium"],
    "gemini-3.8-flash-low": ["gemini-3.8-flash-low"],
    "gemini-3.5-flash-lite": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
    "gemini-3.1-pro": ["gemini-3.1-pro-high", "gemini-pro-agent", "gemini-3.1-pro-low", "gemini-3.1-pro"],
    "agy-claude-sonnet-5-5-low": ["claude-sonnet-5-5-low"],
    "agy-claude-sonnet-5-5-medium": ["claude-sonnet-5-5-medium"],
    "agy-claude-sonnet-5-5-high": ["claude-sonnet-5-5-high"],
    "agy-claude-opus-5-5-low": ["claude-opus-5-5-low"],
    "agy-claude-opus-5-5-medium": ["claude-opus-5-5-medium"],
    "agy-claude-opus-5-5-high": ["claude-opus-5-5-high"],
    "agy-gpt-oss-120b-medium": ["gpt-oss-120b-medium"],
  };
  for (const cand of fallbacks[model.id] ?? [preferred]) {
    if (ids.includes(cand)) return cand;
  }
  return null;
}

export const BASE_URL = {
  gemini: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
  openai: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  anthropic: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
  xai: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  openrouter: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
};

async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      throwIfAborted(signal);
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) throw new ClientAbortError();
        throw e;
      }
      const { done, value } = read;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  throwIfAborted(signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw new ClientAbortError();
    throw new UpstreamError(0, e instanceof Error ? e.message : "network error");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(res.status, text.slice(0, 500) || res.statusText);
  }
  return res;
}

async function ensureFreshOAuth(sourceId: string, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (creds.expiresAt && creds.expiresAt - Date.now() < 5 * 60_000 && creds.refreshToken) {
    const refreshed = await refreshOAuthCredentials(creds);
    await saveUpdatedOAuthCreds(sourceId, refreshed);
    return refreshed;
  }
  return creds;
}

function isGeminiAuthError(err: UpstreamError): boolean {
  const msg = err.message.toLowerCase();
  return (
    err.status === 401 ||
    err.status === 403 ||
    /unsupported state|unable to authenticate|unauthenticated|invalid.?grant|invalid.?token|token.?expired/i.test(
      msg,
    )
  );
}

function humanizeGeminiAuthError(err: UpstreamError): UpstreamError {
  if (!isGeminiAuthError(err)) return err;
  return new UpstreamError(
    401,
    "Gemini 訂閱授權已失效或專案狀態異常。請到「供給者貨源 /sources」重新連結 Google 帳號後再試。",
  );
}

async function forceRefreshGeminiOAuth(sourceId: string, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) {
    throw new UpstreamError(401, "缺少 refresh_token，請到 /sources 重新連結 Google。");
  }
  let next = await refreshOAuthCredentials(creds);
  try {
    const meta = await bootstrapGeminiAccount(next.accessToken);
    next = {
      ...next,
      projectId: meta.projectId || next.projectId,
      email: meta.email ?? next.email,
      planType: meta.planType || next.planType,
    };
  } catch {
    // 專案 bootstrap 失敗仍先用新 token 再試一次
  }
  await saveUpdatedOAuthCreds(sourceId, next);
  return next;
}

// === 1. Google Gemini AI Pro / Ultra 訂閱 OAuth (Antigravity Cloud Code) ===
async function* geminiSubscriptionStream(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  let creds = await ensureFreshOAuth(c.source.id, c.oauthCreds!);
  try {
    yield* geminiSubscriptionStreamOnce(
      c,
      model,
      messages,
      creds,
      signal,
      extraSystemContext,
      customSystemPrompt,
      styleOverrideContext,
      cacheAffinityId,
    );
    return;
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, e instanceof Error ? e.message : String(e));
    if (!isGeminiAuthError(err) || !creds.refreshToken) throw humanizeGeminiAuthError(err);
  }
  // Token／專案失效：強制 refresh + 重抓 projectId，再試一次
  creds = await forceRefreshGeminiOAuth(c.source.id, creds);
  try {
    yield* geminiSubscriptionStreamOnce(
      c,
      model,
      messages,
      creds,
      signal,
      extraSystemContext,
      customSystemPrompt,
      styleOverrideContext,
      cacheAffinityId,
    );
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, e instanceof Error ? e.message : String(e));
    throw humanizeGeminiAuthError(err);
  }
}

function supportsNativeGoogleSearch(upstreamModel: string, model: ModelInfo): boolean {
  // Google Search grounding 僅 Gemini 家族可原生掛載；Claude／GPT-OSS 改走搜尋輔助
  if (/claude|gpt-oss|grok/i.test(upstreamModel)) return false;
  if (model.provider === "gemini") return true;
  return /^gemini/i.test(upstreamModel) || Boolean(model.antigravityId?.startsWith("gemini"));
}

function needsAntigravitySearchAssist(model: ModelInfo, upstreamModel: string): boolean {
  return (
    Boolean(model.antigravityId) &&
    (/claude|gpt-oss/i.test(upstreamModel) ||
      model.category === "antigravity-claude" ||
      model.category === "antigravity-gpt")
  );
}

function mergeGroundingMetadata(
  usage: Usage,
  meta: {
    webSearchQueries?: string[];
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
  } | null | undefined,
) {
  if (!meta) return;
  if (Array.isArray(meta.webSearchQueries) && meta.webSearchQueries.length) {
    const prev = new Set(usage.webSearchQueries ?? []);
    for (const q of meta.webSearchQueries) if (q) prev.add(q);
    usage.webSearchQueries = [...prev];
  }
  if (Array.isArray(meta.groundingChunks)) {
    const map = new Map((usage.groundingSources ?? []).map((s) => [s.uri, s]));
    for (const chunk of meta.groundingChunks) {
      const uri = chunk.web?.uri?.trim();
      if (!uri) continue;
      map.set(uri, { uri, title: (chunk.web?.title || uri).trim() });
    }
    usage.groundingSources = [...map.values()];
  }
}

function mergeGroundingSources(
  usage: Usage,
  sources: { title: string; uri: string }[],
  queries?: string[],
) {
  if (sources.length) {
    const map = new Map((usage.groundingSources ?? []).map((s) => [s.uri, s]));
    for (const s of sources) {
      const uri = s.uri?.trim();
      if (!uri) continue;
      map.set(uri, { uri, title: (s.title || uri).trim() });
    }
    usage.groundingSources = [...map.values()];
  }
  if (queries?.length) {
    const prev = new Set(usage.webSearchQueries ?? []);
    for (const q of queries) if (q) prev.add(q);
    usage.webSearchQueries = [...prev];
  }
}

function extractUrlCitations(obj: unknown): { title: string; uri: string }[] {
  const out: { title: string; uri: string }[] = [];
  const walk = (v: unknown) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const type = String(o.type ?? o.annotation_type ?? "");
    const uri = String(o.url ?? o.uri ?? o.href ?? "").trim();
    if ((/url_citation|citation|web/i.test(type) || o.url || o.uri) && /^https?:\/\//i.test(uri)) {
      out.push({ uri, title: String(o.title ?? o.name ?? uri).trim() });
    }
    for (const val of Object.values(o)) {
      if (val && typeof val === "object") walk(val);
    }
  };
  walk(obj);
  const map = new Map(out.map((s) => [s.uri, s]));
  return [...map.values()];
}

function applyResearchBundle(usage: Usage, bundle: ResearchBundle) {
  mergeGroundingSources(
    usage,
    [
      ...bundle.sources,
      ...bundle.pages.map((p) => ({ title: p.title, uri: p.uri })),
    ],
    bundle.queries,
  );
}

async function researchForMessages(
  messages: ChatMessage[],
  signal?: AbortSignal,
  prefer?: { sourceId: string; creds: OAuthCredentials },
): Promise<ResearchAttach> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!lastUser.trim()) return { verdict: null, bundle: null };

  // 平台 Gateway 已跑過一次 → 禁止供給路徑再搜（避免重複成本）
  const prepared = reusePreparedResearch();
  if (prepared) {
    return { verdict: prepared, bundle: verdictToLegacyBundle(prepared) };
  }

  if (isResearchPipelineV2Enabled()) {
    try {
      const verdict = await runResearchPipelineV2({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        prefer,
        signal,
        supplyPath: "local",
      });
      return { verdict, bundle: verdictToLegacyBundle(verdict) };
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e instanceof ClientAbortError ? e : new ClientAbortError();
      return { verdict: null, bundle: null };
    }
  }

  // 回退 V1
  if (shouldSkipLiveResearch(lastUser)) return { verdict: null, bundle: null };
  const query = buildContextualResearchQuery(messages) || lastUser.trim();
  try {
    const bundle = await runLiveResearch(query, { prefer, signal });
    return { verdict: null, bundle };
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e instanceof ClientAbortError ? e : new ClientAbortError();
    return { verdict: null, bundle: null };
  }
}

async function* geminiSubscriptionStreamOnce(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  creds: OAuthCredentials,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  const catalogBefore = await loadAntigravityCatalog(c.source.id, creds);
  logAntigravityCatalogIds(catalogBefore);
  const upstreamModel = resolveAntigravityWireId(catalogBefore, model);
  const remainingBefore = catalogBefore[upstreamModel]?.remainingFraction;
  const projectId = creds.projectId || `bright-spark-${c.source.id.slice(0, 5)}`;
  const withSearch = supportsNativeGoogleSearch(upstreamModel, model);

  const assistUsage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: geminiPartsForMessage(m, model),
  }));
  // Claude／GPT-OSS：自研查證注入 System（不塞 user，避免角色錯亂）
  let researchAttach: ResearchAttach = { verdict: null, bundle: null };
  if (needsAntigravitySearchAssist(model, upstreamModel)) {
    researchAttach = await researchForMessages(messages, signal, {
      sourceId: c.source.id,
      creds,
    });
    if (researchAttach.bundle) applyResearchBundle(assistUsage, researchAttach.bundle);
    else if (researchAttach.verdict?.sources?.length) {
      applyResearchBundle(assistUsage, {
        brief: "",
        sources: researchAttach.verdict.sources,
        queries: researchAttach.verdict.webSearchQueries,
        pages: [],
      });
    }
  }

  const effort = normalizeEffort(model.effort);
  const generationConfig = geminiGenerationConfig(effort);
  const affinity = resolvePromptCacheKey(
    cacheAffinityId,
    `${c.source.id}\n${upstreamModel}\n${projectId}`,
  );
  const requestBody: Record<string, unknown> = {
    sessionId: antigravityStableSessionId(affinity),
    systemInstruction: {
      role: "user",
      parts: [
        {
          text: withResearchSystem(
            systemPromptFor(model, upstreamModel, extraSystemContext, customSystemPrompt, styleOverrideContext),
            researchAttach,
          ),
        },
      ],
    },
    contents,
    generationConfig,
  };
  if (withSearch) {
    requestBody.tools = [{ googleSearch: {} }];
  }

  const envelope = {
    project: projectId,
    model: upstreamModel,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request: requestBody,
  };

  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    "User-Agent": GEMINI_OAUTH.userAgent,
    Accept: "text/event-stream",
  };

  // 訂閱 OAuth 打 Antigravity Hub（dailyHost）——與 UI 剩餘 % 同一池。
  // 勿改打 cloudcode-pa（Gemini CLI 池），否則會出現「還剩 97% 卻 429」。
  const url = `${GEMINI_OAUTH.dailyHost}/v1internal:streamGenerateContent?alt=sse`;
  let res: Response;
  try {
    res = await post(url, headers, envelope, signal);
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, String(e));
    // 400 降級：可拿掉 googleSearch／把 budget 壓回 1024；嚴禁刪光 thinkingConfig
    if (err.status === 400) {
      const gc = requestBody.generationConfig as Record<string, unknown>;
      const stripSteps: Array<() => void> = [];
      if (withSearch) stripSteps.push(() => delete requestBody.tools);
      stripSteps.push(() => {
        gc.maxOutputTokens = Math.max(8192, maxOutputTokensFor(effort));
        gc.thinkingConfig = {
          thinkingBudget: 1024,
          includeThoughts: true,
        };
      });
      let recovered: Response | null = null;
      let last400 = err;
      for (const strip of stripSteps) {
        strip();
        try {
          recovered = await post(url, headers, envelope, signal);
          break;
        } catch (e2) {
          last400 = e2 instanceof UpstreamError ? e2 : new UpstreamError(0, String(e2));
          if (last400.status !== 400) break;
        }
      }
      if (recovered) {
        res = recovered;
      } else if (last400.status === 429) {
        throw new UpstreamError(
          429,
          `此訂閱帳號的「${model.label}」暫時受限（速率／短時鎖定），訂閱剩餘 % 仍可能很高。請稍後再試或換模型。`,
        );
      } else {
        throw last400;
      }
    } else if (err.status === 429) {
      throw new UpstreamError(
        429,
        `此訂閱帳號的「${model.label}」暫時受限（速率／短時鎖定），訂閱剩餘 % 仍可能很高。請稍後再試或換模型。`,
      );
    } else {
      throw err;
    }
  }

  const usage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    upstreamModelId: upstreamModel,
    viaDailyBypass: false,
    groundingSources: assistUsage.groundingSources,
    webSearchQueries: assistUsage.webSearchQueries,
  };
  for await (const data of sseData(res, signal)) {
    if (!data || data === "[DONE]") continue;
    const json = JSON.parse(data);
    const payload = json.response ?? json;
    if (payload.error) {
      const msg = String(payload.error.message ?? "Gemini stream error");
      const code = Number(payload.error.code) || 500;
      const status = /unsupported state|unable to authenticate|unauthenticated/i.test(msg) ? 401 : code;
      throw new UpstreamError(status, msg);
    }
    if (typeof payload.modelVersion === "string" && payload.modelVersion) {
      usage.upstreamModelVersion = payload.modelVersion;
    }
    const candidate = payload.candidates?.[0];
    mergeGroundingMetadata(usage, candidate?.groundingMetadata ?? payload.groundingMetadata);
    // 舊模型下架時 API 仍可能 200，但正文是「請改用 xxx」——當成錯誤，避免誤扣／誤導
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text !== "string" || !part.text.length) continue;
      if (/is no longer available|請改用|Please switch to/i.test(part.text) && usage.inputTokens === 0) {
        throw new UpstreamError(404, part.text.slice(0, 200));
      }
      // Claude／Gemini：thought:true 為思考過程，其餘為可見回覆
      if (part.thought === true) yield { type: "thinking", text: part.text };
      else yield { type: "text", text: part.text };
    }
    const u = payload.usageMetadata;
    if (u) {
      usage.inputTokens = u.promptTokenCount ?? usage.inputTokens;
      usage.cachedInputTokens = u.cachedContentTokenCount ?? usage.cachedInputTokens;
      usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || usage.outputTokens;
    }
  }

  // 額度 % 延遲反映：不阻塞 done；背景刷新目錄＋同步 UI 額度
  if (typeof remainingBefore === "number") {
    usage.quotaLabel = catalogBefore[upstreamModel]?.displayName ?? upstreamModel;
    usage.quotaRemainingBeforePct = Math.round(remainingBefore * 10000) / 100;
  }
  yield { type: "usage", usage };
  if (process.env.SUPPLIER_NODE_MODE !== "1") {
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const catalogAfter = await loadAntigravityCatalog(c.source.id, creds, { force: true });
        void catalogAfter;
      } catch {
        /* ignore */
      }
      try {
        await syncSourceQuotaById(c.source.id);
      } catch {
        /* ignore */
      }
    })();
  }
}

// === 2. OpenAI ChatGPT Plus / Pro 訂閱 OAuth (Codex Backend) ===
async function* chatgptSubscriptionStream(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  const creds = await ensureFreshOAuth(c.source.id, c.oauthCreds!);
  const upstreamModel = model.codexId ?? model.id;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    originator: "Codex Desktop",
    "x-openai-internal-codex-residency": "us",
    "User-Agent": CHATGPT_OAUTH.userAgent,
    "OpenAI-Beta": "responses_websockets=2026-02-06",
    Accept: "text/event-stream",
  };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

  // 自研查證注入 System 層級（instructions／developer）；絕不掛載上游原生 web_search（避免雙重上網爆 tokens）
  const research = await researchForMessages(messages, signal);
  const input: { role: string; content: string | Array<Record<string, unknown>> }[] = messages.map(
    (m) => ({
      role: m.role,
      content: responsesContentForMessage(m, model),
    }),
  );
  const { stable, volatile } = splitSystemPromptForCache(
    model,
    upstreamModel,
    extraSystemContext,
    customSystemPrompt,
    styleOverrideContext,
    research,
  );

  // ChatGPT Codex：快取親和看 HTTP `session-id`（連字號），不是 body 的 prompt_cache_key
  const cacheKey = resolvePromptCacheKey(
    cacheAffinityId,
    `${creds.accountId ?? c.source.id}\n${upstreamModel}\n${stable}`,
  );
  headers["session-id"] = cacheKey;
  headers["conversation-id"] = cacheKey;
  // turn-state 依「對話 affinity + 本供給來源」分鍵：票根不能跨 ChatGPT 帳號重用
  const priorTurnState = await loadCodexTurnState(cacheKey, c.source.id);
  if (priorTurnState) headers["x-codex-turn-state"] = priorTurnState;

  const body: Record<string, unknown> = {
    model: upstreamModel,
    instructions: stable,
    input: volatile ? withDeveloperContextBeforeLast(input, volatile) : input,
    stream: true,
    store: false, // 強制無痕：絕不寫入供給者的 ChatGPT 歷史對話列表
    reasoning: { effort: reasoningEffortFor(model.effort), summary: "auto" },
    prompt_cache_key: cacheKey,
  };

  const diagHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 10);
  const diagInput = body.input as unknown[];
  const cacheDiag = {
    model: upstreamModel,
    affinity: cacheAffinityId ? "given" : "fallback",
    sessionId: cacheKey.slice(0, 24),
    turnState: priorTurnState ? "sent" : "none",
    instr: diagHash(body.instructions),
    instrChars: String(body.instructions ?? "").length,
    items: diagInput.length,
    roles: diagInput.map((m) => String((m as { role?: string }).role ?? "?")[0]).join(""),
    prefix: [1, 2, 4, 8, 16].filter((n) => n < diagInput.length).map((n) => `${n}:${diagHash(diagInput.slice(0, n))}`),
  };

  let res: Response;
  try {
    res = await post(`${CHATGPT_OAUTH.codexBaseUrl}/codex/responses`, headers, body, signal);
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, String(e));
    if (err.status === 400 && body.prompt_cache_key && /prompt_cache_key/i.test(err.message)) {
      delete body.prompt_cache_key;
      res = await post(`${CHATGPT_OAUTH.codexBaseUrl}/codex/responses`, headers, body, signal);
    } else if (err.status === 400 && volatile && body.input !== input) {
      console.warn("[chatgpt] developer context rejected; fallback to instructions", err.message.slice(0, 200));
      body.instructions = `${stable}\n\n${volatile}`;
      body.input = input;
      res = await post(`${CHATGPT_OAUTH.codexBaseUrl}/codex/responses`, headers, body, signal);
    } else if (err.status === 400 && body.tools) {
      delete body.tools;
      res = await post(`${CHATGPT_OAUTH.codexBaseUrl}/codex/responses`, headers, body, signal);
    } else {
      throw err;
    }
  }

  const nextTurnState = res.headers.get("x-codex-turn-state");
  if (nextTurnState) void saveCodexTurnState(cacheKey, c.source.id, nextTurnState);

  // 從回傳 Header 即時讀取最新訂閱進度條 %（含 reset-at／window-minutes）
  const headerWindow = (
    usedHeader: string,
    minutesHeader: string,
    resetHeader: string,
    fallback: "5h" | "7d",
  ): QuotaWindow | null => {
    const usedRaw = res.headers.get(usedHeader);
    if (usedRaw === null) return null;
    const used = Math.round(Number(usedRaw) * 10) / 10;
    if (!Number.isFinite(used)) return null;
    const minutesRaw = res.headers.get(minutesHeader);
    const minutes = minutesRaw != null ? Number(minutesRaw) : NaN;
    const secs =
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : fallback === "5h" ? 18_000 : 604_800;
    const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
    const resetRaw = res.headers.get(resetHeader);
    const resetNum = resetRaw != null ? Number(resetRaw) : NaN;
    return {
      label: chatGptWindowLabel(secs, fallback),
      usedPercent: used,
      remainingPercent: rem,
      uiRemainingPercent: Math.round(rem),
      uiUsedPercent: Math.round(used),
      resetAt: Number.isFinite(resetNum)
        ? resolveChatGptResetAt({ reset_at: resetNum })
        : null,
      modelKey: "chatgpt",
      limitWindowSeconds: secs,
    };
  };
  const headerWindows = [
    headerWindow(
      "x-codex-primary-used-percent",
      "x-codex-primary-window-minutes",
      "x-codex-primary-reset-at",
      "5h",
    ),
    headerWindow(
      "x-codex-secondary-used-percent",
      "x-codex-secondary-window-minutes",
      "x-codex-secondary-reset-at",
      "7d",
    ),
  ].filter((w): w is QuotaWindow => Boolean(w));
  if (headerWindows.length) {
    // 仍依秒數辨識：Team 方案 primary 可能是週視窗
    headerWindows.sort(
      (a, b) => (a.limitWindowSeconds ?? 1e12) - (b.limitWindowSeconds ?? 1e12),
    );
    const primary = pickChatGptPrimaryWindow(headerWindows)!;
    const snap: SubscriptionQuota = {
      planType: (creds.planType ?? "pro").toUpperCase(),
      email: creds.email,
      windows: headerWindows,
      primaryUsedPercent: primary.uiUsedPercent,
      primaryRemainingPercent: primary.uiRemainingPercent,
      fetchedAt: Date.now(),
    };
    await saveSourceQuota(c.source.id, snap);
  }

  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, upstreamModelId: upstreamModel };
  const researchBundle = legacyBundleFromAttach(research);
  if (researchBundle) applyResearchBundle(usage, researchBundle);
  for await (const data of sseData(res, signal)) {
    if (!data || data === "[DONE]") break;
    const json = JSON.parse(data);
    if (json.type === "response.output_text.delta" && json.delta) {
      yield { type: "text", text: json.delta };
    } else if (
      (json.type === "response.reasoning_summary_text.delta" ||
        json.type === "response.reasoning.delta" ||
        json.type === "response.reasoning_text.delta") &&
      json.delta
    ) {
      const t = typeof json.delta === "string" ? json.delta : json.delta?.text;
      if (t) yield { type: "thinking", text: t };
    } else if (
      json.type === "response.web_search_call.in_progress" ||
      json.type === "response.web_search_call.searching" ||
      json.type === "response.web_search_call.completed" ||
      json.type === "response.output_item.done" ||
      json.type === "response.output_text.annotation.added"
    ) {
      const cites = extractUrlCitations(json);
      if (cites.length) mergeGroundingSources(usage, cites);
      const q =
        json.action?.query ||
        json.item?.action?.query ||
        (Array.isArray(json.action?.queries) ? json.action.queries.join(" · ") : null);
      if (typeof q === "string" && q) mergeGroundingSources(usage, [], [q]);
    } else if (json.type === "response.completed") {
      const cites = extractUrlCitations(json.response ?? json);
      if (cites.length) mergeGroundingSources(usage, cites);
      if (json.response?.usage) {
        const u = json.response.usage;
        usage.inputTokens = u.input_tokens ?? 0;
        usage.cachedInputTokens = u.input_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
        usage.outputTokens = (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0);
        console.info("[cache-diag]", JSON.stringify({ ...cacheDiag, usage: u }));
      }
    } else if (json.type === "codex.rate_limits" && json.rate_limits?.primary) {
      const toWin = (
        raw: {
          used_percent?: number | string;
          window_minutes?: number;
          reset_at?: number;
        },
        fallback: "5h" | "7d",
      ): QuotaWindow | null => {
        const usedRaw =
          typeof raw.used_percent === "number"
            ? raw.used_percent
            : typeof raw.used_percent === "string"
              ? Number(raw.used_percent)
              : NaN;
        if (!Number.isFinite(usedRaw)) return null;
        const used = Math.round(usedRaw * 10) / 10;
        const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
        const secs =
          typeof raw.window_minutes === "number" && raw.window_minutes > 0
            ? raw.window_minutes * 60
            : fallback === "5h"
              ? 18_000
              : 604_800;
        return {
          label: chatGptWindowLabel(secs, fallback),
          usedPercent: used,
          remainingPercent: rem,
          uiRemainingPercent: Math.round(rem),
          uiUsedPercent: Math.round(used),
          resetAt: resolveChatGptResetAt({ reset_at: raw.reset_at ?? null }),
          modelKey: "chatgpt",
          limitWindowSeconds: secs,
        };
      };
      const windows = [
        toWin(json.rate_limits.primary, "5h"),
        json.rate_limits.secondary ? toWin(json.rate_limits.secondary, "7d") : null,
      ].filter((w): w is QuotaWindow => Boolean(w));
      windows.sort((a, b) => (a.limitWindowSeconds ?? 1e12) - (b.limitWindowSeconds ?? 1e12));
      if (windows.length) {
        const primary = pickChatGptPrimaryWindow(windows)!;
        await saveSourceQuota(c.source.id, {
          planType: (creds.planType ?? "pro").toUpperCase(),
          email: creds.email,
          windows,
          primaryUsedPercent: primary.uiUsedPercent,
          primaryRemainingPercent: primary.uiRemainingPercent,
          fetchedAt: Date.now(),
        });
      }
    } else if (json.type === "response.failed" || json.type === "error") {
      const errObj = json.error ?? json.response?.error ?? json;
      throw new UpstreamError(Number(errObj.status_code ?? errObj.status ?? 429), errObj.message ?? "Codex error");
    }
  }
  yield { type: "usage", usage };
  if (process.env.SUPPLIER_NODE_MODE !== "1") {
    try {
      await syncSourceQuotaById(c.source.id);
    } catch {
      // 同步失敗不阻斷對話結果
    }
  }
}

// === 3. xAI Grok / SuperGrok 訂閱 OAuth（CLI chat proxy）===
async function* grokSubscriptionStream(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  const creds = await ensureFreshOAuth(c.source.id, c.oauthCreds!);
  const upstreamModel = model.grokId ?? model.id;
  const cacheKey = resolvePromptCacheKey(cacheAffinityId, `${c.source.id}\n${upstreamModel}`);
  const headers: Record<string, string> = {
    ...grokProxyHeaders(creds.accessToken),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-grok-conv-id": cacheKey,
  };

  // 自研查證注入 Instructions；不掛載上游 web_search／x_search（平台統一控制查證）
  const research = await researchForMessages(messages, signal);
  const input: { role: string; content: string | Array<Record<string, unknown>> }[] = messages.map(
    (m) => ({
      role: m.role,
      content: responsesContentForMessage(m, model),
    }),
  );

  const body: Record<string, unknown> = {
    model: upstreamModel,
    instructions: withResearchSystem(
      systemPromptFor(model, upstreamModel, extraSystemContext, customSystemPrompt, styleOverrideContext),
      research,
    ),
    input,
    stream: true,
    store: false,
    reasoning: { effort: reasoningEffortFor(model.effort) },
    prompt_cache_key: cacheKey,
  };
  const url = `${GROK_OAUTH.proxyBaseUrl}/responses`;
  let res: Response;
  try {
    res = await post(url, headers, body, signal);
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, String(e));
    if (err.status === 400) {
      const stripSteps: Array<() => void> = [];
      if (body.tools) stripSteps.push(() => delete body.tools);
      if (body.reasoning) stripSteps.push(() => delete body.reasoning);
      let recovered: Response | null = null;
      let last400 = err;
      for (const strip of stripSteps) {
        strip();
        try {
          recovered = await post(url, headers, body, signal);
          break;
        } catch (e2) {
          last400 = e2 instanceof UpstreamError ? e2 : new UpstreamError(0, String(e2));
          if (last400.status !== 400) break;
        }
      }
      if (!recovered) throw last400;
      res = recovered;
    } else {
      throw err;
    }
  }
  const usage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    upstreamModelId: upstreamModel,
  };
  {
    const b = legacyBundleFromAttach(research);
    if (b) applyResearchBundle(usage, b);
  }
  for await (const data of sseData(res, signal)) {
    if (!data || data === "[DONE]") break;
    const json = JSON.parse(data);
    if (
      (json.type === "response.output_text.delta" || json.type === "response.output_text.delta.done") &&
      json.delta
    ) {
      const t = typeof json.delta === "string" ? json.delta : json.delta?.text;
      if (t) yield { type: "text", text: t };
    } else if (json.type === "response.content_part.delta" && json.delta?.text) {
      yield { type: "text", text: json.delta.text };
    } else if (
      (json.type === "response.reasoning_summary_text.delta" ||
        json.type === "response.reasoning.delta" ||
        json.type === "response.reasoning_text.delta" ||
        json.type === "response.reasoning_summary_part.delta") &&
      json.delta
    ) {
      const t =
        typeof json.delta === "string"
          ? json.delta
          : json.delta?.text || json.delta?.reasoning || json.delta?.summary;
      if (typeof t === "string" && t) yield { type: "thinking", text: t };
    } else if (
      /web_search|x_search|annotation|output_item\.done/i.test(String(json.type ?? ""))
    ) {
      const cites = extractUrlCitations(json);
      if (cites.length) mergeGroundingSources(usage, cites);
      const q =
        json.action?.query ||
        json.item?.action?.query ||
        (Array.isArray(json.action?.queries) ? json.action.queries.join(" · ") : null);
      if (typeof q === "string" && q) mergeGroundingSources(usage, [], [q]);
    } else if (json.type === "response.completed") {
      const cites = extractUrlCitations(json.response ?? json);
      if (cites.length) mergeGroundingSources(usage, cites);
      if (json.response?.usage) {
        const u = json.response.usage;
        usage.inputTokens = u.input_tokens ?? 0;
        usage.cachedInputTokens = u.input_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
        usage.outputTokens =
          (u.output_tokens ?? 0) + (u.output_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0);
      }
      if (json.response?.model) usage.upstreamModelVersion = String(json.response.model);
    } else if (json.type === "response.failed" || json.type === "error") {
      const errObj = json.error ?? json.response?.error ?? json;
      throw new UpstreamError(Number(errObj.status_code ?? errObj.status ?? 429), errObj.message ?? "Grok error");
    }
  }
  yield { type: "usage", usage };
  if (process.env.SUPPLIER_NODE_MODE !== "1") {
    try {
      await syncSourceQuotaById(c.source.id);
    } catch {
      // ignore
    }
  }
}

// === 4. Google Gemini API Key (AI Studio) ===
async function* geminiApiKeyStream(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  _cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  // Gemini 4／新模型：隱式快取自動開啟；穩定前綴即可（explicit cachedContents 不支援 Gemini 4）
  const apiModel = model.geminiApiId ?? model.id;
  const res = await post(
    `${BASE_URL.gemini}/models/${apiModel}:streamGenerateContent?alt=sse&key=${encodeURIComponent(c.apiKey!)}`,
    {},
    {
      systemInstruction: {
        parts: [{ text: systemPromptFor(model, apiModel, extraSystemContext, customSystemPrompt, styleOverrideContext) }],
      },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: geminiPartsForMessage(m, model),
      })),
      tools: [{ googleSearch: {} }],
      generationConfig: geminiGenerationConfig(model.effort),
    },
    signal,
  );
  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, upstreamModelId: apiModel };
  for await (const data of sseData(res, signal)) {
    if (!data || data === "[DONE]") continue;
    const json = JSON.parse(data);
    const candidate = json.candidates?.[0];
    mergeGroundingMetadata(usage, candidate?.groundingMetadata ?? json.groundingMetadata);
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text !== "string" || !part.text) continue;
      if (part.thought === true) yield { type: "thinking", text: part.text };
      else yield { type: "text", text: part.text };
    }
    if (json.usageMetadata) {
      usage.inputTokens = json.usageMetadata.promptTokenCount ?? usage.inputTokens;
      usage.cachedInputTokens =
        json.usageMetadata.cachedContentTokenCount ?? usage.cachedInputTokens;
      usage.outputTokens =
        (json.usageMetadata.candidatesTokenCount ?? 0) + (json.usageMetadata.thoughtsTokenCount ?? 0) ||
        usage.outputTokens;
    }
  }
  yield { type: "usage", usage };
}

// === 4. OpenAI / OpenRouter API Key ===
async function* openaiCompatible(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  safetyId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  const isOpenRouter = c.source.provider === "openrouter";
  const isXai = c.source.provider === "xai";
  const base = isOpenRouter ? BASE_URL.openrouter : isXai ? BASE_URL.xai : BASE_URL.openai;
  const upstream = isOpenRouter ? model.openrouterId : model.grokId ?? model.id;
  const url = `${base}/chat/completions`;
  const cacheKey = resolvePromptCacheKey(cacheAffinityId, `${c.source.id}\n${upstream}`);
  // 自研查證注入 system（外層 Gateway 已跑過則透過 ALS 零成本重用；未跑過如 failover 亦可補齊）
  const research = await researchForMessages(messages, signal);
  const body: Record<string, unknown> = {
    model: upstream,
    messages: [
      {
        role: "system",
        content: withResearchSystem(
          systemPromptFor(model, upstream, extraSystemContext, customSystemPrompt, styleOverrideContext),
          research,
        ),
      },
      ...messages.map((m) => ({ role: m.role, content: openAiContentForMessage(m, model) })),
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  // OpenRouter／部分推理模型、xAI：帶上 reasoning effort
  body.reasoning = { effort: reasoningEffortFor(model.effort) };
  if (isXai) body.reasoning_effort = reasoningEffortFor(model.effort);
  if (isOpenRouter) {
    body.user = safetyId;
    body.include_reasoning = true;
  } else if (!isXai) {
    body.store = false;
    body.safety_identifier = safetyId;
    body.prompt_cache_key = cacheKey;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${c.apiKey}` };
  if (isXai) {
    headers["x-grok-conv-id"] = cacheKey;
    body.prompt_cache_key = cacheKey;
  }
  const res = await post(url, headers, body, signal);

  const usage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    upstreamModelId: upstream,
  };
  {
    const b = legacyBundleFromAttach(research);
    if (b) applyResearchBundle(usage, b);
  }

  for await (const data of sseData(res, signal)) {
    if (data === "[DONE]") break;
    const json = JSON.parse(data);
    if (json.error) throw new UpstreamError(Number(json.error.code) || 500, json.error.message ?? "stream error");
    const delta = json.choices?.[0]?.delta;
    const thinking =
      delta?.reasoning_content || delta?.reasoning || delta?.reasoning_text || json.choices?.[0]?.delta?.reasoning;
    if (typeof thinking === "string" && thinking) yield { type: "thinking", text: thinking };
    const text = delta?.content;
    if (text) yield { type: "text", text };
    const cites = extractUrlCitations(delta ?? json);
    if (cites.length) mergeGroundingSources(usage, cites);
    if (json.usage) {
      usage.inputTokens = json.usage.prompt_tokens ?? usage.inputTokens;
      usage.cachedInputTokens = json.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedInputTokens;
      usage.outputTokens = json.usage.completion_tokens ?? usage.outputTokens;
    }
  }
  yield { type: "usage", usage };
}

// === 5. Anthropic API Key ===
async function* anthropic(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  safetyId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  _cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  const effort = normalizeEffort(model.effort);
  const budget = thinkingBudgetFor(effort);
  // 自研查證注入 system；不掛載上游 web_search／web_fetch（平台統一控制查證）
  const research = await researchForMessages(messages, signal);
  const systemText = withResearchSystem(
    systemPromptFor(model, model.id, extraSystemContext, customSystemPrompt, styleOverrideContext),
    research,
  );
  const wireMessages = messages.map((m) => ({
    role: m.role,
    content: anthropicContentForMessage(m, model),
  }));
  // 在最後一則 user／可見內容加上 cache breakpoint，讓多輪前綴可被讀取
  if (wireMessages.length) {
    const last = wireMessages[wireMessages.length - 1]!;
    if (typeof last.content === "string") {
      last.content = [
        { type: "text", text: last.content || " ", cache_control: { type: "ephemeral" } },
      ];
    } else if (Array.isArray(last.content) && last.content.length) {
      const block = last.content[last.content.length - 1]!;
      block.cache_control = { type: "ephemeral" };
    }
  }

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxOutputTokensFor(effort),
    system: [
      {
        type: "text",
        text: systemText,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: wireMessages,
    stream: true,
    metadata: { user_id: safetyId },
    // 永遠正整數 budget（與 Antigravity 對齊；max_tokens > budget_tokens）
    thinking: { type: "enabled", budget_tokens: budget },
  };
  let res: Response;
  try {
    res = await post(
      `${BASE_URL.anthropic}/messages`,
      {
        "x-api-key": c.apiKey!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14,prompt-caching-2024-07-31",
      },
      body,
      signal,
    );
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(0, String(e));
    // 舊帳號／代理不吃 cache_control 時降級重試，避免整輪失敗
    if (err.status === 400 && /cache_control|prompt.cach/i.test(err.message)) {
      body.system = systemText;
      body.messages = messages.map((m) => ({
        role: m.role,
        content: anthropicContentForMessage(m, model),
      }));
      res = await post(
        `${BASE_URL.anthropic}/messages`,
        {
          "x-api-key": c.apiKey!,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
        body,
        signal,
      );
    } else {
      throw err;
    }
  }

  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, upstreamModelId: model.id };
  {
    const b = legacyBundleFromAttach(research);
    if (b) applyResearchBundle(usage, b);
  }
  for await (const data of sseData(res, signal)) {
    const json = JSON.parse(data);
    switch (json.type) {
      case "message_start": {
        const u = json.message?.usage ?? {};
        usage.cachedInputTokens = u.cache_read_input_tokens ?? 0;
        usage.inputTokens = (u.input_tokens ?? 0) + usage.cachedInputTokens + (u.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start": {
        const block = json.content_block;
        if (block?.type === "web_search_tool_result" || block?.type === "web_search_tool_use") {
          const cites = extractUrlCitations(block);
          if (cites.length) mergeGroundingSources(usage, cites);
          const q = block?.input?.query;
          if (typeof q === "string" && q) mergeGroundingSources(usage, [], [q]);
        }
        break;
      }
      case "content_block_delta":
        if (json.delta?.type === "thinking_delta" && json.delta.thinking) {
          yield { type: "thinking", text: json.delta.thinking };
        } else if (json.delta?.type === "text_delta" && json.delta.text) {
          yield { type: "text", text: json.delta.text };
        } else if (json.delta?.type === "citations_delta" || json.delta?.citation) {
          const cites = extractUrlCitations(json.delta);
          if (cites.length) mergeGroundingSources(usage, cites);
        }
        break;
      case "message_delta":
        usage.outputTokens = json.usage?.output_tokens ?? usage.outputTokens;
        break;
      case "error":
        throw new UpstreamError(json.error?.type === "overloaded_error" ? 529 : 500, json.error?.message ?? "stream error");
    }
  }
  yield { type: "usage", usage };
}

/**
 * 平台端上游串流（僅官方 API Key／研究用 OAuth）。
 * 買家正式任務優先走 Node Agent（見 gateway）；此處不轉發任意 URL、不做指紋偽裝。
 */
export function streamFrom(
  c: Candidate,
  model: ModelInfo,
  messages: ChatMessage[],
  safetyId: string,
  signal?: AbortSignal,
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<StreamEvent> {
  assertE2EOrPass("providers.streamFrom");
  if (c.source.authType === "oauth_sub") {
    // 研究／相容路徑：平台持有的訂閱 OAuth（與 Node Agent 買家任務隔離）
    if (c.source.provider === "gemini" && model.antigravityId) {
      return geminiSubscriptionStream(
        c,
        model,
        messages,
        signal,
        extraSystemContext,
        customSystemPrompt,
        styleOverrideContext,
        cacheAffinityId,
      );
    }
    if (c.source.provider === "openai") {
      return chatgptSubscriptionStream(
        c,
        model,
        messages,
        signal,
        extraSystemContext,
        customSystemPrompt,
        styleOverrideContext,
        cacheAffinityId,
      );
    }
    if (c.source.provider === "xai") {
      return grokSubscriptionStream(
        c,
        model,
        messages,
        signal,
        extraSystemContext,
        customSystemPrompt,
        styleOverrideContext,
        cacheAffinityId,
      );
    }
  }
  if (c.source.provider === "gemini") {
    return geminiApiKeyStream(
      c,
      model,
      messages,
      signal,
      extraSystemContext,
      customSystemPrompt,
      styleOverrideContext,
      cacheAffinityId,
    );
  }
  if (c.source.provider === "anthropic") {
    return anthropic(
      c,
      model,
      messages,
      safetyId,
      signal,
      extraSystemContext,
      customSystemPrompt,
      styleOverrideContext,
      cacheAffinityId,
    );
  }
  return openaiCompatible(
    c,
    model,
    messages,
    safetyId,
    signal,
    extraSystemContext,
    customSystemPrompt,
    styleOverrideContext,
    cacheAffinityId,
  );
}
