import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StrategySessionDetail, StrategySessionMessage } from "@/components/strategy-types";
import {
  isStrategySnapshotAtLeastAsFresh,
  mergeStrategyMessages,
  preferStrategyMessage,
  strategySnapshotFreshness,
} from "./strategy-open-cache";

function msg(partial: Partial<StrategySessionMessage> & Pick<StrategySessionMessage, "id" | "role">): StrategySessionMessage {
  return {
    content: "",
    createdAt: 1,
    ...partial,
  };
}

function detail(messages: StrategySessionMessage[], updatedAt = 100): StrategySessionDetail {
  return {
    session: {
      id: "s1",
      name: "room",
      status: "running",
      model: "gpt",
      models: null,
      templateId: null,
      topic: "",
      summary: "",
      autoDispatch: false,
      pauseState: null,
      updatedAt,
      workspaceId: "w1",
      profileId: null,
      strategyVersion: 1,
    },
    dispatch: [],
    reports: [],
    runs: [],
    dossier: { strategies: {}, findings: [], decisions: [], fPlan: null },
    messages,
    hasMore: false,
    nextCursor: null,
    messageTotal: messages.length,
  };
}

describe("strategy open cache freshness", () => {
  it("較舊 snapshot 不可覆寫較新快取", () => {
    const newer = detail([
      msg({ id: "u1", role: "user", content: "hi", createdAt: 10 }),
      msg({ id: "a1", role: "assistant", content: "hello world", createdAt: 11, completionStatus: "ok" }),
    ]);
    const older = detail([msg({ id: "u1", role: "user", content: "hi", createdAt: 10 })]);
    assert.equal(isStrategySnapshotAtLeastAsFresh(older, newer), false);
    assert.equal(isStrategySnapshotAtLeastAsFresh(newer, older), true);
  });

  it("同游標時較長內容視為更新", () => {
    const short = detail([
      msg({ id: "a1", role: "assistant", content: "hi", createdAt: 11, completionStatus: "partial" }),
    ]);
    const long = detail([
      msg({ id: "a1", role: "assistant", content: "hi there full answer", createdAt: 11, completionStatus: "ok" }),
    ]);
    assert.equal(isStrategySnapshotAtLeastAsFresh(short, long), false);
    assert.equal(isStrategySnapshotAtLeastAsFresh(long, short), true);
    assert.ok(strategySnapshotFreshness(long).contentChars > strategySnapshotFreshness(short).contentChars);
  });
});

describe("mergeStrategyMessages", () => {
  it("partial 不可蓋掉同 id 的 ok 全文", () => {
    const prev = [
      msg({ id: "a1", role: "assistant", content: "完整回覆內容", createdAt: 11, completionStatus: "ok" }),
    ];
    const incoming = [
      msg({ id: "a1", role: "assistant", content: "完", createdAt: 11, completionStatus: "partial" }),
    ];
    const merged = mergeStrategyMessages(prev, incoming);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.content, "完整回覆內容");
    assert.equal(merged[0]!.completionStatus, "ok");
  });

  it("preferStrategyMessage 取較高 completion + 較長內容", () => {
    const a = msg({ id: "a1", role: "assistant", content: "abc", completionStatus: "partial" });
    const b = msg({ id: "a1", role: "assistant", content: "abcdef", completionStatus: "ok" });
    assert.equal(preferStrategyMessage(a, b).content, "abcdef");
  });
});
