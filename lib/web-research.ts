/**
 * 層 1＋層 2 共用查證：Google Search grounding → 讀取原文摘錄。
 * 讓 Claude／GPT／Grok 也能拿到接近 Gemini 原生 grounding 的素材。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GEMINI_OAUTH,
  bootstrapGeminiAccount,
  fetchAntigravityAvailableModels,
  refreshOAuthCredentials,
  type OAuthCredentials,
} from "./oauth";
import { listSources, readOAuthCreds, saveUpdatedOAuthCreds } from "./sources";

export type ResearchSource = { title: string; uri: string };
export type ResearchPage = {
  title: string;
  uri: string;
  excerpt: string;
  publishedAt?: string;
  originalUrl?: string;
  resolvedUrl?: string;
  fetchStatus?: "ok" | "failed" | "skipped" | "unresolved" | "blocked_ssrf";
  /** 快照相對路徑（若 RESEARCH_HTML_SNAPSHOT_DIR 有設） */
  htmlPath?: string;
  htmlSha256?: string;
};
export type ResearchBundle = {
  brief: string;
  sources: ResearchSource[];
  queries: string[];
  pages: ResearchPage[];
};

const SEARCH_SYSTEM = [
  "你是即時網頁查證助理（對齊 Gemini Google Search grounding）。",
  "若問題涉及人物、事件、傳聞、新聞、數據、時事、查證、論壇／社群討論、策略分享、評價推薦、行情勝率——必須使用 Google Search。",
  "用繁中條列關鍵事實（≤12 行）：每點寫清「誰／做了什麼／何時」，並附來源標題；查無可靠來源就明確寫「查無可靠來源」。",
  "優先官方新聞室、投資人公告、路透／美聯社／BBC／大型報紙；不要把維基百科、YouTube、網站導覽當主要依據。",
  "若使用者明確要求上網、搜尋、爬文、查一下、找看看——一律必須搜尋，禁止回覆 NO_SEARCH。",
  "若純屬閒聊、創作、程式除錯、且與外部事實完全無關——只回覆一行：NO_SEARCH",
  "不要長篇推論，不要編造。",
].join("\n");

/** 口語化／明確要求聯網或找外部即時資訊的意圖 */
const WEB_RESEARCH_INTENT_RE =
  /上網|網路|网上|网上搜|爬文|搜一下|查一下|找看看|搜尋|搜索|查證|google|googling|瀏覽|浏览|大神|分享|評價|评价|推薦|推荐|災情|灾情|PTT|Dcard|Reddit|Threads|最新|現況|现况|勝率|胜率|行情|股市|新聞|新闻|股價|股价|今天|今日|明天|明日|時事|时事|論壇|论坛|八卦|傳聞|传闻|誰贏|谁赢|選舉|选举|天氣|天气|匯率|汇率/i;

async function ensureFresh(sourceId: string, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (creds.expiresAt && creds.expiresAt - Date.now() < 5 * 60_000 && creds.refreshToken) {
    const refreshed = await refreshOAuthCredentials(creds);
    await saveUpdatedOAuthCreds(sourceId, refreshed);
    return refreshed;
  }
  return creds;
}

function mergeSources(into: ResearchSource[], extra: ResearchSource[]) {
  const map = new Map(into.map((s) => [s.uri, s]));
  for (const s of extra) {
    const uri = s.uri?.trim();
    if (!uri) continue;
    map.set(uri, { uri, title: (s.title || uri).trim() });
  }
  return [...map.values()];
}

function parseGrounding(meta: {
  webSearchQueries?: string[];
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  groundingSupports?: unknown[];
} | null | undefined): {
  sources: ResearchSource[];
  queries: string[];
  rawGroundingSupports: unknown[];
} {
  const sources: ResearchSource[] = [];
  const queries: string[] = [];
  const rawGroundingSupports: unknown[] = [];
  if (!meta) return { sources, queries, rawGroundingSupports };
  if (Array.isArray(meta.webSearchQueries)) {
    for (const q of meta.webSearchQueries) if (q) queries.push(q);
  }
  if (Array.isArray(meta.groundingChunks)) {
    for (const chunk of meta.groundingChunks) {
      const uri = chunk.web?.uri?.trim();
      if (!uri) continue;
      sources.push({ uri, title: (chunk.web?.title || uri).trim() });
    }
  }
  if (Array.isArray(meta.groundingSupports)) {
    for (const s of meta.groundingSupports) rawGroundingSupports.push(s);
  }
  return { sources, queries, rawGroundingSupports };
}

/** 寫入 raw groundingSupports 備查檔（search_synthesis 延後；本函式只記錄） */
export function persistRawGroundingSupportsLog(entry: {
  at: string;
  provider: string;
  queryPreview: string;
  supportCount: number;
  rawGroundingSupports: unknown[];
}): void {
  try {
    const dir = path.join(process.cwd(), "docs", "live-e2e");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "flash-grounding-supports.jsonl");
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 記錄失敗不阻斷主路徑
  }
}

