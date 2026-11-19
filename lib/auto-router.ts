import { findModel, type ModelInfo } from "./models";
import { listOnlineNodesForModel } from "./node-registry";
import { quotaWindowForModel } from "./oauth";
import { sourceCatalogLacksModel } from "./providers";
import { candidatesFor } from "./sources";

/** 前端虛擬選項：依問題自動派發實際模型（照實際模型扣點） */
export const AUTO_MODEL_ID = "auto";

/** L2 輕量高速：日常問答／翻譯／OCR／一般查證（Hydrogen 為 Flash 級日常） */
export const AUTO_LIGHT_MODEL_IDS = [
  "gemini-4-hydrogen-high",
  "gemini-3.8-flash-low",
  "gemini-3.5-flash-lite",
];

/** L3 主力：跨家族依水庫剩餘量輪替（Neon 取代 Argon 為預設深度日常） */
export const AUTO_MAIN_MODEL_IDS = ["agy-claude-sonnet-5-5-low", "gemini-4-neon-high", "gpt-6.1-terra"];

export type AutoLane = "light" | "main";

export interface AutoDecision {
  model: ModelInfo;
  lane: AutoLane;
  reason: string;
}

const MAIN_TEXT_THRESHOLD = 250;
const STICKY_PREV_CHARS = 800;
const STICKY_FOLLOWUP_MAX_CHARS = 120;

