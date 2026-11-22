import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickRelevantSnippets } from "./strategy-loop";

describe("pickRelevantSnippets", () => {
  const chunks = [
    "[決策] F 方案停損設在 ATR 的 1.5 倍",
    "[發現] 亞洲時段的勝率明顯較低",
    "[報告 交易統計] BTCUSDT 空單平均持倉 3.2 小時",
    "[發言] 今天先不討論資金費率",
  ];

  it("挑出與問題重疊的段落並保持原順序", () => {
    const out = pickRelevantSnippets(chunks, "停損和 ATR 怎麼設定？亞洲時段呢", 2000);
    assert.ok(out.includes("停損"));
    assert.ok(out.includes("亞洲時段"));
    assert.ok(!out.includes("資金費率"));
    assert.ok(out.indexOf("停損") < out.indexOf("亞洲時段"));
  });

  it("不超過字數上限", () => {
    const long = Array.from({ length: 50 }, (_, i) => `停損 參數 ${i} ${"x".repeat(200)}`);
    const out = pickRelevantSnippets(long, "停損參數", 2000);
    assert.ok(out.length <= 2000 + 50 * 3);
    assert.ok(out.length > 0);
  });

  it("沒有相關內容時回傳空字串", () => {
    assert.equal(pickRelevantSnippets(chunks, "以太坊合併", 2000), "");
  });
});
