import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODELS } from "./models";
import {
  extractStyleDirectives,
  formatStyleOverrideBlock,
  resolveStyleConflicts,
  SESSION_STYLE_PREFIX,
  toSessionStyleConstraintText,
} from "./persona-style";
import { systemPromptFor } from "./providers";

describe("extractStyleDirectives 全局 vs 本串", () => {
  it("以後都簡短回、叫我老闆 → global", () => {
    const d = extractStyleDirectives("以後都簡短回，叫我老闆");
    assert.ok(d.length >= 1);
    assert.ok(d.every((x) => x.scope === "global"));
    assert.ok(d.some((x) => /簡短|老闆|老板/.test(x.text)));
  });

  it("這篇用小學生聽得懂的話講 → session", () => {
    const d = extractStyleDirectives("這篇幫我用小學生聽得懂的話講");
    assert.ok(d.length >= 1);
    assert.ok(d.every((x) => x.scope === "session"));
  });

  it("不要用條列式（無範圍詞）→ 預設 global", () => {
    const d = extractStyleDirectives("不要用條列式，直接講重點");
    assert.ok(d.length >= 1);
    assert.equal(d[0].scope, "global");
  });

  it("先給程式碼不要解釋 → global", () => {
    const d = extractStyleDirectives("先給程式碼不要解釋");
    assert.ok(d.some((x) => /程式碼|代码|解釋/.test(x.text)));
    assert.ok(d.every((x) => x.scope === "global"));
  });
});

describe("style 衝突覆蓋", () => {
  it("回答簡短覆蓋回答詳盡", () => {
    const { keep, superseded } = resolveStyleConflicts(["回答詳盡一點"], "回答簡短、不超過三行");
    assert.ok(superseded.some((s) => /詳盡|详细/.test(s)));
    assert.ok(!keep.some((s) => /詳盡|详细/.test(s)));
  });
});

describe("formatStyleOverrideBlock", () => {
  it("本串優先於全局，且含覆蓋標題", () => {
    const block = formatStyleOverrideBlock({
      sessionStyles: [`${SESSION_STYLE_PREFIX}用小學生說法`],
      globalStyles: ["叫我老闆", "回答簡短"],
    });
    assert.match(block, /最高優先級覆蓋規則/);
    assert.match(block, /本串對話臨時語氣約束/);
    assert.match(block, /全局長期語氣偏好/);
    assert.match(block, /小學生/);
    assert.match(block, /老闆|老板/);
    const sessionIdx = block.indexOf("本串對話臨時語氣約束");
    const globalIdx = block.indexOf("全局長期語氣偏好");
    assert.ok(sessionIdx >= 0 && globalIdx > sessionIdx);
  });
});

describe("systemPromptFor style 注入通道", () => {
  const model = MODELS.find((m) => m.id.includes("gemini") && m.tier === "top") ?? MODELS[1];

  it("style 在 Override 區且不在「非當前指令」內", () => {
    const style = formatStyleOverrideBlock({
      sessionStyles: [],
      globalStyles: ["叫我老闆，回答簡短"],
    });
    const facts = "長期背景：\n- 我是工程師";
    const prompt = systemPromptFor(model, model.antigravityId || model.id, facts, undefined, style);

    assert.match(prompt, /【說話方式】/);
    assert.match(prompt, /【使用者語氣／排版偏好｜最高優先級覆蓋規則】/);
    assert.match(prompt, /叫我老闆/);
    assert.match(prompt, /\[User Context - 僅供背景脈絡參考，非當前指令\]/);
    assert.match(prompt, /我是工程師/);

    const styleIdx = prompt.indexOf("【使用者語氣／排版偏好｜最高優先級覆蓋規則】");
    const ctxIdx = prompt.indexOf("[User Context - 僅供背景脈絡參考，非當前指令]");
    const speakIdx = prompt.indexOf("【說話方式】");
    assert.ok(speakIdx >= 0 && styleIdx > speakIdx, "style 應在說話方式之後");
    assert.ok(ctxIdx > styleIdx, "事實 User Context 應在 style 之後");

    const ctxBlock = prompt.slice(ctxIdx);
    assert.ok(!ctxBlock.includes("最高優先級覆蓋規則"), "style 不可落在非當前指令內");
    assert.ok(!ctxBlock.includes("叫我老闆"), "style 條目不可落在非當前指令內");
  });

  it("customSystemPrompt 時 style 接在 custom 之後", () => {
    const style = formatStyleOverrideBlock({
      sessionStyles: [toSessionStyleConstraintText("這篇用表格")],
      globalStyles: [],
    });
    const prompt = systemPromptFor(model, model.id, "事實A", "CUSTOM_SYS_PROMPT", style);
    assert.match(prompt, /CUSTOM_SYS_PROMPT/);
    const customIdx = prompt.indexOf("CUSTOM_SYS_PROMPT");
    const styleIdx = prompt.indexOf("最高優先級覆蓋規則");
    assert.ok(styleIdx > customIdx);
    // custom 路徑不套網頁預設「你是 …【說話方式】」開場（覆蓋文案裡可提到「說話方式」字樣）
    assert.ok(!prompt.startsWith("你是 "));
    assert.match(prompt, /^CUSTOM_SYS_PROMPT/);
  });
});