/** 注入主模型的查證全文硬上限（字元）；摘要＋來源＋各篇摘錄合計（相對舊值 3600 放寬 1 倍） */
export const MAX_RESEARCH_TOTAL_CHARS = 7200;
/** 單篇淨化後正文上限（相對舊值 900 放寬 1 倍） */
export const MAX_PAGE_CHARS = 1800;
/** 層 2 最多抓取篇數（優先不同網域） */
export const MAX_RESEARCH_PAGES = 3;
/** Flash 搜尋摘要上限（相對舊值 700 放寬 1 倍） */
export const MAX_RESEARCH_BRIEF_CHARS = 1400;

const FINANCE_KEEP_RE = /\d|%|\$|億|萬|元|EPS|YoY|QoQ/i;
const JUNK_NAV_RE =
  /訂閱|下載\s*App|下載App|更多新聞|延伸閱讀|相關新聞|熱門新聞|分享到|追蹤我們|廣告刊登|加入會員|立即註冊|看更多|上一則|下一則/i;
const BYLINE_ONLY_RE = /^(記者|編譯|撰稿).{0,24}(報導|撰文)?$|綜合報導|本報訊|中央社|版權所有|著作權所有|copyright/i;

/**
 * 清洗台媒／入口站 HTML strip 後的導覽短行與垃圾列，保留段落內文與財報短句。
 */
export function cleanArticleText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.replace(/[ \t]+/g, " ").trim();
    if (!t) continue;

    // 獨立短行：導覽／署名／版權（不誤殺長導言裡夾「記者…報導」的段落）
    if (t.length < 35 && (JUNK_NAV_RE.test(t) || BYLINE_ONLY_RE.test(t))) continue;

    // 破碎短行且無句號：多半是選單；含數字／財經符號則保留
    const hasSentenceEnd = /[。！？.!?…]/.test(t);
    if (t.length < 20 && !hasSentenceEnd && !FINANCE_KEEP_RE.test(t)) continue;

    kept.push(t);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hostnameOf(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
}

/** 百科／影音首頁：抓原文時降權，優先新聞與官方站 */
const LOW_PRIORITY_HOST_RE =
  /(^|\.)(wikipedia\.org|wikidata\.org|britannica\.com|youtube\.com|youtu\.be|bilibili\.com)$/i;

/** 官方／主流媒體：抓取與挑選時優先 */
const PREFERRED_HOST_RE =
  /(nvidianews\.nvidia\.com|(^|\.)nvidia\.com|sec\.gov|reuters\.com|apnews\.com|bloomberg\.com|bbc\.(com|co\.uk)|nytimes\.com|wsj\.com|ft\.com|cnbc\.com|theguardian\.com|cna\.com\.tw|udn\.com|chinatimes\.com|ltn\.com\.tw|storm\.mg|tw\.news\.yahoo\.com|news\.google\.com)/i;

function isLowPriorityHost(host: string): boolean {
  return LOW_PRIORITY_HOST_RE.test(host);
}

function isPreferredHost(host: string): boolean {
  return PREFERRED_HOST_RE.test(host);
}

