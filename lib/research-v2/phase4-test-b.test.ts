/**
 * 測試 B：固定證據下的模型比較 harness（離線）
 * 三模型收到同一份 ResearchResult／injection；不呼叫 Live。
 * 產品路徑（測試 A）另見 phase4-p0 / live-budget。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verdictToResearchResult } from "./contract";
import { PHASE4_PRODUCT_MODELS } from "./types";
import { runResearchPipelineV2 } from "./pipeline";
import { fixtureB_MultiTopicSameDay, fixtureC_ConflictingConfirmation } from "./fixtures/news-fixtures";
import { createLiveBudget, recordLiveUsage } from "./live-budget";
import { estimateTokensApprox } from "./token-budget";

const NOW = new Date("2026-11-15T12:00:00+08:00");

type ModelSlot = keyof typeof PHASE4_PRODUCT_MODELS;

/** 模擬各模型實際收到的研究資料（相同 injection） */
function researchPayloadForModel(
  model: ModelSlot,
  injectionText: string,
  resultShape: ReturnType<typeof verdictToResearchResult>,
) {
  return {
    modelId: PHASE4_PRODUCT_MODELS[model],
    mode: "B_fixed_evidence" as const,
    injectionText,
    evidenceGrades: resultShape.events.map((e) => e.evidenceGrade),
    claimProvenances: resultShape.claims.map((c) => c.provenance),
    sourceCount: resultShape.sources.length,
    estimatedInjectionTokens: estimateTokensApprox(injectionText),
    searchCalls: 0, // Test B：固定證據，不再搜尋
  };
}

describe("測試 B：固定證據三模型比較（離線）", () => {
  it("Astra／Claude／Argon 收到相同 injection 與證據層級", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureC_ConflictingConfirmation(),
      supplyPath: "local",
    });
    const shared = verdictToResearchResult(verdict);
    assert.ok(shared.injectionText.length > 0);

    const budget = createLiveBudget("B_fixed_evidence");
    const received: ReturnType<typeof researchPayloadForModel>[] = [];

    for (const slot of ["astra", "claude", "argon"] as ModelSlot[]) {
      assert.equal(recordLiveUsage(budget, { fullAnswers: 1, estimatedTokens: shared.researchCost?.estimatedInjectionTokens ?? 0 }), true);
      received.push(researchPayloadForModel(slot, shared.injectionText, shared));
    }

    assert.equal(received.length, 3);
    assert.equal(received[0].injectionText, received[1].injectionText);
    assert.equal(received[1].injectionText, received[2].injectionText);
    assert.deepEqual(received[0].claimProvenances, received[1].claimProvenances);
    assert.ok(received.every((r) => r.searchCalls === 0));
    assert.equal(budget.fullAnswers, 3);
  });

  it("多題固定證據不超過 Test B 回答上限", async () => {
    const questions = ["題1 最新消息", "題2 外交動態", "題3 選舉結果"];
    const budget = createLiveBudget("B_fixed_evidence");
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: questions[0] }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
      supplyPath: "local",
    });
    const shared = verdictToResearchResult(verdict);

    for (const _q of questions) {
      for (const _slot of ["astra", "claude", "argon"] as ModelSlot[]) {
        assert.equal(
          recordLiveUsage(budget, {
            fullAnswers: 1,
            estimatedTokens: estimateTokensApprox(shared.injectionText),
          }),
          true,
        );
      }
    }
    assert.equal(budget.fullAnswers, 9);
    assert.equal(
      recordLiveUsage(budget, { fullAnswers: 1 }),
      false,
      "第 10 次完整回答必須被擋",
    );
  });
});
