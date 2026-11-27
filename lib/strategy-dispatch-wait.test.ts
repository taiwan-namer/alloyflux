import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampDispatchWaitMs, DISPATCH_POLL_WAIT_MAX_MS } from "./strategy-dispatch-wait";

describe("clampDispatchWaitMs", () => {
  it("無效或 0 視為立即查", () => {
    assert.equal(clampDispatchWaitMs(undefined), 0);
    assert.equal(clampDispatchWaitMs("0"), 0);
    assert.equal(clampDispatchWaitMs(-1), 0);
    assert.equal(clampDispatchWaitMs("nope"), 0);
  });

  it("夾在上限內", () => {
    assert.equal(clampDispatchWaitMs(25_000), 25_000);
    assert.equal(clampDispatchWaitMs("90000"), DISPATCH_POLL_WAIT_MAX_MS);
    assert.equal(clampDispatchWaitMs(100), 100);
  });
});
