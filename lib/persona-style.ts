/**
 * Persona & Style Memory：語氣／排版偏好的擷取、格式化與覆蓋注入。
 * - 全局 → user_memories.category = 'style'
 * - 本串 → conversation_states.hard_constraints（【語氣】前綴）
 */
import { sameTopicLoose } from "./memory-topic";

export const MAX_STYLE_CHARS = 380;
export const USER_STYLE_CAP = 8;
export const SESSION_STYLE_PREFIX = "【語氣】";

export type StyleScope = "global" | "session";

export type StyleDirective = {
  scope: StyleScope;
  text: string;
};

const SESSION_HINT_RE =
  /這[次篇輪則題回]|這一[次題輪]|本[次題篇輪]|先暫時|暫時先|只這一|僅此一|這一則/;

const GLOBAL_HINT_RE =
  /以後|之后|之後|每次|從今|从今|一律|永久|都這樣|都这样|當成習慣|記成習慣|記住這個|记住这个|請記住|请记住|幫我記住|帮我记住/;

/** 明確語氣／排版／稱呼偏好 */
const STYLE_LINE_RES: RegExp[] = [
  /(?:以後|之后|之後|請|请)?[^。！？\n]{0,24}(?:簡短|短回|簡要|详细|詳細|详尽|詳盡)[^。！？\n]{0,40}/,
  /(?:不要|別|别|别再|別再)(?:用)?(?:條列|列表|條列式|markdown\s*列表)[^。！？\n]{0,20}/,
  /(?:用|改成|改為|换成|換成)[^。！？\n]{1,24}(?:口吻|語氣|语气|腔調|腔调)/,
  /(?:像|當|当)[^。！？\n]{1,16}(?:朋友|同事|顧問|老师|老師|老闆|老板)[^。！？\n]{0,24}(?:一樣|一样|般|聊天|說話|说话)?/,
  /叫我[^。！？\n]{1,20}/,
  /稱呼我[^。！？\n]{1,20}/,
  /先給(?:我)?(?:程式碼|代码|code)[^。！？\n]{0,30}/,
  /(?:不要|別|别)(?:先)?解釋[^。！？\n]{0,24}/,
  /回答[^。！？\n]{0,16}(?:不超過|不超过|最多|控制在)\s*\d+\s*(?:行|句|字|段)/,
  /請用[^。！？\n]{1,40}(?:語氣|语气|語言|语言|回覆|回答|口吻)/,
  /說話[^。！？\n]{0,20}(?:毒舌|直接|溫柔|温柔|正式|隨便|随便)[^。！？\n]{0,20}/,
  /排版[^。！？\n]{0,40}/,
];

function normalizeStyleText(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  if (text.length < 4) return null;
  return text;
}

export function isSessionStyleConstraintText(text: string): boolean {
  return text.trimStart().startsWith(SESSION_STYLE_PREFIX);
}

export function toSessionStyleConstraintText(style: string): string {
  const body = style.replace(new RegExp(`^${SESSION_STYLE_PREFIX}`), "").trim();
  return `${SESSION_STYLE_PREFIX}${body}`.slice(0, 160);
}

export function stripSessionStylePrefix(text: string): string {
  return text.replace(new RegExp(`^${SESSION_STYLE_PREFIX}`), "").trim();
}

/**
 * 從單則 user 訊息抽出語氣／排版指令，並判斷全局 vs 本串。
 * - 有「這篇／本次」等 → session
 * - 有「以後／記住」等 → global
 * - 僅有風格句、無範圍詞 → 預設 global（長期偏好）
 */