/** 過濾「只有導覽／Cookie／選單／CSS」的假正文，避免模型以為新聞未核實 */
export function isUsablePageExcerpt(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 120) return false;
  if (/@font-face|font-face\s*\{|skip\s+to\s+(main\s+)?content/i.test(t)) return false;
  const brace = (t.match(/\{/g) || []).length;
  const colonSemi = (t.match(/:[^;]+;/g) || []).length;
  if (brace >= 3 && colonSemi >= 5) return false;
  const navHits = (t.match(/訂閱|下載\s*App|延伸閱讀|相關新聞|熱門新聞|分享到|立即註冊|加入會員|Cookie|Accept all|Sign in|Log in|Skip to/gi) || [])
    .length;
  const sentenceEnds = (t.match(/[。！？.!?]/g) || []).length;
  if (navHits >= 3 && sentenceEnds < 3) return false;
  if (sentenceEnds < 2 && t.length < 360) return false;
  return true;
}

/**
 * 正規化來源 URL：去追蹤參數；可選顯示截斷。
 * Phase 4：預設不插入「…」——截斷會破壞 href／配對鍵。
 * 顯示用短標請用 displaySourceUrl。
 */
export function cleanSourceUrl(uri: string, maxLen = 2048): string {
  try {
    const u = new URL(uri.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid|ref|ref_src|spm|si)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    let out =
      u.search.length > 48 ? `${u.origin}${u.pathname}` : `${u.origin}${u.pathname}${u.search}`;
    if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
    // 僅在明確要求極短顯示時截斷；不加省略號以免被當成可點連結
    if (out.length > maxLen) return out.slice(0, maxLen);
    return out;
  } catch {
    const t = uri.trim();
    return t.length > maxLen ? t.slice(0, maxLen) : t;
  }
}

/** UI 顯示用短網址（可含 …）；不得回傳給 href／sourceId */
export function displaySourceUrl(uri: string, maxLen = 64): string {
  const cleaned = cleanSourceUrl(uri);
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** 優先不同 hostname：官方／主流媒體 → 一般站 → wikipedia／youtube */
export function pickSourcesDiverse(sources: ResearchSource[], limit = MAX_RESEARCH_PAGES): ResearchSource[] {
  const http = sources.filter((s) => /^https?:\/\//i.test(s.uri));
  const rank = (s: ResearchSource) => {
    const host = hostnameOf(s.uri);
    if (isPreferredHost(host)) return 0;
    if (isLowPriorityHost(host)) return 2;
    return 1;
  };
  const sorted = [...http].sort((a, b) => rank(a) - rank(b));
  const preferred = sorted.filter((s) => rank(s) === 0);
  const normal = sorted.filter((s) => rank(s) === 1);
  const demoted = sorted.filter((s) => rank(s) === 2);
  const picked: ResearchSource[] = [];
  const seenHost = new Set<string>();

  const takeDiverse = (pool: ResearchSource[]) => {
    for (const s of pool) {
      if (picked.length >= limit) break;
      const host = hostnameOf(s.uri);
      if (seenHost.has(host)) continue;
      seenHost.add(host);
      picked.push(s);
    }
    for (const s of pool) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.uri === s.uri)) continue;
      picked.push(s);
    }
  };

  takeDiverse(preferred);
  if (picked.length < limit) takeDiverse(normal);
  if (picked.length < limit) takeDiverse(demoted);
  return picked;
}

