import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseUserMessageContent,
  previewUserText,
  shouldCollapseUserText,
  USER_TEXT_COLLAPSE_CHARS,
  USER_TEXT_PREVIEW_CHARS,
  USER_TEXT_PREVIEW_LINES,
} from "./user-message-display";

describe("parseUserMessageContent", () => {
  it("剝離附件區塊，只留對話文字與檔名", () => {
    const raw = [
      "請幫我整理這份報告",
      "",
      "--- [附件檔案：報告.txt] ---",
      "這是很長的附件內容".repeat(20),
      "--- [附件結束] ---",
    ].join("\n");
    const parsed = parseUserMessageContent(raw);
    assert.equal(parsed.text, "請幫我整理這份報告");
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.name, "報告.txt");
    assert.ok((parsed.attachments[0]?.charCount ?? 0) > 50);
    assert.equal(parsed.imageNote, null);
  });

  it("支援多個附件與圖片前綴", () => {
    const raw = [
      "[已上傳 1 張圖片]",
      "看圖並對照附件",
      "",
      "--- [附件檔案：a.txt] ---",
      "AAA",
      "--- [附件結束] ---",
      "",
      "--- [附件檔案：b.md] ---",
      "BBB",
      "--- [附件結束] ---",
    ].join("\n");
    const parsed = parseUserMessageContent(raw);
    assert.equal(parsed.imageNote, "[已上傳 1 張圖片]");
    assert.equal(parsed.text, "看圖並對照附件");
    assert.deepEqual(
      parsed.attachments.map((a) => a.name),
      ["a.txt", "b.md"],
    );
  });

  it("無附件時原樣保留文字", () => {
    const parsed = parseUserMessageContent("你好，幫我寫一封信");
    assert.equal(parsed.text, "你好，幫我寫一封信");
    assert.equal(parsed.attachments.length, 0);
  });

  it("結尾無換行、半形冒號也能剝離", () => {
    const raw = "請看\n\n--- [附件檔案: note.txt] ---\nline1\nline2--- [附件結束] ---";
    const parsed = parseUserMessageContent(raw);
    assert.equal(parsed.text, "請看");
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.name, "note.txt");
    assert.match(parsed.attachments[0]?.text ?? "", /line1/);
  });

  it("有開頭無結尾時仍收成附件，避免文字牆", () => {
    const raw = `指令\n\n--- [附件檔案：broken.txt] ---\n${"X".repeat(2000)}`;
    const parsed = parseUserMessageContent(raw);
    assert.equal(parsed.text, "指令");
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.name, "broken.txt");
    assert.equal(parsed.attachments[0]?.charCount, 2000);
  });
});

describe("shouldCollapseUserText / previewUserText", () => {
  it("短文不收合", () => {
    assert.equal(shouldCollapseUserText("短短一句"), false);
  });

  it("超長文字要收合，預覽短於原文", () => {
    const long = "甲".repeat(USER_TEXT_COLLAPSE_CHARS + 40);
    assert.equal(shouldCollapseUserText(long), true);
    const preview = previewUserText(long);
    assert.ok(preview.length < long.length);
    assert.ok(preview.endsWith("…"));
    assert.ok(preview.length <= USER_TEXT_PREVIEW_CHARS + 1);
  });

  it("多行超過門檻也收合", () => {
    const manyLines = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    assert.equal(shouldCollapseUserText(manyLines), true);
    const preview = previewUserText(manyLines);
    assert.ok(preview.split("\n").length <= USER_TEXT_PREVIEW_LINES + 1);
  });
});
