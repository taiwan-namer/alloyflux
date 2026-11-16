import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHistorySummaryText,
  extractStatePatchesFromMessages,
  formatConversationStateForInject,
  mergeEntries,
  mergeStateNote,
  planStateAbsorbBatch,
  STATE_ABSORB_TOKEN_TARGET,
  type StateEntry,
} from "./conversation-state";
import { estimateTokensApprox } from "./research-v2/token-budget";

describe("conversation-state 批次邊界", () => {
  it("本批已近滿且再加會超 → 整則留給下批，不切開", () => {
    let filler = "約束測試文字。";
    while (estimateTokensApprox(filler) < STATE_ABSORB_TOKEN_TARGET * 0.85) {
      filler += "約束測試文字。";
    }
    const first = { id: "m1", role: "user", content: filler, createdAt: 1 };
    let secondContent = "下一則額外內容，用來確認不會被切開。";
    while (
      estimateTokensApprox(filler) + estimateTokensApprox(secondContent) <=
      STATE_ABSORB_TOKEN_TARGET
    ) {
      secondContent += "下一則額外內容，用來確認不會被切開。";
    }
    const second = { id: "m2", role: "user", content: secondContent, createdAt: 2 };
    const d = planStateAbsorbBatch([first, second]);
    assert.equal(d.take.length, 1);
    assert.equal(d.take[0].id, "m1");
    assert.equal(d.defer.length, 1);
    assert.equal(d.defer[0].id, "m2");
  });

  it("單則再大也整則收下", () => {
    const huge = { id: "h1", role: "user", content: "長文。".repeat(3000), createdAt: 1 };
    const d = planStateAbsorbBatch([huge]);
    assert.equal(d.take.length, 1);
    assert.equal(d.defer.length, 0);
  });
});

describe("provenance 與 supersede", () => {
  it("新決策取代同主題舊決策", () => {
    const a: StateEntry = {
      id: "a1",
      text: "記憶架構採用八輪視窗",
      provenance: "user",
      status: "confirmed",
      createdAt: 1,
    };
    const b: StateEntry = {
      id: "a2",
      text: "記憶架構改成狀態筆記",
      provenance: "user",
      status: "confirmed",
      createdAt: 2,
    };
    const merged = mergeEntries([a], [b], { kind: "decisions" });
    const active = merged.filter((e) => e.status !== "superseded");
    assert.ok(active.some((e) => /狀態筆記/.test(e.text)));
    assert.ok(merged.some((e) => e.id === "a1" && e.status === "superseded"));
  });

  it("assistant 推測不可覆蓋 user 硬約束", () => {
    const userC: StateEntry = {
      id: "c1",
      text: "不部署",
      provenance: "user",
      status: "confirmed",
      createdAt: 1,
    };
    const aiC: StateEntry = {
      id: "c2",
      text: "不部署改為可部署",
      provenance: "assistant_inferred",
      status: "pending",
      createdAt: 2,
    };
    const merged = mergeEntries([userC], [aiC], { kind: "hardConstraints" });
    const userStill = merged.find((e) => e.id === "c1");
    assert.equal(userStill?.status, "confirmed");
  });

  it("擷取與注入含 provenance 標籤", () => {
    const patch = extractStatePatchesFromMessages([
      {
        id: "u1",
        role: "user",
        content: "目標：改善長對話記憶。硬性約束：不部署。決定：採用狀態筆記。待確認：摘要門檻。",
      },
    ]);
    assert.match(patch.goal || "", /長對話記憶/);
    assert.ok((patch.hardConstraints || []).some((c) => c.provenance === "user"));
    const text = formatConversationStateForInject({
      conversationId: "c1",
      goal: "做狀態筆記",
      hardConstraints: patch.hardConstraints || [],
      decisions: patch.decisions || [],
      progress: [],
      openQuestions: patch.openQuestions || [],
      sourceMessageIds: ["u1"],
      coveredThroughCreatedAt: 0,
      revision: 1,
      updatedAt: Date.now(),
    });
    assert.match(text, /本串對話狀態筆記/);
    assert.match(text, /硬性約束/);
    assert.match(text, /使用者/);
  });

  it("mergeStateNote 遞增 revision", () => {
    const a = mergeStateNote(
      {
        conversationId: "c1",
        goal: "",
        hardConstraints: [
          {
            id: "c1",
            text: "不部署",
            provenance: "user",
            status: "confirmed",
            createdAt: 1,
          },
        ],
        decisions: [],
        progress: [],
        openQuestions: [],
        sourceMessageIds: [],
        coveredThroughCreatedAt: 0,
        revision: 1,
        updatedAt: 0,
      },
      {
        hardConstraints: [
          {
            id: "c2",
            text: "預算上限",
            provenance: "user",
            status: "confirmed",
            createdAt: 2,
          },
        ],
        goal: "改善記憶",
      },
    );
    assert.equal(a.goal, "改善記憶");
    assert.equal(a.revision, 2);
    assert.ok(a.hardConstraints.some((e) => e.text === "預算上限"));
  });

  it("buildHistorySummaryText 含結構化線索", () => {
    const s = buildHistorySummaryText([
      {
        id: "m1",
        role: "user",
        content: "目標：長對話記憶。決定：採用筆記。這是一段用來當首句的說明文字。",
      },
    ]);
    assert.match(s, /目標|決策|User/);
  });
});
