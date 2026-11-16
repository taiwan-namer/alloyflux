/**
 * 意圖判斷用：剝離附件／程式碼／引用／長篇貼上，只留使用者自身指令。
 * 不用「架構／程式」黑名單，不加 LLM。
 */

/**
 * 明確即時／聯網需求（只對指令文字）。
 * 不用裸「搜尋／上網」——會誤中「原生搜尋」「不要上網」。
 */
export const EXPLICIT_LIVE_DEMAND_RE =
  /今天|今日|最新|最近\s*\d+\s*天|過去\s*\d+\s*天|近\s*\d+\s*天|過去一週|近一週|本週|本周|幫我查|請查(?!證)|查一下|細查|詳查|深查|查明|搜一下|找看看|上網查|幫我搜|請搜尋|搜尋一下|搜索一下|找全文|查全文|google(?:\s*(?:一下|search))?|breaking\s*news|latest\s+news|past\s+\d+\s+days?/i;

/** 深度查證／案例／判例／法規／運作機制關鍵詞（不含開發語法） */
export const DEEP_RESEARCH_CUE_RE =
  /細查|詳查|深查|深入查|查清楚|查明|讀(?:這篇|該篇|此篇|原文)?全文|看(?:這篇|該篇|此篇|原文)?全文|閱讀全文|原文全文|找全文|查全文|判例|判決|裁判|訴訟|官司|起訴|裁定|法案|法規|條例|條款|條文|合規|監管|裁罰|處分|案例|白皮書|招股書|財報|年報|申報|8-K|10-K|如何運作|怎麼運作|運作方式|運作機制|商業模式是什麼|\bv\.\s+[A-Z][A-Za-z0-9.-]+/i;

/** 開發／本專案內部技術詞：避免把純程式問題當成外部機構名誤觸發聯網 */
const DEV_OR_INTERNAL_TERM_RE =
  /^(typescript|javascript|python|sql|html|css|json|yaml|xml|react|next\.?js|node\.?js|git|github|docker|regex|cursor|vercel|supabase|postgres|prisma|tailwind|webpack|vite|eslint|jest|vitest|research|collector|planner|gate|gateway|oauth)$/i;

/** 明確拒絕聯網／查時事（優先於 NEWSY 誤觸） */
const OPT_OUT_LIVE_RE =
  /不要上網|別上網|勿上網|不用上網|不需上網|不要聯網|並沒有要查|沒有要查任何|不要搜尋|不要搜索|別搜尋|請只回答流程/;

/** 僅整理／翻譯／摘要（貼文後的短指令） */
const SUMMARIZE_OR_TRANSLATE_ONLY_RE =
  /^(請|请)?(幫我|帮我)?(把|將|将)?(下面|以上|下列|這段|这段|全文|文章|內容|内容)?(的)?(文字|新聞|新闻|文章)?\s*(整理|摘要|總結|总结|翻譯|翻译|润色|潤飾|改寫|改写|濃縮|归纳|歸納)(成|為|为|一下|出來|出来)?/i;

const SUMMARIZE_OR_TRANSLATE_EN_RE =
  /^(please\s+)?(summarize|translate|rewrite|proofread|condense)\b/i;

/**
 * 系統／交付產物討論正例（僅在「剝離確實移除貼上」時啟用）。
 * 不含單獨的 fixture／新聞來源——避免「英超 fixture」「這則新聞來源」誤殺。
 */
const META_NEWS_SYSTEMS_RE =
  /新聞\s*(回答|品質|系統|抽取|管線)|news\s*answer|research\s*(?:v\s*2|pipeline)|provenance|injectionText|groundingSupports|hold-out|對齊架構|分析以下文件|討論指令與架構|交付報告\s*A[–—-]L/i;

/**
 * 剝離 fenced code、引用、極長貼上列、HTML／CSS 碎片，留下短指令句。
 * 含明確即時需求的列永不因長度被剝（避免真實長提問漏觸發）。
 */
