import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveTakeCount,
  createAdaptiveDripDriver,
  takeAdaptiveSlice,
  toCodePoints,
} from "./adaptive-drip";

describe("adaptive-drip", () => {
  it("adaptiveTakeCount scales with backlog and never returns 0 for positive", () => {
    assert.equal(adaptiveTakeCount(0), 0);
    assert.equal(adaptiveTakeCount(5), 5);
    assert.ok(adaptiveTakeCount(40) < 40);
    assert.ok(adaptiveTakeCount(40) >= 3);
    assert.ok(adaptiveTakeCount(500) >= 80);
    assert.ok(adaptiveTakeCount(500) < 500);
  });

  it("takeAdaptiveSlice does not split surrogate pairs", () => {
    const emoji = "😀".repeat(20);
    const { take, rest } = takeAdaptiveSlice(emoji);
    assert.equal(toCodePoints(take + rest).length, 20);
    assert.ok(!take.includes("\uD800") || take.length >= 2);
    // 重組後完整
    assert.equal(take + rest, emoji);
  });

  it("driver digests over multiple ticks and flushDisplay snaps to received", () => {
    const driver = createAdaptiveDripDriver(
      () => 0,
      () => {},
    );
    driver.upsert({
      key: "a",
      role: "lead",
      modelId: "m",
      label: "主導",
      received: "你好世界".repeat(30),
    });
    let ticks = 0;
    while (driver.tick() && ticks < 50) ticks += 1;
    const mid = driver.snapshot()[0]!;
    assert.ok(mid.displayed.length > 0);
    assert.ok(mid.displayed.length <= mid.received.length);
    const flushed = driver.flushDisplay()[0]!;
    assert.equal(flushed.displayed, flushed.received);
  });

  it("isolates queues per member key", () => {
    const driver = createAdaptiveDripDriver(
      () => 0,
      () => {},
    );
    driver.upsert({ key: "a", role: "lead", modelId: "1", label: "A", received: "aaaa" });
    driver.upsert({ key: "b", role: "critic", modelId: "2", label: "B", received: "bbbbbbbb" });
    driver.tick();
    const snap = driver.snapshot();
    assert.equal(snap.length, 2);
    assert.equal(snap[0]!.key, "a");
    assert.equal(snap[1]!.key, "b");
    assert.ok(snap[0]!.displayed.length <= 4);
  });

  it("stopAndClear cancels and empties", () => {
    const driver = createAdaptiveDripDriver(
      () => 0,
      () => {},
    );
    driver.upsert({ key: "a", role: "lead", modelId: "1", label: "A", received: "hello" });
    driver.stopAndClear();
    assert.equal(driver.snapshot().length, 0);
  });
});
