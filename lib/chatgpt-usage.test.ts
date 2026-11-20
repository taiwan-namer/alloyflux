import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatGptWindowLabel,
  parseChatGptUsageWindows,
  pickChatGptPrimaryWindow,
  resolveChatGptResetAt,
} from "./oauth";

describe("ChatGPT usage window parsing", () => {
  it("依 limit_window_seconds 標示，不假設 primary=5h", () => {
    const windows = parseChatGptUsageWindows({
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 604800,
          reset_at: 1_800_000_000,
        },
        secondary_window: null,
      },
    });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].label, "7 天週視窗");
    assert.equal(windows[0].remainingPercent, 0);
    assert.equal(windows[0].usedPercent, 100);
  });

  it("Plus／Pro：primary 5h、secondary 7d，主數字取 5h", () => {
    const windows = parseChatGptUsageWindows({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_at: 1_700_000_000,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604800,
          reset_at: 1_700_500_000,
        },
      },
    });
    assert.equal(windows[0].label, "5 小時視窗");
    assert.equal(windows[0].remainingPercent, 100);
    const primary = pickChatGptPrimaryWindow(windows);
    assert.equal(primary?.label, "5 小時視窗");
    assert.equal(primary?.uiRemainingPercent, 100);
  });

  it("reset_after_seconds 可推算重置時間", () => {
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    const iso = resolveChatGptResetAt({ reset_after_seconds: 3600 }, now);
    assert.equal(iso, "2026-11-20T01:00:00.000Z");
  });

  it("毫秒級 reset_at 不應再乘 1000", () => {
    const iso = resolveChatGptResetAt({ reset_at: 1_700_000_000_000 });
    assert.equal(iso, new Date(1_700_000_000_000).toISOString());
  });

  it("chatGptWindowLabel 對非 5h／7d 顯示實際長度", () => {
    assert.equal(chatGptWindowLabel(10_800), "3 小時視窗");
    assert.equal(chatGptWindowLabel(259_200), "3 天視窗");
  });

  it("5h 剩餘 100% 且週窗 0% 時主數字應取 5h", () => {
    const windows = parseChatGptUsageWindows({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_at: 1_800_000_100,
        },
        secondary_window: {
          used_percent: 100,
          limit_window_seconds: 604800,
          reset_at: 1_800_500_000,
        },
      },
    });
    const primary = pickChatGptPrimaryWindow(windows);
    assert.equal(primary?.remainingPercent, 100);
    assert.equal(primary?.label, "5 小時視窗");
    const worst = Math.min(...windows.map((w) => w.remainingPercent));
    assert.equal(worst, 0);
  });
});
