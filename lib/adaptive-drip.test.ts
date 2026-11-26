import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptiveTakeCount, typewriterTakeCount } from "./adaptive-drip";

describe("adaptiveTakeCount", () => {
  it("已到的字本幀一次接上，不逐字拖", () => {
    assert.equal(adaptiveTakeCount(1), 1);
    assert.equal(adaptiveTakeCount(12), 12);
    assert.equal(adaptiveTakeCount(40), 40);
    assert.equal(adaptiveTakeCount(400), 400);
  });
});

describe("typewriterTakeCount", () => {
  it("與聊天相同，一次接上", () => {
    assert.equal(typewriterTakeCount(40), 40);
    assert.equal(typewriterTakeCount(400), 400);
  });
});