const CODE_INTENT_RE =
  /```|程式|程式碼|代碼|寫.{0,6}(code|程式|腳本|函式|網頁)|html|css|javascript|typescript|python|sql|腳本|script|函式|function|api|debug|bug|報錯|錯誤訊息|regex|正規表達式|網頁|小遊戲|遊戲|互動|元件|component|爬蟲|自動化|vba|公式|架構設計|系統架構|資料庫/i;
const ANALYSIS_INTENT_RE =
  /分析報告|深度分析|企劃|計畫書|計劃書|商業模式|策略|推演|多方比較|比較.{0,8}(優缺點|差異)|優缺點|評估|規劃|提案|研究報告|財報分析|可行性/i;
const LIGHT_INTENT_RE = /翻譯|translate|改寫|潤飾|潤稿|摘要|總結|重點整理|整理重點|summarize/i;

/** 排除「已知帳號目錄沒有此模型」的貨源（如帳號未開 Gemini 3.1 Pro） */
async function usableCandidates(model: ModelInfo) {
  return (await candidatesFor(model)).filter((c) => !sourceCatalogLacksModel(c.source.id, model));
}

async function hasAvailableUpstream(model: ModelInfo): Promise<boolean> {
  if ((await usableCandidates(model)).length > 0) return true;
  if (model.antigravityId && (await listOnlineNodesForModel("antigravity", model.antigravityId)).length > 0) return true;
  if (model.codexId && (await listOnlineNodesForModel("chatgpt-codex", model.codexId)).length > 0) return true;
  return false;
}

/** 該模型目前最健康貨源的剩餘 %（無配額資訊視為 50） */
async function healthScore(model: ModelInfo): Promise<number> {
  let best = -1;
  for (const c of await usableCandidates(model)) {
    const q = c.source.quota;
    const rem =
      (q && quotaWindowForModel(q, model.antigravityId ?? model.id)?.remainingPercent) ??
      q?.primaryRemainingPercent ??
      50;
    if (rem > best) best = rem;
  }
  return best < 0 ? 50 : best;
}

async function pickFromPool(
  ids: string[],
  byHealth: boolean,
  exclude: ReadonlySet<string>,
): Promise<ModelInfo | null> {
  const pool: ModelInfo[] = [];
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const m = findModel(id);
    if (m && (await hasAvailableUpstream(m))) pool.push(m);
  }
  if (!pool.length) return null;
  if (!byHealth) return pool[0];
  let best = pool[0];
  let bestScore = await healthScore(best);
  for (const m of pool.slice(1)) {
    const s = await healthScore(m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}

function classifyLane(text: string, hasImages: boolean): { lane: AutoLane; reason: string } {
  const code = CODE_INTENT_RE.test(text);
  const analysis = ANALYSIS_INTENT_RE.test(text);
  if (hasImages) {
    return code || analysis
      ? { lane: "main", reason: "圖片＋程式／分析" }
      : { lane: "light", reason: "圖片辨識／OCR" };
  }
  if (code) return { lane: "main", reason: "程式／HTML／架構" };
  if (analysis) return { lane: "main", reason: "深度分析／企劃" };
  if (LIGHT_INTENT_RE.test(text)) return { lane: "light", reason: "翻譯／改寫／摘要" };
  if (text.length > MAIN_TEXT_THRESHOLD) return { lane: "main", reason: `長文（>${MAIN_TEXT_THRESHOLD} 字）` };
  return { lane: "light", reason: "日常問答" };
}

/**
 * 零成本規則分流（不另呼叫模型判斷）：
 * 1) 黏性：上一則含程式碼或 >800 字且本輪為短句追問 → 沿用上一輪模型
 * 2) 程式／分析／長文／圖片＋分析 → L3（依水庫剩餘量挑）
 * 3) 其餘 → L2 Flash
 */
export function resolveAutoModelIds(freeOnly: boolean): { light: string[]; main: string[] } {
  if (freeOnly) {
    // 免費層跨家族入門模型：Gemini Flash-Lite、Claude Sonnet Low、GPT Luna / GPT-OSS、Grok 4.5
    const light = ["gemini-3.5-flash-lite", "gpt-6-luna", "gpt-5.6-luna", "agy-gpt-oss-120b-medium"];
    const main = ["agy-claude-sonnet-5-5-low", "grok-4.5", "agy-gpt-oss-120b-medium", "gemini-3.5-flash-lite"];
    return { light, main };
  }
  return { light: AUTO_LIGHT_MODEL_IDS, main: AUTO_MAIN_MODEL_IDS };
}

export async function resolveAutoModel(input: {
  text: string;
  hasImages: boolean;
  lastAssistant?: { content: string; model: string | null };
  forceMain?: boolean;
  /** 未登入／未購買方案：僅在免費入門模型內自動路由 */
  freeOnly?: boolean;
  /** 本輪已嘗試失敗（如帳號目錄沒有）的模型，重新派發時略過 */
  excludeModelIds?: ReadonlySet<string>;
}): Promise<AutoDecision | null> {
  const text = input.text.trim();
  const exclude = input.excludeModelIds ?? new Set<string>();
  const pools = resolveAutoModelIds(Boolean(input.freeOnly));

  if (input.forceMain) {
    const m = await pickFromPool(pools.main, true, exclude) ?? await pickFromPool(pools.light, false, exclude);
    return m ? { model: m, lane: pools.main.includes(m.id) ? "main" : "light", reason: "使用者要求主力重答" } : null;
  }

  const prev = input.lastAssistant;
  if (
    prev?.model &&
    !input.hasImages &&
    text.length <= STICKY_FOLLOWUP_MAX_CHARS &&
    (prev.content.includes("```") || prev.content.length > STICKY_PREV_CHARS)
  ) {
    const inLight = pools.light.includes(prev.model);
    const inMain = pools.main.includes(prev.model);
    const prevModel = findModel(prev.model);
    if ((inLight || inMain) && prevModel && !exclude.has(prevModel.id) && (await hasAvailableUpstream(prevModel))) {
      return { model: prevModel, lane: inMain ? "main" : "light", reason: "黏性路由（延續上一輪任務）" };
    }
    if (!inLight) {
      const m = await pickFromPool(pools.main, true, exclude);
      if (m) return { model: m, lane: "main", reason: "黏性路由（上一輪模型不可用，改派主力）" };
    }
  }

  const { lane, reason } = classifyLane(text, input.hasImages);
  if (lane === "main") {
    const m = await pickFromPool(pools.main, true, exclude);
    if (m) return { model: m, lane: "main", reason };
    const fallback = await pickFromPool(pools.light, false, exclude);
    return fallback ? { model: fallback, lane: "light", reason: `${reason}（主力不可用，改派輕量）` } : null;
  }
  const m = await pickFromPool(pools.light, false, exclude);
  if (m) return { model: m, lane: "light", reason };
  const fallback = await pickFromPool(pools.main, true, exclude);
  return fallback ? { model: fallback, lane: "main", reason: `${reason}（輕量不可用，改派主力）` } : null;
}

/**
 * 網頁版思考檔位：只有 top 模型可開「深度思考」（medium）；其餘一律 low。
 * 有 -low/-medium 變體就換變體；沒有變體（如 Astra）則複製一份 effort=medium。
 */
export function applyDeepThink(model: ModelInfo, deepThink: boolean): ModelInfo {
  const family = model.effort ? model.id.replace(/-(low|medium|high)$/, "") : null;
  if (deepThink && model.tier === "top") {
    if (family) return findModel(`${family}-medium`) ?? model;
    return { ...model, effort: "medium" };
  }
  if (family && model.effort !== "low") return findModel(`${family}-low`) ?? model;
  return model;
}
