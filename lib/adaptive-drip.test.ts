import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptiveTakeCount, typewriterTakeCount } from "./adaptive-drip";

describe("adaptiveTakeCount", () => {
  it("少量逐字吐，不把一整小包倒在同一幀", () => {
    assert.equal(adaptiveTakeCount(1), 1);
    assert.equal(adaptiveTakeCount(12), 1);
    assert.equal(adaptiveTakeCount(40), 1);
  });

  it("積壓很多才加快，不會一次倒完", () => {
    assert.equal(adaptiveTakeCount(80), 2);
    assert.ok(adaptiveTakeCount(400) > 2);
    assert.ok(adaptiveTakeCount(400) < 40);
  });
});

describe("typewriterTakeCount", () => {
  it("平常一次吐一個字", () => {
    assert.equal(typewriterTakeCount(1), 1);
    assert.equal(typewriterTakeCount(40), 1);
  });

  it("積壓變多才加快，不會一次倒完", () => {
    assert.equal(typewriterTakeCount(100), 2);
    assert.ok(typewriterTakeCount(400) < 400);
    assert.ok(typewriterTakeCount(400) >= 4);
  });
});
