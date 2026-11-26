import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healOverdueQuotaWindows, quotaWindowForModel, type SubscriptionQuota } from "./oauth";

function baseQuota(over: Partial<SubscriptionQuota> = {}): SubscriptionQuota {
  return {
    planType: "PLUS",
    email: "s8qkpqpgvd@privaterelay.appleid.com",
    windows: [],
    primaryUsedPercent: 60,
    primaryRemainingPercent: 40,
    fetchedAt: 1,
    ...over,
  };
}

describe("healOverdueQuotaWindows", () => {
  it("過期且卡在高 used% 的視窗應清零", () => {
    const now = Date.parse("2026-11-26T04:30:00.000Z");
    const prev = baseQuota({
      windows: [
        {
          label: "5 小時視窗",
          usedPercent: 60,
          remainingPercent: 40,
          uiUsedPercent: 60,
          uiRemainingPercent: 40,
          resetAt: "2026-11-25T15:34:14.000Z",
          modelKey: "chatgpt",
          limitWindowSeconds: 18_000,
        },
        {
          label: "7 天週視窗",
          usedPercent: 15,
          remainingPercent: 85,
          uiUsedPercent: 15,
          uiRemainingPercent: 85,
          resetAt: "2026-11-27T03:25:25.000Z",
          modelKey: "chatgpt",
          limitWindowSeconds: 604_800,
        },
      ],
    });
    const { quota, healed } = healOverdueQuotaWindows(prev, now);
    assert.equal(healed, true);
    assert.equal(quota.windows[0]!.usedPercent, 0);
    assert.equal(quota.windows[0]!.remainingPercent, 100);
    assert.equal(quota.windows[0]!.resetAt, null);
    assert.equal(quota.windows[1]!.usedPercent, 15);
    assert.equal(quota.primaryUsedPercent, 15);
    assert.equal(quota.primaryRemainingPercent, 85);
  });

  it("尚未到重置時間則不改動", () => {
    const now = Date.parse("2026-11-26T04:30:00.000Z");
    const prev = baseQuota({
      windows: [
        {
          label: "5 小時視窗",
          usedPercent: 80,
          remainingPercent: 20,
          uiUsedPercent: 80,
          uiRemainingPercent: 20,
          resetAt: "2026-11-26T09:00:00.000Z",
          modelKey: "chatgpt",
          limitWindowSeconds: 18_000,
        },
      ],
      primaryUsedPercent: 80,
      primaryRemainingPercent: 20,
    });
    const { quota, healed } = healOverdueQuotaWindows(prev, now);
    assert.equal(healed, false);
    assert.equal(quota.windows[0]!.usedPercent, 80);
  });

  it("無 resetAt 但快取已超過視窗長度時也應清零", () => {
    const now = Date.parse("2026-11-26T10:00:00.000Z");
    const prev = baseQuota({
      fetchedAt: Date.parse("2026-11-26T04:00:00.000Z"), // 6 小時前
      windows: [
        {
          label: "5 小時視窗",
          usedPercent: 60,
          remainingPercent: 40,
          uiUsedPercent: 60,
          uiRemainingPercent: 40,
          resetAt: null,
          modelKey: "chatgpt",
          limitWindowSeconds: 18_000,
        },
      ],
    });
    const { quota, healed } = healOverdueQuotaWindows(prev, now);
    assert.equal(healed, true);
    assert.equal(quota.windows[0]!.usedPercent, 0);
    assert.equal(quota.primaryRemainingPercent, 100);
  });
});

describe("quotaWindowForModel ChatGPT", () => {
  it("gpt 模型應對齊 chatgpt 窗，而非 Gemini shared", () => {
    const quota = baseQuota({
      windows: [
        {
          label: "Gemini 總額 · 週",
          usedPercent: 99,
          remainingPercent: 1,
          uiUsedPercent: 99,
          uiRemainingPercent: 1,
          resetAt: null,
          modelKey: "shared",
        },
        {
          label: "5 小時視窗",
          usedPercent: 10,
          remainingPercent: 90,
          uiUsedPercent: 10,
          uiRemainingPercent: 90,
          resetAt: null,
          modelKey: "chatgpt",
          limitWindowSeconds: 18_000,
        },
      ],
    });
    const w = quotaWindowForModel(quota, "gpt-5.6-sol");
    assert.ok(w);
    assert.equal(w!.modelKey, "chatgpt");
    assert.equal(w!.usedPercent, 10);
  });
});
