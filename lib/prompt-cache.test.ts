import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignedTail, alignedWindowStart, slideMessagesForUpstream, UPSTREAM_MAX_MESSAGES } from "./context-window";
import { MODELS } from "./models";
import type { ChatMessage } from "./providers";
import { splitSystemPromptForCache, systemPromptFor } from "./providers";

const model = MODELS.find((m) => m.id === "gpt-6-astra") ?? MODELS[0]!;

function conversation(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `問題 ${i}` });
    out.push({ role: "assistant", content: `回答 ${i}` });
  }
  out.push({ role: "user", content: `問題 ${turns}` });
  return out;
}

/** 舊版視窗：固定取最後 16 則，開頭若是 assistant 則丟掉 */
function legacyWindow(messages: ChatMessage[]): ChatMessage[] {
  let sliced = messages.slice(-UPSTREAM_MAX_MESSAGES);
  while (sliced.length && sliced[0].role !== "user") sliced = sliced.slice(1);
  return sliced;
}

describe("splitSystemPromptForCache", () => {
  it("stable + volatile 與原本整段 System 一字不差", () => {
    const ctx = "【對話狀態】目標：做報表\n\n其他對話近期提問：\n- 台積電股價";
    const style = "【語氣】叫我老闆";
    const { stable, volatile } = splitSystemPromptForCache(model, "gpt-6-astra", ctx, undefined, style, null);
    assert.equal(`${stable}\n\n${volatile}`, systemPromptFor(model, "gpt-6-astra", ctx, undefined, style));
    assert.ok(!stable.includes("台積電"), "變動背景不得留在固定前段");
  });

  it("沒有變動背景時 volatile 為空、stable 即完整 System", () => {
    const { stable, volatile } = splitSystemPromptForCache(model, "gpt-6-astra", undefined, undefined, undefined, null);
    assert.equal(volatile, "");
    assert.equal(stable, systemPromptFor(model, "gpt-6-astra"));
  });
});

describe("對齊視窗（prompt cache）", () => {
  it("任何長度下保留的歷史都不少於舊版 8 輪視窗", () => {
    for (let turns = 0; turns <= 60; turns++) {
      const msgs = conversation(turns);
      const next = slideMessagesForUpstream(msgs);
      const legacy = legacyWindow(msgs);
      assert.ok(next.length >= legacy.length, `turns=${turns}: ${next.length} < ${legacy.length}`);
      assert.equal(next[0]?.role, "user");
      assert.equal(next[next.length - 1]?.content, msgs[msgs.length - 1]?.content);
    }
  });

  it("視窗起點每 4 輪才前移，期間各輪開頭相同", () => {
    const starts = new Set<string>();
    for (let turns = 12; turns < 16; turns++) {
      starts.add(slideMessagesForUpstream(conversation(turns))[0]!.content);
    }
    assert.equal(starts.size, 1);
  });

  it("重複套用（route → gateway）結果不變", () => {
    const once = slideMessagesForUpstream(conversation(23));
    assert.deepEqual(slideMessagesForUpstream(once), once);
  });

  it("alignedTail 與 alignedWindowStart 的絕對起點一致", () => {
    for (let len = 1; len <= 200; len++) {
      const items = Array.from({ length: len }, (_, i) => i);
      const tail = alignedTail(items, 80);
      assert.ok(tail.length <= 80);
      const absolute = (tail[0] ?? 0) + alignedWindowStart(tail.length, UPSTREAM_MAX_MESSAGES);
      assert.equal(absolute, alignedWindowStart(len, UPSTREAM_MAX_MESSAGES));
    }
  });
});
