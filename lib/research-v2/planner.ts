import { shouldSkipLiveResearch, needsWebResearch } from "../web-research";
import {
  didStripRemovePastedContent,
  extractUserInstructionText,
  hasDeepResearchDemand,
  hasExplicitLiveDemand,
  hasOptOutOfLiveResearch,
  isMetaNewsSystemsTalk,
  isSummarizeOrTranslateOnly,
} from "./instruction-text";
import { fingerprintQuery } from "./sanitize";
import { charsBudgetForTokens, injectionMaxTokens } from "./token-budget";
import type { ResearchIntent, ResearchPlan } from "./types";

export {
  didStripRemovePastedContent,
  extractUserInstructionText,
  hasDeepResearchDemand,
  hasExplicitLiveDemand,
  hasOptOutOfLiveResearch,
  isMetaNewsSystemsTalk,
  isSummarizeOrTranslateOnly,
} from "./instruction-text";

const DEFAULT_TZ = "Asia/Taipei";
/** 規劃查詢數上限（提示用）；live 預設仍只打 1 次 Flash grounding */
const MAX_QUERIES = 3;
const MAX_PAGES = 4;
const MAX_EVENTS = 8;

const NEWSY_RE =
  /最新|今天|今日|近期|最近|消息|新聞|時事|新聞稿|頭條|快訊|breaking|news/i;
const FACTCHECK_RE = /查證|是真的嗎|假訊息|謠言|辟谣|闢謠|真假/i;

