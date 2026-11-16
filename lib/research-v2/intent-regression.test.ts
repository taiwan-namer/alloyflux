/**
 * 意圖誤觸發／漏觸發雙向回歸（各 ≥10，須 100% 通過）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectIntent, planResearch } from "./planner";

const ARCH_DOC = `
# Research V2 架構說明
平台已有 Research Pipeline，但 GPT／Claude 的新聞回答品質不如 Gemini 原生搜尋。
請分析 Gate、Collector、injection 與 provenance 設計。
`.trim();

const CODE_BLOCK = `
\`\`\`typescript
function gateEvidence() {
  // 新聞來源 article_body
  return { status: "partial" };
}
\`\`\`
請解釋這段程式在做什麼。
`.trim();

const NEWS_ARTICLE_PASTE = `
華盛頓訊——美國國會今日通過預算案，總統隨後簽署生效。路透社報導指出，市場預期利率決策將受到影響，分析師認為短期波動可能加大。多名議員表示談判過程艱辛，最終版本刪減了部分支出項目。國際媒體同步關注財政赤字走勢，並引用財政部稍早公布的數據。地方官員則呼籲州政府配合新規範。專家警告明年選舉前政治壓力可能升高，投資人宜審慎評估風險。以下還有更多段落重複說明背景與各方反應，用來模擬使用者貼上的長篇新聞全文內容，確保剝離後不會因為文中「新聞」「今日」等字而誤觸發檢索。
`.repeat(2);

const FALSE_TRIGGER: { id: string; text: string }[] = [
  {
    id: "ft01_arch_discuss",
    text: `請對齊架構並分析以下文件是否合理：\n\n${ARCH_DOC}`,
  },
  {
    id: "ft02_cursor_指令",
    text: `照建議預設執行。禁止部署。完成後交付報告 A–L。\n\n補充：新聞抽取要用通用規則，不要網域特例。`,
  },
  {
    id: "ft03_code_explain",
    text: CODE_BLOCK,
  },
  {
    id: "ft04_paste_summarize",
    text: `${NEWS_ARTICLE_PASTE}\n\n請摘要這段文字。`,
  },
  {
    id: "ft05_paste_translate",
    text: `${NEWS_ARTICLE_PASTE}\n\n請翻譯成英文。`,
  },
  {
    id: "ft06_paste_整理",
    text: `請整理下面內容：\n\n${NEWS_ARTICLE_PASTE}`,
  },
  {
    id: "ft07_quote_arch",
    text: `> Research V2 的新聞品質問題與 Gate 保守有關。\n> Flash brief 被丟掉。\n\n你覺得這個判斷對嗎？`,
  },
  {
    id: "ft08_css_dump",
    text: `幫我看這段 CSS 為什麼被標成正文：\n\n\`\`\`css\n@font-face { font-family: "CNN"; src: url(/x.woff2); }\n.nav { display:flex; }\n\`\`\`\n只要解釋抽取邏輯。`,
  },
  {
    id: "ft09_meta_chat",
    text: `我們在討論指令與架構，並沒有要查任何時事。請只回答流程問題。`,
  },
  {
    id: "ft10_hello",
    text: `你好`,
  },
  {
    id: "ft11_refactor",
    text: `請幫我 refactor 這個 TypeScript research collector，不要上網。`,
  },
  {
    id: "ft12_paste_report_only",
    // 只貼交付報告、無任何指令（模擬誤觸發檢索的貼文）
    text: `# 新聞內容品質優先 — 交付報告 A–L

**狀態**：選 A＋三護欄已落地；意圖回歸 22/22；fixture≥15＋hold-out 已鎖；抽取指標已測；raw groundingSupports 已記錄。

## A. 決策與護欄
選 A（修誤觸發）。剝離取代關鍵字排除；明確即時需求優先；雙向回歸。

## F. 指標
before F1／after F1；反向正文辨識；shellFalseBodyRate。

## G. supports log
docs/live-e2e/flash-grounding-supports.jsonl；search_synthesis 延後。

hold-out：cna_taiwan、reuters_tech_sample、synthetic_css_shell。
fixture 與 provenance／collector／injectionText 說明。
`,
  },
];

const MUST_TRIGGER: { id: string; text: string }[] = [
  { id: "mt01_trump", text: "川普最新消息" },
  { id: "mt02_market", text: "明天股市預測" },
  { id: "mt03_nvidia7d", text: "NVIDIA 過去 7 天新聞" },
  { id: "mt04_tw_tech", text: "台灣最近科技新聞" },
  {
    id: "mt05_arch_plus_live",
    text: `${ARCH_DOC}\n\n另外請查最新新聞，NVIDIA 最近 7 天重點。`,
  },
  { id: "mt06_today", text: "今天台積電有什麼消息？" },
  { id: "mt07_search", text: "幫我查英國大選最新結果" },
  { id: "mt08_breaking", text: "有沒有關於東京地震的最新快訊？" },
  { id: "mt09_en", text: "What are the latest news about the Fed interest rate?" },
  { id: "mt10_conflict", text: "最近中東衝突有哪些重要進展？" },
  {
    id: "mt11_code_plus_live",
    text: `${CODE_BLOCK}\n\n另外幫我查一下今天美股收盤重點。`,
  },
  // 歷史真實提問（長指令不得被剝離誤殺）
  {
    id: "mt12_hist_nvidia_long",
    text: "請整理 NVIDIA 過去 7 天最重要的 3 件新聞。每件新聞必須包含發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。",
  },
  {
    id: "mt13_hist_nvidia_recent",
    text: "請整理 NVIDIA 最近 7 天最重要的 3 則新聞，附上發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。",
  },
  { id: "mt14_hist_trump", text: "川普最新消息有哪些？請附來源與日期。" },
  { id: "mt15_hist_market", text: "明天股市預測重點是什麼？請標註不確定性。" },
  { id: "mt16_hist_tw", text: "台灣最近科技新聞有哪些？" },
  { id: "mt17_hist_tsmc", text: "今天台積電有什麼消息？" },
  { id: "mt18_news_source", text: "川普關稅這則新聞來源是哪裡" },
  { id: "mt19_news_source_short", text: "這則新聞來源是哪裡" },
];

const MUST_NOT_META_SKIP: { id: string; text: string; expect: "general" | "news" }[] = [
  { id: "nm01_epl_fixture", text: "英超 fixture 怎麼排", expect: "general" },
];

describe("意圖剝離：誤觸發集（預期 skip）", () => {
  for (const c of FALSE_TRIGGER) {
    it(`${c.id} → skip`, () => {
      const intent = detectIntent(c.text);
      const plan = planResearch({ text: c.text, now: new Date("2026-11-16T04:00:00+08:00") });
      assert.equal(intent, "skip", `intent=${intent} for ${c.id}`);
      assert.equal(plan.requireLive, false, `requireLive for ${c.id}`);
    });
  }
});

describe("意圖剝離：漏觸發集（預期 news）", () => {
  for (const c of MUST_TRIGGER) {
    it(`${c.id} → news`, () => {
      const intent = detectIntent(c.text);
      const plan = planResearch({ text: c.text, now: new Date("2026-11-16T04:00:00+08:00") });
      assert.equal(intent, "news", `intent=${intent} for ${c.id}`);
      assert.equal(plan.requireLive, true, `requireLive for ${c.id}`);
    });
  }
});

describe("意圖：不得被 meta／fixture 誤 skip", () => {
  for (const c of MUST_NOT_META_SKIP) {
    it(`${c.id} → ${c.expect}`, () => {
      const intent = detectIntent(c.text);
      assert.equal(intent, c.expect, `intent=${intent}`);
      assert.notEqual(intent, "skip");
    });
  }
});