export function extractStyleDirectives(content: string): StyleDirective[] {
  const text = content?.trim() ?? "";
  if (!text) return [];

  const hasSession = SESSION_HINT_RE.test(text);
  const hasGlobal = GLOBAL_HINT_RE.test(text);

  // 若只有 session 提示但沒有抓到風格句，整句可能是「這篇用小學生…」
  const found: string[] = [];
  for (const re of STYLE_LINE_RES) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m?.[0]) {
      const n = normalizeStyleText(m[0]);
      if (n) found.push(n);
    }
  }

  if (!found.length) {
    // 補捉：「這篇幫我用小學生聽得懂的話講」這類
    if (hasSession) {
      const soft =
        text.match(
          /這[次篇輪則題回][^。！？\n]{0,8}(?:幫我|请|請)?(?:用|以)?([^。！？\n]{4,80})/,
        )?.[1] ||
        text.match(/(?:用|以)([^。！？\n]{4,60})(?:聽得懂|听得懂|方式|說法|讲)/)?.[0];
      const n = normalizeStyleText(soft || (hasSession ? text.slice(0, 120) : ""));
      if (n && /小學生|小学生|口吻|語氣|语气|簡短|條列|老闆|老板|程式碼|代码|朋友/.test(n + text)) {
        found.push(n.startsWith("這") || n.startsWith("这") ? n : normalizeStyleText(text.slice(0, 100)) || n);
      }
    }
    if (!found.length && hasGlobal) {
      const n = normalizeStyleText(
        text.match(/(?:以後|之后|之後|請記住|请记住|記住)[^。！？\n]{2,100}/)?.[0] || "",
      );
      if (n) found.push(n);
    }
  }

  // 無範圍詞也無風格句 → 不擷取
  if (!found.length) return [];

  // 純 session 提示優先；否則有風格句時：
  // - 明確 session → session
  // - 明確 global 或無範圍 → global
  const finalScope: StyleScope = hasSession ? "session" : "global";

  const seen = new Set<string>();
  const out: StyleDirective[] = [];
  for (const f of found) {
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scope: finalScope, text: f });
  }
  return out;
}

const STYLE_TOPIC_FAMILY_RES: RegExp[] = [
  /簡短|短回|簡要|詳盡|详尽|詳細|详细|長篇|长篇|不超過|不超过|最多\s*\d+\s*行/,
  /條列|列表|表格|markdown/,
  /口吻|語氣|语气|毒舌|朋友|顧問/,
  /叫我|稱呼|称呼|老闆|老板/,
  /程式碼|代码|先給|不要解釋|不要解释/,
];

function sameStyleTopic(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  for (const re of STYLE_TOPIC_FAMILY_RES) {
    if (re.test(a) && re.test(b)) return true;
  }
  return sameTopicLoose(a, b);
}

/** 新 style 覆蓋同主題舊 style（回傳仍應保留的舊條目） */
export function resolveStyleConflicts(
  existing: string[],
  incoming: string,
): { keep: string[]; superseded: string[] } {
  const next = normalizeStyleText(incoming);
  if (!next) return { keep: existing, superseded: [] };
  const keep: string[] = [];
  const superseded: string[] = [];
  for (const e of existing) {
    if (sameStyleTopic(e, next)) {
      superseded.push(e);
    } else {
      keep.push(e);
    }
  }
  return { keep, superseded };
}

export function formatStyleOverrideBlock(input: {
  sessionStyles: string[];
  globalStyles: string[];
}): string {
  const session = input.sessionStyles.map(stripSessionStylePrefix).filter(Boolean);
  const global = input.globalStyles.filter(Boolean);
  if (!session.length && !global.length) return "";

  const lines: string[] = [
    "【使用者語氣／排版偏好｜最高優先級覆蓋規則】",
    "以下為使用者明確指定的說話風格、稱呼、長度與排版偏好，優先於上方系統預設的【說話方式】與【排版】；若有衝突時，請絕對以本區為準（其中「本串對話臨時語氣約束」又優先於「全局長期語氣偏好」）。",
    "若本區未提及的項目，仍遵守上方預設與安全／查證／可下載檔案規則。",
  ];

  if (session.length) {
    lines.push("本串對話臨時語氣約束：");
    for (const s of session) lines.push(`- ${s}`);
  }
  if (global.length) {
    lines.push("全局長期語氣偏好：");
    for (const s of global) lines.push(`- ${s}`);
  }

  let text = lines.join("\n").trim();
  if (text.length > MAX_STYLE_CHARS) {
    text = `${text.slice(0, MAX_STYLE_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/** 接在 base（含預設說話方式或 customSystemPrompt）之後；不包「非當前指令」 */
export function appendStyleOverride(base: string, styleOverrideContext?: string): string {
  const style = styleOverrideContext?.trim();
  if (!style) return base;
  return `${base}\n\n${style}`;
}
