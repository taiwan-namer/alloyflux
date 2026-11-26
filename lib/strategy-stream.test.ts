import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPartialJsonStringField } from "./strategy-stream";

describe("readPartialJsonStringField", () => {
  it("字串還沒閉合也能讀出已寫的回覆", () => {
    assert.equal(readPartialJsonStringField('{"phase":"x","reply":"驗收不通過', "reply"), "驗收不通過");
  });

  it("還原跳脫換行", () => {
    assert.equal(readPartialJsonStringField('{"reply":"你好\\n下一行","phase":1}', "reply"), "你好\n下一行");
  });

  it("沒有該欄位回 null", () => {
    assert.equal(readPartialJsonStringField('{"phase":1}', "reply"), null);
  });
});
