import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_CHARS_PER_PART,
  partFileName,
  splitTextAttachHint,
  splitTextIntoAttachmentParts,
} from "./split-text-attachments";

describe("partFileName", () => {
  it("多段加上 1-N 後綴", () => {
    assert.equal(partFileName("report.txt", 0, 3), "report_1-3.txt");
    assert.equal(partFileName("report.txt", 2, 3), "report_3-3.txt");
  });

  it("單段保持原名風格", () => {
    assert.equal(partFileName("a.md", 0, 1), "a.md");
    assert.equal(partFileName("noext", 0, 1), "noext.txt");
  });
});

describe("splitTextIntoAttachmentParts", () => {
  it("34733 字拆成 3 段（每段 15000）", () => {
    const text = "甲".repeat(34_733);
    const result = splitTextIntoAttachmentParts({
      text,
      baseName: "big.txt",
      maxCharsPerPart: DEFAULT_MAX_CHARS_PER_PART,
      maxParts: 5,
    });
    assert.equal(result.totalPartsNeeded, 3);
    assert.equal(result.parts.length, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.keptChars, 34_733);
    assert.equal(result.parts[0]?.text.length, 15_000);
    assert.equal(result.parts[1]?.text.length, 15_000);
    assert.equal(result.parts[2]?.text.length, 4_733);
    assert.equal(result.parts[0]?.name, "big_1-3.txt");
    assert.equal(result.parts[2]?.name, "big_3-3.txt");
  });

  it("受 maxParts 限制時截斷並標註", () => {
    const text = "乙".repeat(50_000);
    const result = splitTextIntoAttachmentParts({
      text,
      baseName: "貼上文字.txt",
      maxCharsPerPart: 15_000,
      maxParts: 2,
    });
    assert.equal(result.parts.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.keptChars, 30_000);
    assert.match(result.parts[1]!.text, /後續內容因附件數量上限已省略/);
    assert.match(splitTextAttachHint(result), /拆成 2 個附件/);
  });

  it("短文不拆", () => {
    const result = splitTextIntoAttachmentParts({
      text: "hello",
      baseName: "x.txt",
      maxParts: 5,
    });
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0]?.name, "x.txt");
    assert.equal(result.truncated, false);
  });
});
