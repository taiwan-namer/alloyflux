import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { typewriterTakeCount } from "./adaptive-drip";

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