/** 從 HTML meta／JSON-LD 抽發布時間；抽不到則 undefined（禁止填造） */
export function extractPublishedAtFromHtml(html: string): string | undefined {
  const metaPatterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
    /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:published_time["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const t = Date.parse(m[1]);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }
  const ld = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (ld?.[1]) {
    try {
      const json = JSON.parse(ld[1]) as Record<string, unknown> | Record<string, unknown>[];
      const nodes = Array.isArray(json) ? json : [json, ...(Array.isArray((json as { "@graph"?: unknown })["@graph"]) ? ((json as { "@graph": unknown[] })["@graph"] as Record<string, unknown>[]) : [])];
      for (const n of nodes) {
        if (!n || typeof n !== "object") continue;
        const d = (n.datePublished || n.dateCreated || n.uploadDate) as string | undefined;
        if (d) {
          const t = Date.parse(d);
          if (Number.isFinite(t)) return new Date(t).toISOString();
        }
      }
    } catch {
      // ignore malformed json-ld
    }
  }
  return undefined;
}

/**
 * 層 2：SSRF 安全抓取＋抽可讀正文。
 * 無法安全展開時回傳 fetchStatus，不把 Flash 摘要冒充正文。
 */
export async function fetchPageExcerpt(
  uri: string,
  signal?: AbortSignal,
): Promise<ResearchPage | null> {
  if (!/^https:\/\//i.test(uri)) {
    return {
      uri,
      title: uri,
      excerpt: "",
      originalUrl: uri,
      fetchStatus: "blocked_ssrf",
    };
  }

  const { safeFetchText } = await import("./research-v2/ssrf");
  const fetched = await safeFetchText(uri, { signal, maxBytes: 500_000 });
  if (!fetched.ok || !fetched.body) {
    return {
      uri: fetched.resolvedUrl || uri,
      title: uri,
      excerpt: "",
      originalUrl: uri,
      resolvedUrl: fetched.resolvedUrl,
      fetchStatus: fetched.fetchStatus,
    };
  }

  const html = fetched.body;
  const resolved = fetched.resolvedUrl || uri;
  const htmlSha256 = createHash("sha256").update(html).digest("hex");
  let htmlPath: string | undefined;
  const snapDir = process.env.RESEARCH_HTML_SNAPSHOT_DIR?.trim();
  if (snapDir) {
    try {
      mkdirSync(snapDir, { recursive: true });
      const file = `${htmlSha256.slice(0, 16)}.html`;
      writeFileSync(path.join(snapDir, file), html, "utf8");
      htmlPath = file;
    } catch {
      /* 快照失敗不阻斷 */
    }
  }
  const { extractArticleFromHtml } = await import("./research-v2/article-extract");
  const extracted = extractArticleFromHtml(html, { url: resolved, maxChars: MAX_PAGE_CHARS });
  if (!extracted.isMainBody) {
    return {
      uri: resolved,
      title: extracted.title || uri,
      excerpt: "",
      publishedAt: extracted.publishedAt,
      originalUrl: uri,
      resolvedUrl: resolved,
      fetchStatus: "failed",
      htmlPath,
      htmlSha256,
    };
  }
  return {
    uri: resolved,
    title: extracted.title || uri,
    excerpt: extracted.excerpt,
    publishedAt: extracted.publishedAt,
    originalUrl: uri,
    resolvedUrl: resolved,
    fetchStatus: "ok",
    htmlPath,
    htmlSha256,
  };
}

export async function fetchPagesForSources(
  sources: ResearchSource[],
  signal?: AbortSignal,
  limit = MAX_RESEARCH_PAGES,
): Promise<ResearchPage[]> {
  // 多抓幾候補選：許多新聞站只回導覽殼，需跳過後再補
  const picked = pickSourcesDiverse(sources, Math.min(sources.length, Math.max(limit * 2, limit)));
  const settled = await Promise.allSettled(picked.map((s) => fetchPageExcerpt(s.uri, signal)));
  const pages: ResearchPage[] = [];
  for (let i = 0; i < settled.length; i++) {
    if (pages.length >= limit) break;
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const page = r.value;
    // 僅收可用正文；SSRF／失敗頁不進入 pages（Collector 仍可由 grounding sources 建 title_only）
    if (page.fetchStatus === "ok" && isUsablePageExcerpt(page.excerpt)) {
      pages.push({
        ...page,
        title: page.title || picked[i].title,
      });
    }
  }
  return pages;
}

/**
 * 將剩餘字數均分給各篇，短篇未用完的額度遞補給仍有空間的長篇（單篇 ≤ MAX_PAGE_CHARS）。
 */
export function allocatePageBudgets(
  lengths: number[],
  totalBudget: number,
  perPageCap = MAX_PAGE_CHARS,
): number[] {
  const n = lengths.length;
  if (n === 0) return [];
  const budget = Math.max(0, totalBudget);
  const base = Math.floor(budget / n);
  const caps = lengths.map((len) => Math.min(perPageCap, Math.max(0, len)));
  const used = caps.map((cap) => Math.min(cap, base));
  let leftover = budget - used.reduce((a, b) => a + b, 0);
  // 把整除餘數與短篇釋出的額度，輪流補給還有空間的篇
  let guard = 0;
  while (leftover > 0 && guard++ < n * perPageCap) {
    let progressed = false;
    for (let i = 0; i < n && leftover > 0; i++) {
      const room = caps[i] - used[i];
      if (room <= 0) continue;
      used[i] += 1;
      leftover -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return used;
}

async function searchViaAntigravity(
  creds: OAuthCredentials,
  sourceId: string,
  query: string,
  signal?: AbortSignal,
): Promise<{
  brief: string;
  sources: ResearchSource[];
  queries: string[];
  rawGroundingSupports: unknown[];
} | null> {
  const fresh = await ensureFresh(sourceId, creds);
  if (!fresh.projectId && fresh.accessToken) {
    try {
      const boot = await bootstrapGeminiAccount(fresh.accessToken);
      if (boot.projectId) {
        fresh.projectId = boot.projectId;
        await saveUpdatedOAuthCreds(sourceId, fresh);
      }
    } catch {
      // continue
    }
  }
  const catalog = await fetchAntigravityAvailableModels(fresh, { allowDailyFallback: false });
  const prefer = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-medium",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
  ];
  const ids = Object.keys(catalog).filter((id) => !/-trial$/i.test(id) && /^gemini/i.test(id));
  const searchModel =
    prefer.find((id) => ids.includes(id)) ?? ids.find((id) => /flash/i.test(id)) ?? ids[0];
  if (!searchModel) return null;

  const projectId = fresh.projectId || `bright-spark-${sourceId.slice(0, 5)}`;
  const envelope = {
    project: projectId,
    model: searchModel,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      sessionId: `-${Math.floor(Math.random() * 9_000_000_000_000)}`,
      systemInstruction: { role: "user", parts: [{ text: SEARCH_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: query.slice(0, 4000) }] }],
      generationConfig: { maxOutputTokens: 2048 },
      tools: [{ googleSearch: {} }],
    },
  };

  let res: Response;
  try {
    res = await fetch(`${GEMINI_OAUTH.dailyHost}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fresh.accessToken}`,
        "User-Agent": GEMINI_OAUTH.userAgent,
        Accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let brief = "";
  let sources: ResearchSource[] = [];
  let queries: string[] = [];
  const rawGroundingSupports: unknown[] = [];
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const payload = json.response ?? json;
        const candidate = payload.candidates?.[0];
        const g = parseGrounding(candidate?.groundingMetadata ?? payload.groundingMetadata);
        sources = mergeSources(sources, g.sources);
        for (const q of g.queries) if (!queries.includes(q)) queries.push(q);
        for (const s of g.rawGroundingSupports) rawGroundingSupports.push(s);
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === "string" && part.thought !== true) brief += part.text;
        }
      } catch {
        // ignore
      }
    }
  }

  const trimmed = brief.trim();
  if (!trimmed && !sources.length) return null;
  if (/^NO_SEARCH\b/i.test(trimmed) && !sources.length) return null;
  return { brief: trimmed, sources, queries, rawGroundingSupports };
}