export function extractUserInstructionText(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n");

  t = t.replace(/```[\s\S]*?```/g, "\n");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "\n");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, "\n");
  t = t.replace(/<html[\s\S]*?<\/html>/gi, "\n");
  t = t.replace(/^\s{0,3}> ?.*$/gm, "\n");
  // 「以下文件／如下」之後整段視為貼上（保留提示語本身）
  t = t.replace(
    /(分析以下文件|以下文件|如下文件|下列文件|以下內容|如下內容|如下[：:]|以下[：:])\s*[\s\S]*$/i,
    "$1",
  );

  const lines = t.split("\n");
  const kept: string[] = [];
  let sawUserCue = false;
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      kept.push("");
      continue;
    }
    // 使用者即時／深度查證需求列保留（避免長提問被剝）；新聞正文裡夾「今日」不視為指令
    if (EXPLICIT_LIVE_DEMAND_RE.test(s) || DEEP_RESEARCH_CUE_RE.test(s)) {
      const userAsk =
        /^(請|请|幫我|帮我|有沒有|幫我查|请查|what|where|how)/i.test(s) ||
        /幫我查|請查(?!證)|查一下|細查|詳查|深查|查明|讀.*全文|看.*全文|找全文|查全文|最新消息|過去\s*\d+\s*天|最近\s*\d+\s*天|過去 7 天|最近 7 天/.test(
          s,
        ) ||
        (s.length <= 120 && !/路透|美聯社|報導指出|總統隨後|國會今日|分析師/.test(s));
      if (userAsk) {
        kept.push(line);
        sawUserCue = true;
        continue;
      }
    }
    if (/^(請|请)/.test(s) || /對齊架構|交付報告/.test(s)) {
      kept.push(line);
      sawUserCue = true;
      continue;
    }
    // 使用者指令之後的 markdown 標題／文件正文列 → 貼上
    if (sawUserCue && /^#{1,6}\s+\S/.test(s)) continue;
    if (sawUserCue && /^(平台已有|Gate、|Collector、|補充：)/.test(s)) continue;

    if (/@font-face|^\.[a-z0-9_-]+\s*\{/i.test(s)) continue;
    if (/\{[^}]{20,}\}/.test(s) && /[:;]/.test(s)) continue;
    // 單列過長或新聞體長句 → 視為貼上正文（無即時需求時）
    if (s.length > 160) continue;
    if (s.length > 100 && (s.match(/[。！？.!?]/g) || []).length >= 2) continue;
    if (
      s.length > 80 &&
      /路透|美聯社|報導指出|分析師|議員表示|總裁隨後|國際媒體|專家警告|投資人/.test(s)
    ) {
      continue;
    }
    if (/^skip to (main )?content$/i.test(s)) continue;
    kept.push(line);
  }

  let out = kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!out && raw.trim()) {
    const head = raw.trim().split(/\n/).find((l) => {
      const s = l.trim();
      return s.length > 0 && (EXPLICIT_LIVE_DEMAND_RE.test(s) || (s.length <= 280 && !/```/.test(s)));
    });
    out = (head ?? raw.trim().slice(0, 160)).trim();
  }

  return out;
}

/** 剝離是否真的拿掉了貼上內容（meta 判斷的前提） */
export function didStripRemovePastedContent(raw: string, instruction: string): boolean {
  const r = raw.replace(/\r\n/g, "\n").trim();
  const i = instruction.trim();
  if (!r) return false;
  if (/```[\s\S]+?```/.test(r) && !/```/.test(i)) return true;
  if (/^\s{0,3}> /m.test(r) && !/^>/m.test(i)) return true;
  if (/<style[\s\S]*?<\/style>|<html[\s\S]*?<\/html>/i.test(r)) return true;
  // 長度明顯縮水（貼上長文被剝）
  if (r.length >= 120 && i.length + 80 <= r.length) return true;
  // 列數明顯減少
  const rawLines = r.split("\n").filter((l) => l.trim()).length;
  const instrLines = i.split("\n").filter((l) => l.trim()).length;
  if (rawLines >= 4 && instrLines <= rawLines - 2) return true;
  return false;
}

export function hasExplicitLiveDemand(instruction: string): boolean {
  const t = instruction.trim();
  if (!t) return false;
  if (OPT_OUT_LIVE_RE.test(t) && !/(?:幫我查|請查(?!證)|查一下|搜一下|最新|今天|今日)/.test(t)) {
    return false;
  }
  if (!EXPLICIT_LIVE_DEMAND_RE.test(t)) return false;
  if (
    /不要上網|別上網|勿上網|不用上網/.test(t) &&
    !/(?:幫我查|請查(?!證)|查一下|最新|今天|今日|最近\s*\d+|過去\s*\d+)/.test(t)
  ) {
    return false;
  }
  return true;
}

export function hasOptOutOfLiveResearch(instruction: string): boolean {
  return OPT_OUT_LIVE_RE.test(instruction.trim());
}

export function isSummarizeOrTranslateOnly(instruction: string): boolean {
  const t = instruction.trim();
  if (!t) return true;
  if (SUMMARIZE_OR_TRANSLATE_ONLY_RE.test(t)) return true;
  if (SUMMARIZE_OR_TRANSLATE_EN_RE.test(t)) return true;
  if (t.length <= 40 && /整理|摘要|總結|翻译|翻譯|summarize|translate/i.test(t)) return true;
  return false;
}

/**
 * 深度追問／案例／判例／條款／運作機制／專有名詞查證需求判定。
 * 僅對剝離貼文後的 instruction 執行。
 */
export function hasDeepResearchDemand(
  instruction: string,
  opts?: { stripRemovedPaste?: boolean },
): boolean {
  const t = instruction.trim();
  if (!t || OPT_OUT_LIVE_RE.test(t)) return false;

  // 若已貼上長文且沒有要求外部查／找／細查，避免指令中單獨出現「全文」字眼誤觸
  if (
    opts?.stripRemovedPaste &&
    !/細查|詳查|深查|查明|幫我查|請查|找全文|查全文|搜尋|上網|判例|訴訟|法案/.test(t)
  ) {
    return false;
  }

  // 裸「全文」（如單打「讀全文」「看全文」）或深度研究關鍵詞
  if (/^(請|请)?(幫我|帮我)?(讀|看|閱讀|找|查)?.*全文[。？?!！]*$/i.test(t)) {
    return true;
  }
  if (DEEP_RESEARCH_CUE_RE.test(t)) {
    return true;
  }

  // 包含明確中文機構／法案／公司後綴的查詢請求（例：「查某公司／某法案／某事務所」）
  if (
    /(?:查|查詢|調查|確認|了解|檢視|研究)\s*[^\n]{0,20}[\u4e00-\u9fffA-Za-z0-9]{2,16}(?:公司|集團|銀行|基金|事務所|法院|委員會|法案|條例|協議|判例|事件|案)/.test(
      t,
    )
  ) {
    return true;
  }

  // 包含明確英文專有名詞／機構名的查證或運作詢問（排除純開發語言／框架名）
  const enTokens = t.match(/\b[A-Z][A-Za-z0-9.&-]{2,}\b/g) ?? [];
  const hasExternalProperNoun = enTokens.some(
    (tok) => !DEV_OR_INTERNAL_TERM_RE.test(tok.replace(/\.$/, "")),
  );
  if (
    hasExternalProperNoun &&
    /(?:查|查詢|調查|確認|了解|介紹|分析|是什麼|是什麼來頭|背景|如何運作|怎麼運作|運作|規定|政策|爭議|評價)/.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * 討論「新聞系統本身」——僅在剝離確實移除貼上內容時啟用。
 */
export function isMetaNewsSystemsTalk(
  instruction: string,
  opts?: { stripRemovedPaste?: boolean },
): boolean {
  if (!opts?.stripRemovedPaste) return false;
  const t = instruction.trim();
  if (!t || hasExplicitLiveDemand(t)) return false;
  return META_NEWS_SYSTEMS_RE.test(t);
}