/** 使用者明確日期：2026-11-15、11/15、11月15日 */
const USER_DATE_RE =
  /(?:(20\d{2})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/;

export type PlannerInput = {
  text: string;
  now?: Date;
  timeZone?: string;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 以 IANA 時區格式化 YYYY-MM-DD（規則式，避免依賴 Intl 以外套件） */
export function formatDateInTimeZone(d: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (y && m && day) return `${y}-${m}-${day}`;
  } catch {
    /* fallthrough */
  }
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDaysIso(fromIsoDate: string, days: number): string {
  const [y, m, d] = fromIsoDate.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function parseUserDate(text: string, now: Date, timeZone: string): string | undefined {
  const m = text.match(USER_DATE_RE);
  if (!m) return undefined;
  const year = m[1] ? Number(m[1]) : Number(formatDateInTimeZone(now, timeZone).slice(0, 4));
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 意圖判斷：先剝離貼上內容，只對使用者指令跑 NEWSY／needsWebResearch。
 * 明確即時需求優先；貼文＋僅整理／翻譯 → skip。
 */
export function detectIntent(text: string): ResearchIntent {
  const raw = text.trim();
  if (!raw) return "skip";

  const instruction = extractUserInstructionText(raw);
  if (!instruction) return "skip";

  const stripRemovedPaste = didStripRemovePastedContent(raw, instruction);

  // 明確即時需求 → 即使同時貼了文件也要 news／factcheck
  if (hasExplicitLiveDemand(instruction)) {
    if (FACTCHECK_RE.test(instruction)) return "factcheck";
    return "news";
  }

  // 只貼 markdown 報告／文件、無指令
  if (
    /^#\s+/.test(raw) &&
    !/^(請|请)/m.test(instruction) &&
    (raw.match(/^#{1,3}\s/gm) || []).length >= 2
  ) {
    return "skip";
  }

  // 「這則新聞來源是哪裡」類：索取來源歸屬，屬查證意圖
  if (/這則新聞來源|新聞來源是哪|來源是哪裡|where\s+(did|does)\s+.+come\s+from/i.test(instruction)) {
    return "news";
  }

  // 貼長文後只要求整理／翻譯
  if (isSummarizeOrTranslateOnly(instruction)) return "skip";

  // 討論新聞系統本身——僅在剝離確實移除貼上時
  if (isMetaNewsSystemsTalk(instruction, { stripRemovedPaste })) return "skip";

  // 明確不要查時事／不要上網 → 不走 NEWSY
  if (hasOptOutOfLiveResearch(instruction)) return "skip";

  const deepDemand = hasDeepResearchDemand(instruction, { stripRemovedPaste });
  if (shouldSkipLiveResearch(instruction) && !needsWebResearch(instruction) && !deepDemand) {
    return "skip";
  }
  if (FACTCHECK_RE.test(instruction)) return "factcheck";
  if (NEWSY_RE.test(instruction) || needsWebResearch(instruction)) return "news";
  if (deepDemand) return "factcheck";
  if (shouldSkipLiveResearch(instruction)) return "skip";
  // 寒暄
  if (/^(你好|嗨|哈囉|hello|hi|hey)[!！.。\s]*$/i.test(instruction)) return "skip";
  // Cursor／交付指令、詢問對錯（非索取時事）
  if (/禁止部署|完成後交付|照建議預設|你覺得這個判斷|這樣對嗎|對嗎[？?]?$/i.test(instruction)) {
    return "skip";
  }
  // 其餘有內容但非即時新聞（例：英超 fixture）→ general，避免被 meta 誤 skip
  return "general";
}

/** 人物／主題粗切：用於 coverage hints，不強制一定有結果 */
function subjectHint(text: string): string {
  const t = text.replace(/最新|消息|新聞|今天|今日|近期|最近|查一下|搜尋/g, "").trim();
  return (t.slice(0, 24) || text.slice(0, 24)).trim();
}

function buildCoverageHints(text: string, intent: ResearchIntent): string[] {
  if (intent !== "news" && intent !== "factcheck") return [];
  // 非即時新聞類的判例／條款／案例／機制深度查證：不硬塞外交／軍事子題，避免汙染查詢詞
  if (intent === "factcheck" && !NEWSY_RE.test(text)) return [];
  const subj = subjectHint(text);
  // 不強制不存在的主題；僅作「盡量涵蓋」提示
  return [
    `${subj} 外交或國際行程`,
    `${subj} 內政或選舉相關`,
    `${subj} 軍事或安全相關`,
  ];
}

function buildQueries(input: {
  text: string;
  intent: ResearchIntent;
  timeWindow: ResearchPlan["timeWindow"];
  userDateHint?: string;
  coverageHints: string[];
}): string[] {
  const { text, intent, timeWindow, userDateHint, coverageHints } = input;
  if (intent === "skip") return [];

  if (intent === "factcheck" && !timeWindow && !userDateHint) {
    return [
      `${text}（優先官方文件、法院判決／法規原文、權威機構與主流媒體；排除農場內容與 YouTube）`,
    ];
  }

  const windowLabel = userDateHint
    ? `日期 ${userDateHint}`
    : timeWindow
      ? `${timeWindow.fromIso} 至 ${timeWindow.toIso}（優先近 ${timeWindow.preferRecentHours} 小時）`
      : "近期";

  const base = `${text}（時間範圍：${windowLabel}；優先路透／美聯社／BBC／大型報紙；排除維基與 YouTube）`;
  const queries = [base];

  // 第二、三查詢：主題多樣，受 maxQueries 控制
  for (const hint of coverageHints.slice(0, MAX_QUERIES - 1)) {
    queries.push(
      `${hint} ${userDateHint ?? timeWindow?.fromIso ?? ""} 最新報導（${windowLabel}）`.trim(),
    );
  }
  return queries.slice(0, MAX_QUERIES);
}

/**
 * 規則式 Research Planner（不額外呼叫 LLM）
 */
export function planResearch(input: PlannerInput): ResearchPlan {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone?.trim() || process.env.RESEARCH_TZ?.trim() || DEFAULT_TZ;
  const text = input.text.trim();
  const instruction = extractUserInstructionText(text);
  const intent = detectIntent(text);
  // 時間窗／查詢組裝以指令文字為準，避免把貼上長文塞進 query
  const intentBasis = instruction || text;
  const requireLive =
    intent === "news" ||
    intent === "factcheck" ||
    (intent !== "skip" && hasExplicitLiveDemand(intentBasis));

  if (intent === "skip" || intent === "general" || !requireLive) {
    return {
      intent: intent === "general" ? "general" : "skip",
      requireLive: false,
      timeWindow: null,
      timeZone,
      queries: [],
      coverageHints: [],
      limits: {
        maxQueries: MAX_QUERIES,
        maxPages: MAX_PAGES,
        maxEvents: MAX_EVENTS,
        maxInjectionChars: charsBudgetForTokens(injectionMaxTokens()),
      },
      skipReason:
        intent === "skip"
          ? "planner_skip_non_research"
          : intent === "general"
            ? "general_no_live"
            : "not_required",
      rawUserQuery: text,
    };
  }

  const userDateHint = parseUserDate(intentBasis, now, timeZone);
  const today = formatDateInTimeZone(now, timeZone);

  let timeWindow: ResearchPlan["timeWindow"] = null;
  if (userDateHint) {
    timeWindow = {
      fromIso: userDateHint,
      toIso: userDateHint,
      preferRecentHours: 24,
    };
  } else if (NEWSY_RE.test(intentBasis) || /最新|今天|今日|近期|最近/.test(intentBasis)) {
    // 「最新」預設 7 天窗，優先 24–72 小時（錨點＝now，禁止錯用貼文內舊日期）
    timeWindow = {
      fromIso: addDaysIso(today, -7),
      toIso: today,
      preferRecentHours: 72,
    };
  } else if (intent === "factcheck" && !needsWebResearch(intentBasis)) {
    // 歷史判例／法案／條款／運作機制查證：不鎖死 14 天時間窗，以免漏掉正式法規或經典判例原文
    timeWindow = null;
  } else {
    timeWindow = {
      fromIso: addDaysIso(today, -14),
      toIso: today,
      preferRecentHours: 72,
    };
  }

  const coverageHints = buildCoverageHints(intentBasis, intent);
  const queries = buildQueries({
    text: intentBasis,
    intent,
    timeWindow,
    userDateHint,
    coverageHints,
  });

  return {
    intent,
    requireLive: true,
    timeWindow,
    userDateHint,
    timeZone,
    queries,
    coverageHints,
    limits: {
      maxQueries: MAX_QUERIES,
      maxPages: MAX_PAGES,
      maxEvents: MAX_EVENTS,
      maxInjectionChars: charsBudgetForTokens(injectionMaxTokens()),
    },
    rawUserQuery: text,
  };
}

/** 測試／debug 用 */
export function plannerQueryFingerprint(plan: ResearchPlan): string {
  return fingerprintQuery(plan.queries.join("|") || plan.rawUserQuery);
}
