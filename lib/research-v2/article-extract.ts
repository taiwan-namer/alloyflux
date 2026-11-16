/**
 * 通用新聞正文抽取與品質閘門（禁止網域特例）。
 * 唯一類別特例：結構化申報文件（以路徑／文件型態判斷，不綁公司）。
 */
import { cleanArticleText, extractPublishedAtFromHtml, isUsablePageExcerpt } from "../web-research";

export type ArticleExtractResult = {
  title: string;
  excerpt: string;
  publishedAt?: string;
  /** 是否足以標成 article_body */
  isMainBody: boolean;
  /** 降級原因 */
  degradeReason?: string;
  /** 文件類型特例 */
  documentKind?: "sec_edgar" | "generic";
};

const TEMPLATE_POLLUTION_RE =
  /skip\s+to\s+(main\s+)?content|sign\s+in|log\s+in|accept\s+all\s+cookies|cookie\s+settings|@font-face|font-face\s*\{|\{[^}]{0,40}font-family|订阅|訂閱本刊|開啟通知|enable\s+notifications|advertisement|promo\s*code/i;

const NAV_SHELL_RE =
  /skip\s+to|main\s+menu|navigation|footer\s+links|related\s+stories|trending|most\s+read|share\s+this|newsletter|sign\s+up/i;

/** 是否為結構化申報文件（SEC EDGAR 等）——依 URL 路徑／內容型態，不依公司名 */
export function isStructuredFilingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === "sec.gov" || host.endsWith(".sec.gov")) {
      if (/\/(archives\/edgar|cgi-bin\/browse-edgar|ix\?doc=)/i.test(path + u.search)) return true;
      if (/\.(htm|html)$/i.test(path) && /\/edgar\//i.test(path)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function looksLikeCssOrTemplatePollution(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (TEMPLATE_POLLUTION_RE.test(t)) return true;
  // 大比例為 CSS 規則
  const brace = (t.match(/\{/g) || []).length;
  const colonSemi = (t.match(/:[^;]+;/g) || []).length;
  if (brace >= 3 && colonSemi >= 5) return true;
  if (/@font-face/i.test(t)) return true;
  // Skip to… 短殼
  if (/^skip to/i.test(t) && t.length < 400) return true;
  if (NAV_SHELL_RE.test(t) && t.length < 280 && (t.match(/[。！？.!?]/g) || []).length < 2) {
    return true;
  }
  // Cookie／隱私同意文案佔主體
  if (
    /cookie|隱私聲明|privacy\s*policy|同意上述規範|accept\s+(all\s+)?cookies/i.test(t) &&
    t.length < 600
  ) {
    return true;
  }
  return false;
}

/**
 * 通用列表／入口頁判定（禁止網域特例）：
 * 連結文字佔比高、短塊重複、缺乏連續長段落。
 */
/** URL 路徑像區塊入口／搜尋（非網域名特例） */
export function looksLikeSectionHubUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 0) return true;
    if (parts.length === 1 && !/\d{4}/.test(parts[0])) {
      return /^(world|news|newsroom|markets|business|technology|politics|sport|sports|search|index|home|briefing-room|money)$/i.test(
        parts[0],
      );
    }
    if (/\/(search|hub)(\/|$)/i.test(u.pathname)) return true;
    if (/\/edgar\/search/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function looksLikeListOrHubPage(
  html: string,
  text: string,
  opts?: { url?: string },
): {
  isList: boolean;
  reason?: string;
  linkTextRatio: number;
  shortBlockRatio: number;
  longParagraphCount: number;
} {
  const fragment = extractMainHtmlFragment(html);
  const withoutTagsForLen = fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const totalChars = Math.max(withoutTagsForLen.length, 1);

  // 連結文字佔比
  let linkChars = 0;
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(fragment)) !== null) {
    linkChars += m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  }
  const linkTextRatio = linkChars / totalChars;

  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const isNoiseLine = (l: string) =>
    TEMPLATE_POLLUTION_RE.test(l) ||
    /^focus taiwan/i.test(l) ||
    /would you like to go to|繁体字版です/i.test(l);

  // 標題列偏短；正文段 ≥55（中英皆可）
  const shortBlocks = lines.filter((l) => l.length > 0 && l.length <= 40 && !isNoiseLine(l));
  const shortBlockRatio = lines.length ? shortBlocks.length / lines.length : 0;
  const longParagraphCount = lines.filter((l) => l.length >= 55 && !isNoiseLine(l)).length;
  const anchorCount = (fragment.match(/<a\b/gi) || []).length;
  const headingCount = (fragment.match(/<h[1-3]\b/gi) || []).length;

  // 短塊長度變異小 → 標題列感
  let lowVarianceTitles = false;
  if (shortBlocks.length >= 6) {
    const lens = shortBlocks.map((l) => l.length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance =
      lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length;
    lowVarianceTitles = variance < 80 && mean <= 36;
  }

  // 高連結密度：即使夾雜少數 cookie 長句仍視為列表
  if (linkTextRatio >= 0.35 && shortBlockRatio >= 0.45) {
    return {
      isList: true,
      reason: "link_and_short_block",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (shortBlockRatio >= 0.7 && linkTextRatio >= 0.25 && longParagraphCount < 3) {
    return {
      isList: true,
      reason: "dominant_short_blocks",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  // 入口 URL + 非單篇散文結構
  if (looksLikeSectionHubUrl(opts?.url) && longParagraphCount < 5 && shortBlockRatio >= 0.25) {
    return {
      isList: true,
      reason: "section_hub_url",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (linkTextRatio >= 0.42 && longParagraphCount < 3) {
    return {
      isList: true,
      reason: "high_link_text_ratio",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (anchorCount >= 20 && headingCount >= 8 && longParagraphCount < 4) {
    return {
      isList: true,
      reason: "many_anchors_and_headings",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  // 有連續正文段且連結低 → 不像列表（保護單篇）
  if (longParagraphCount >= 2 && linkTextRatio < 0.25) {
    return {
      isList: false,
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (shortBlockRatio >= 0.55 && longParagraphCount < 2) {
    return {
      isList: true,
      reason: "short_block_repetition",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (lowVarianceTitles && longParagraphCount < 2) {
    return {
      isList: true,
      reason: "uniform_short_titles",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }
  if (longParagraphCount < 1 && lines.length >= 8 && shortBlockRatio >= 0.4) {
    return {
      isList: true,
      reason: "no_long_paragraph",
      linkTextRatio,
      shortBlockRatio,
      longParagraphCount,
    };
  }

  return {
    isList: false,
    linkTextRatio,
    shortBlockRatio,
    longParagraphCount,
  };
}

/** Readability 風格：優先 article／main，否則最大文字區塊 */
export function extractMainHtmlFragment(html: string): string {
  const withoutChrome = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const articleMatch =
    withoutChrome.match(/<article[\s\S]*?<\/article>/i) ||
    withoutChrome.match(/<main[\s\S]*?<\/main>/i) ||
    withoutChrome.match(/<div[^>]+(?:article-body|story-body|article__body|post-content|entry-content|content--article)[^>]*>[\s\S]*?<\/div>/i);

  const fragment = articleMatch?.[0] || withoutChrome;
  return fragment;
}

function htmlToText(fragment: string): string {
  return fragment
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** SEC／結構化申報：抽可見文字，但若只有 iXBRL／選單則降級 */
function extractFilingText(html: string): string {
  const frag = extractMainHtmlFragment(html);
  let text = htmlToText(frag);
  text = cleanArticleText(text);
  // 去掉大量 ix: 標籤殘留詞
  text = text.replace(/\bix:\w+\b/gi, " ").replace(/\s+/g, " ").trim();
  return text;
}

export function extractArticleFromHtml(
  html: string,
  opts?: { url?: string; titleHint?: string; maxChars?: number },
): ArticleExtractResult {
  const maxChars = opts?.maxChars ?? 1800;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (opts?.titleHint || titleMatch?.[1] || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  const publishedAt = extractPublishedAtFromHtml(html);
  const filing = opts?.url ? isStructuredFilingUrl(opts.url) : false;

  let rawText = filing
    ? extractFilingText(html)
    : cleanArticleText(htmlToText(extractMainHtmlFragment(html)));

  // 截斷前先污染檢查（含全文特徵）
  if (looksLikeCssOrTemplatePollution(rawText)) {
    return {
      title: title || opts?.url || "",
      excerpt: "",
      publishedAt,
      isMainBody: false,
      degradeReason: "template_or_css_pollution",
      documentKind: filing ? "sec_edgar" : "generic",
    };
  }

  // 列表／入口頁（通用特徵，非網域特例）
  if (!filing) {
    const listGate = looksLikeListOrHubPage(html, rawText, { url: opts?.url });
    if (listGate.isList) {
      return {
        title: title || opts?.url || "",
        excerpt: "",
        publishedAt,
        isMainBody: false,
        degradeReason: `list_or_hub:${listGate.reason}`,
        documentKind: "generic",
      };
    }
  }

  const excerpt = rawText.slice(0, maxChars);

  if (!isUsablePageExcerpt(excerpt) || looksLikeCssOrTemplatePollution(excerpt)) {
    return {
      title: title || opts?.url || "",
      excerpt: excerpt.slice(0, 200),
      publishedAt,
      isMainBody: false,
      degradeReason: "not_usable_main_body",
      documentKind: filing ? "sec_edgar" : "generic",
    };
  }

  // 句子過少且含導覽詞 → 降級
  const navHits = (excerpt.match(NAV_SHELL_RE) || []).length;
  const sentences = (excerpt.match(/[。！？.!?]/g) || []).length;
  if (navHits >= 2 && sentences < 3) {
    return {
      title: title || opts?.url || "",
      excerpt: "",
      publishedAt,
      isMainBody: false,
      degradeReason: "nav_shell",
      documentKind: filing ? "sec_edgar" : "generic",
    };
  }

  // 單篇特徵：至少一個較長段落，或足夠句點
  const longParas = excerpt.split(/\n/).filter((l) => l.trim().length >= 55).length;
  if (longParas < 1 && sentences < 4) {
    return {
      title: title || opts?.url || "",
      excerpt: "",
      publishedAt,
      isMainBody: false,
      degradeReason: "missing_article_prose",
      documentKind: filing ? "sec_edgar" : "generic",
    };
  }

  return {
    title: title || opts?.url || "",
    excerpt,
    publishedAt,
    isMainBody: true,
    documentKind: filing ? "sec_edgar" : "generic",
  };
}

/** 注入文本樣板污染檢測（用於指標） */
export function injectionHasTemplatePollution(text: string): boolean {
  return TEMPLATE_POLLUTION_RE.test(text) || /@font-face|font-face\s*\{/i.test(text);
}
