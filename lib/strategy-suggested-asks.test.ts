import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asksFromSummary, normalizeSuggestedAsks } from "./strategy-suggested-asks";

const SUMMARY =
  "帳本22/23限定範圍完成。E-DATA-REPAIR-02接受離線入口及安全交付：9測與CLI退出0。真實行情仍22根預期／0命中，A點blocked、收益null。E-DATA-E2E-03開始隔離合成輸入的重播測試；不代表現行掛接完成。";

describe("摘要問句", () => {
  it("從摘要點名目前項目與缺口，不用泛用盤點句", () => {
    const asks = asksFromSummary(SUMMARY);
    assert.ok(asks.length >= 2);
    assert.ok(asks.some((s) => s.includes("E-DATA-E2E-03")));
    assert.ok(asks.some((s) => s.includes("E-DATA-REPAIR-02")));
    assert.equal(asks.some((s) => s.includes("請盤點目前")), false);
  });

  it("空摘要沒有問句", () => {
    assert.deepEqual(asksFromSummary("  "), []);
  });

  it("只留下可點的短句", () => {
    const out = normalizeSuggestedAsks(["太短", "請核對 E-DATA-E2E-03 還沒完成的重播", "請核對 E-DATA-E2E-03 還沒完成的重播", "x".repeat(90)]);
    assert.deepEqual(out, ["請核對 E-DATA-E2E-03 還沒完成的重播"]);
  });
});