async function searchViaGeminiApiKey(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<{
  brief: string;
  sources: ResearchSource[];
  queries: string[];
  rawGroundingSupports: unknown[];
} | null> {
  const model = process.env.GEMINI_RESEARCH_MODEL?.trim() || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SEARCH_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: query.slice(0, 4000) }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        groundingMetadata?: {
          webSearchQueries?: string[];
          groundingChunks?: { web?: { uri?: string; title?: string } }[];
          groundingSupports?: unknown[];
        };
      }[];
    };
    const candidate = json.candidates?.[0];
    let brief = "";
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.thought !== true) brief += part.text;
    }
    const g = parseGrounding(candidate?.groundingMetadata);
    const trimmed = brief.trim();
    if (!trimmed && !g.sources.length) return null;
    if (/^NO_SEARCH\b/i.test(trimmed) && !g.sources.length) return null;
    return {
      brief: trimmed,
      sources: g.sources,
      queries: g.queries,
      rawGroundingSupports: g.rawGroundingSupports,
    };
  } catch {
    return null;
  }
}

/** 找可用的 Gemini 查證通道（OAuth 訂閱或 API Key） */
export async function resolveResearchChannel(): Promise<
  | { kind: "antigravity"; sourceId: string; creds: OAuthCredentials }
  | { kind: "apiKey"; apiKey: string }
  | null
> {
  for (const s of await listSources()) {
    if (!s.enabled || s.provider !== "gemini" || s.authType !== "oauth_sub") continue;
    const creds = await readOAuthCreds(s.id);
    if (!creds || creds.delegatedToNode) continue;
    if (!creds.accessToken && !creds.refreshToken) continue;
    return { kind: "antigravity", sourceId: s.id, creds };
  }
  const envKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_RESEARCH_API_KEY?.trim();
  if (envKey) return { kind: "apiKey", apiKey: envKey };
  return null;
}

/** 買家明確要求去網路找資料／談時事外部資訊 → 必須跑查證 */
export function needsWebResearch(text: string): boolean {
  return WEB_RESEARCH_INTENT_RE.test(text.trim());
}

type ResearchChatTurn = { role: "user" | "assistant"; content: string };

const SHORT_QUERY_MAX = 25;
const FOLLOWUP_OR_URGE_RE =
  /更新事件|那後來|後來呢|真的嗎|然後呢|還有呢|所以呢|怎麼了|怎样了|最新呢|有新的嗎|有更新嗎|剛說的|上面說|繼續查|再查|查清楚|你查|網路都有|网上都有|上網查|去查|查一下嘛|不是說|你不是|撤回|翻供/i;

function stripUploadPrefix(text: string): string {
  return text.replace(/^\[已上傳[^\]]*\]\n?/, "").trim();
}

const GREETING_ONLY_RE =
  /^(嗨|你好|哈囉|早安|午安|晚安|謝謝|感謝|ok|okay|hi|hello|hey|thanks|thx)[\s!！.。?？]*$/i;

/** 短句追問、代名詞、口語催促 → 必須併入上一輪主題再搜 */
export function isFollowupOrUrgeQuery(text: string): boolean {
  const t = stripUploadPrefix(text);
  if (!t) return false;
  if (GREETING_ONLY_RE.test(t)) return false;
  if (FOLLOWUP_OR_URGE_RE.test(t)) return true;
  if (/^(再|請|请|幫|帮)?(查|搜|找|上網|上网).{0,16}$/i.test(t)) return true;
  // 極短且非裸實體（裸實體另走「最新新聞」補強）→ 當追問
  if (t.length < SHORT_QUERY_MAX && !isBareEntityQuery(t)) return true;
  return false;
}

/** 單純人名／公司／代號（無完整問句） */
export function isBareEntityQuery(text: string): boolean {
  const t = stripUploadPrefix(text);
  if (!t || t.length > 24) return false;
  if (/[?？!！。\n]/.test(t)) return false;
  if (FOLLOWUP_OR_URGE_RE.test(t)) return false;
  if (/^(你|我|請|请|再|查|搜|找|幫|帮|嗨|你好)/.test(t)) return false;
  if (/^[\u4e00-\u9fffA-Za-z0-9·・.\-&\s]{2,24}$/.test(t) && !/是|嗎|么|什麼|什么|如何|怎麼|怎么|為何|为何/.test(t)) {
    return true;
  }
  return false;
}

