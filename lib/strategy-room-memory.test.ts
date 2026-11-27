import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatUserSpecBlock,
  isUserSpecMessage,
  mergeUserSpecs,
} from "./strategy-room-memory";

describe("使用者規格記憶", () => {
  it("短確認不算規格，模組表算", () => {
    assert.equal(isUserSpecMessage("ＯＫ　看來已經全部做完了對嗎"), false);
    const table = `${"項目／建議模組\t必須保存的資料與功能\t解決這次哪個問題\n".repeat(8)}run_manifest`;
    assert.equal(isUserSpecMessage(table), true);
  });

  it("保留較新的三份，同則取較完整", () => {
    const merged = mergeUserSpecs(
      [{ messageId: "a", createdAt: 1, text: "短" }],
      [
        { messageId: "a", createdAt: 1, text: "比較完整的規格內容，含必須保存" },
        { messageId: "b", createdAt: 2, text: "第二份規格" },
        { messageId: "c", createdAt: 3, text: "第三份規格" },
        { messageId: "d", createdAt: 4, text: "第四份規格" },
      ],
    );
    assert.deepEqual(
      merged.map((s) => s.messageId),
      ["b", "c", "d"],
    );
  });

  it("注入時規格在前，並提醒路線圖不是逐欄驗收", () => {
    const text = formatUserSpecBlock("深度研究 E", [
      { messageId: "m", createdAt: 1, text: "1. run_manifest 必須保存帳戶識別" },
    ]);
    assert.match(text, /使用者規格（優先於路線圖/);
    assert.match(text, /run_manifest/);
    assert.match(text, /不要把路線圖全數結案說成規格逐欄通過/);
  });
});