/** 從最近 1～2 輪擷取主題實體（供短句追問合併搜尋） */
export function extractResearchTopic(messages: ResearchChatTurn[]): string {
  const chron = messages.filter((m) => m.content?.trim());
  let lastUserIdx = -1;
  for (let i = chron.length - 1; i >= 0; i--) {
    if (chron[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return "";

  const prior = chron.slice(Math.max(0, lastUserIdx - 4), lastUserIdx);

  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role !== "user") continue;
    const t = stripUploadPrefix(m.content);
    if (isBareEntityQuery(t)) return t.slice(0, 40);
    if (t.length >= 4 && !isFollowupOrUrgeQuery(t)) {
      return t.split(/[，,。？?！!\n：:]/)[0]!.trim().slice(0, 40);
    }
  }

  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role !== "assistant") continue;
    const head = m.content.slice(0, 600);
    const about = head.match(/關於\s*[「『"]?([^\s」』"，,]{2,24})/);
    if (about?.[1]) return about[1].trim();
    const bold = head.match(/\*\*([^*]{2,28})\*\*/);
    if (bold?.[1]) return bold[1].replace(/[：:].*$/, "").trim().slice(0, 40);
    const heading = head.match(/^#{1,3}\s+(.+)$/m);
    if (heading?.[1]) return heading[1].replace(/[#*_`]/g, "").trim().slice(0, 40);
  }

  const blob = prior.map((m) => m.content.slice(0, 400)).join("\n");
  const hit = blob.match(
    /黃仁勳|黃仁勛|Jensen\s*Huang|輝達|英偉達|NVIDIA|NVDA|OpenAI|微軟|Microsoft|Apple|Google|台積電|TSMC/i,
  );
  return hit?.[0]?.trim() ?? "";
}

const KNOWN_ENTITY_RE =
  /黃仁勳|黃仁勛|Jensen\s*Huang|輝達|英偉達|NVIDIA|NVDA|OpenAI|微軟|Microsoft|Apple|Google|台積電|TSMC|ASML|美聯社|路透/gi;

const EVENT_KEYWORD_RE =
  /辭職|辭任|請辭|離職|暫代|交接|出軌|不倫|調查|董事會|執行長|總裁|CEO|CFO|國安|間諜|復職|股價|法說會|听证|聽證/g;

/** 子議題追問：他的／這件事／出軌事件…（長度可能 >25） */
export function isSubtopicFollowupQuery(text: string): boolean {
  const t = stripUploadPrefix(text);
  if (!t || GREETING_ONLY_RE.test(t)) return false;
  return /他的|她的|其|這件事|該事件|此事|這個消息|剛才說|上面說|那件事|怎麼看|你怎麼看|如何看/.test(t);
}

/** 使用者是否引入與舊主題明顯不同的新實體（換題則不黏） */
function introducesNewEntity(lastUser: string, topic: string): boolean {
  if (!topic) return false;
  const found = lastUser.match(KNOWN_ENTITY_RE) ?? [];
  if (!found.length) return false;
  const topicNorm = topic.toLowerCase();
  return found.some((e) => {
    const n = e.toLowerCase();
    return !topicNorm.includes(n) && !n.includes(topicNorm.slice(0, Math.min(2, topicNorm.length)));
  });
}

/** 從上一輪 assistant／user 抽事件關鍵詞（最多 max 個） */
export function extractEventKeywords(messages: ResearchChatTurn[], max = 3): string[] {
  const chron = messages.filter((m) => m.content?.trim());
  let lastUserIdx = -1;
  for (let i = chron.length - 1; i >= 0; i--) {
    if (chron[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) return [];
  const prior = chron.slice(Math.max(0, lastUserIdx - 3), lastUserIdx);
  const blob = prior
    .map((m) => (m.role === "assistant" ? m.content.slice(0, 800) : stripUploadPrefix(m.content).slice(0, 120)))
    .join("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of blob.matchAll(EVENT_KEYWORD_RE)) {
    const k = m[0];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 組出給 runLiveResearch 的搜尋提示：
 * - 短句／催促／子議題：併入最近主題＋事件關鍵詞
 * - 裸實體名：補「最新新聞／動態／2026」
 * - 偵測到新實體換題：不硬黏舊主題
 */
export function buildContextualResearchQuery(messages: ResearchChatTurn[]): string {
  const lastUser = stripUploadPrefix(
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "",
  );
  if (!lastUser) return "";

  const needContext = isFollowupOrUrgeQuery(lastUser) || isSubtopicFollowupQuery(lastUser);
  const topic =
    needContext || isBareEntityQuery(lastUser) ? extractResearchTopic(messages) : "";

  if (needContext && topic && introducesNewEntity(lastUser, topic)) {
    // 換題：只搜本輪
    if (isBareEntityQuery(lastUser)) return `${lastUser} 最新新聞 最新動態 2026`;
    return lastUser;
  }

  let q = lastUser;
  if (needContext && topic) {
    const topicHint = topic.slice(0, 4);
    if (!lastUser.includes(topicHint)) {
      q = `關於「${topic}」的後續：${lastUser}`;
    }
  }

  if (isBareEntityQuery(lastUser)) {
    q = `${lastUser} 最新新聞 最新動態 2026`;
  } else if (needContext && topic) {
    const events = extractEventKeywords(messages, 3);
    const eventPart = events.length ? `、相關事件（${events.join("、")}）` : "";
    q = `${q}（請查「${topic}」${eventPart}之最新新聞與官方公告 2026；勿只搜子議題而漏掉主事件全貌如辭職／接班）`;
  }

  return q;
}

/**
 * 本地快速判斷：明顯不需上網就不打 Flash／不抓網頁（省 token、省延遲）。
 * 有明確聯網意圖時永不跳過。
 */
export function shouldSkipLiveResearch(text: string): boolean {
  const q = text.trim();
  if (!q) return true;
  // 明確要求聯網／找外部資訊 → 絕不跳過
  if (needsWebResearch(q)) return false;
  // 極短寒暄
  if (q.length <= 24 && /^(嗨|你好|哈囉|早安|午安|晚安|謝謝|感謝|ok|okay|hi|hello|hey|thanks|thx)[\s!！.。?？]*$/i.test(q)) {
    return true;
  }
  // 明顯寫程式／改碼／解釋語法（無時事／聯網意圖）
  if (
    /```|寫一個|幫我寫|refactor|debug|typescript|javascript|python|sql|regex|編譯|報錯|typeerror|syntax|解釋這段程式|這段程式|程式碼|抽取邏輯|只要解釋/i.test(
      q,
    )
  ) {
    return true;
  }
  // 純翻譯／潤飾／改寫（繁簡皆可）
  if (
    /^(请|請)?(幫我)?(翻譯|翻译|润色|潤飾|改寫|改写|纠错|糾錯|摘要一下這段)/i.test(q) ||
    /translate|proofread/i.test(q)
  ) {
    return true;
  }
  return false;
}

/**
 * 僅層 1：Flash／API Key + Google Search grounding。
 * 不抓頁、不做 700 字 brief 截斷——給 Research V2 Collector 用原始 evidence。
 * 注意：brief 仍受 Flash 自身輸出長度限制；URI／title 以 grounding 為準（非完整 SERP）。
 */
export async function fetchLiveResearchSearchHit(
  query: string,
  opts?: {
    prefer?: { sourceId: string; creds: OAuthCredentials };
    signal?: AbortSignal;
  },
): Promise<{
  brief: string;
  sources: ResearchSource[];
  queries: string[];
  provider: string;
  rawGroundingSupports: unknown[];
} | null> {
  const q = query.trim();
  if (!q) return null;
  if (shouldSkipLiveResearch(q)) return null;

  const searchQuery = needsWebResearch(q)
    ? `【必須使用 Google Search，禁止回覆 NO_SEARCH】\n${q}\n【優先】官方新聞室、投資人公告、路透／美聯社／BBC／大型報紙；排除維基百科與 YouTube。`
    : `${q}\n【查證時優先官方與主流媒體新聞，排除維基百科與 YouTube。】`;

  let hit: {
    brief: string;
    sources: ResearchSource[];
    queries: string[];
    rawGroundingSupports: unknown[];
  } | null = null;
  let provider = "unknown";

  if (opts?.prefer) {
    hit = await searchViaAntigravity(opts.prefer.creds, opts.prefer.sourceId, searchQuery, opts.signal);
    if (hit) provider = "antigravity_prefer";
  }
  if (!hit) {
    const ch = await resolveResearchChannel();
    if (!ch) return null;
    if (ch.kind === "antigravity") {
      hit = await searchViaAntigravity(ch.creds, ch.sourceId, searchQuery, opts?.signal);
      provider = "antigravity_pool";
    } else {
      hit = await searchViaGeminiApiKey(ch.apiKey, searchQuery, opts?.signal);
      provider = "gemini_api_key";
    }
  }
  if (!hit) return null;
  if (/^NO_SEARCH\b/i.test(hit.brief) && !hit.sources.length) return null;
  persistRawGroundingSupportsLog({
    at: new Date().toISOString(),
    provider,
    queryPreview: q.slice(0, 160),
    supportCount: hit.rawGroundingSupports.length,
    rawGroundingSupports: hit.rawGroundingSupports,
  });
  return { ...hit, provider };
}

/**
 * 完整查證包（V1 相容）：搜尋（層1）＋讀原文（層2，最多 MAX_RESEARCH_PAGES）。
 * Research V2 請改用 fetchLiveResearchSearchHit + 自行控制 maxPages。
 */
export async function runLiveResearch(
  query: string,
  opts?: {
    prefer?: { sourceId: string; creds: OAuthCredentials };
    signal?: AbortSignal;
  },
): Promise<ResearchBundle | null> {
  const hit = await fetchLiveResearchSearchHit(query, opts);
  if (!hit) return null;

  const pages = await fetchPagesForSources(hit.sources, opts?.signal, MAX_RESEARCH_PAGES);
  return {
    brief: hit.brief,
    sources: hit.sources,
    queries: hit.queries,
    pages,
  };
}

function hostLabel(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./i, "");
  } catch {
    return uri.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || uri;
  }
}

/**
 * 注入主模型 System／Instructions 的查證上下文（非 user 訊息）。
 * 總長 ≤ MAX_RESEARCH_TOTAL_CHARS；來源列標題＋去追蹤參數的乾淨 URL。
 */
export function formatResearchInjection(bundle: ResearchBundle): string {
  const briefRaw = (bundle.brief || "（無摘要）").trim();
  const brief =
    briefRaw.length > MAX_RESEARCH_BRIEF_CHARS
      ? briefRaw.slice(0, MAX_RESEARCH_BRIEF_CHARS - 1).trimEnd() + "…"
      : briefRaw;
  const sourceLines =
    bundle.sources.length > 0
      ? bundle.sources.slice(0, 8).map((s) => {
          const title = s.title || hostLabel(s.uri);
          const url = cleanSourceUrl(s.uri);
          return `- ${title} — ${url}`;
        })
      : [];
  const queryLine = bundle.queries.length ? `搜尋詞：${bundle.queries.join(" · ")}` : "";

  const head = [
    "【系統即時聯網檢索結果（最高優先級事實依據）】",
    "以下為系統剛剛完成的即時搜尋結果（含 2026 年時事）。「搜尋摘要」與「來源列表」本身就是已完成的查證材料。",
    "你的預訓練知識截止於過去；面對最新重大事件，請以本檢索為準，直接整理重點並附來源連結給使用者。",
    "若「網頁要點」為空、或只有導覽殘片：不代表新聞不存在——請依搜尋摘要與來源標題／URL 作答，可註明「全文頁面未能完整抓取」。",
    "禁止：翻供撤回、宣稱沒有搜尋工具、說「這不是已完成的即時查詢」、要求使用者自己去貼連結才肯回答。",
    "若對話歷史曾有撤回／未證實語氣，但本輪已注入新檢索，以本輪檢索重新作答，不要延續撤回。",
    "回覆中不要提及「檢索摘要」「原文摘錄」等內部結構字眼。",
    "",
    "## 搜尋摘要",
    brief,
  ];
  const tail: string[] = [];
  if (sourceLines.length) {
    tail.push("", "## 來源列表", ...sourceLines);
  }
  if (queryLine) {
    tail.push("", queryLine);
  }

  const pages = bundle.pages.slice(0, MAX_RESEARCH_PAGES);
  if (!pages.length) {
    const out = [
      ...head,
      "",
      "## 網頁要點",
      "（原文頁面未能抓取或僅有導覽殼；請直接依上方搜尋摘要與來源列表作答，並附上來源連結。）",
      ...tail,
    ].join("\n");
    return out.length > MAX_RESEARCH_TOTAL_CHARS
      ? out.slice(0, MAX_RESEARCH_TOTAL_CHARS - 1).trimEnd() + "…"
      : out;
  }

  const skeletonWithoutBodies = [
    ...head,
    "",
    "## 網頁要點",
    ...pages.flatMap((p) => [`### ${p.title}`, `來源：${cleanSourceUrl(p.uri)}`, "", ""]),
    ...tail,
  ].join("\n");
  const overhead = skeletonWithoutBodies.length;
  const pageBudgetTotal = Math.max(0, MAX_RESEARCH_TOTAL_CHARS - overhead);
  const budgets = allocatePageBudgets(
    pages.map((p) => p.excerpt.length),
    pageBudgetTotal,
    MAX_PAGE_CHARS,
  );

  const bodyParts = [...head, "", "## 網頁要點"];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const slice = p.excerpt.slice(0, budgets[i] ?? 0);
    bodyParts.push(`### ${p.title}`, `來源：${cleanSourceUrl(p.uri)}`, slice, "");
  }
  bodyParts.push(...tail);

  let out = bodyParts.join("\n");
  if (out.length > MAX_RESEARCH_TOTAL_CHARS) {
    out = out.slice(0, MAX_RESEARCH_TOTAL_CHARS - 1).trimEnd() + "…";
  }
  return out;
}
