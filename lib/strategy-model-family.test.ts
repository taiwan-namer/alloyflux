import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StrategyModelOption } from "@/components/strategy-types";
import {
  buildModelFamilies,
  resolveFamilyModelId,
  uiEffortOf,
} from "@/lib/strategy-model-family";

function opt(partial: Partial<StrategyModelOption> & Pick<StrategyModelOption, "id" | "label">): StrategyModelOption {
  return {
    available: true,
    familyId: partial.familyId,
    familyLabel: partial.familyLabel,
    categoryLabel: partial.categoryLabel ?? "Google Gemini",
    effort: partial.effort,
    note: partial.note,
    ...partial,
  };
}

describe("strategy-model-family 4C", () => {
  it("把同家族 Low/Medium/High 收成一列，並排除 xhigh", () => {
    const families = buildModelFamilies([
      opt({
        id: "gemini-4-neon-low",
        label: "Gemini 4 Neon · Low",
        familyId: "gemini-4-neon",
        familyLabel: "Gemini 4 Neon（最強全能）",
        effort: "low",
      }),
      opt({
        id: "gemini-4-neon-medium",
        label: "Gemini 4 Neon · Medium",
        familyId: "gemini-4-neon",
        familyLabel: "Gemini 4 Neon（最強全能）",
        effort: "medium",
      }),
      opt({
        id: "gemini-4-neon-high",
        label: "Gemini 4 Neon · High",
        familyId: "gemini-4-neon",
        familyLabel: "Gemini 4 Neon（最強全能）",
        effort: "high",
      }),
      opt({
        id: "gemini-4-neon-xhigh",
        label: "Gemini 4 Neon · Extra High",
        familyId: "gemini-4-neon",
        familyLabel: "Gemini 4 Neon（最強全能）",
        effort: "xhigh",
      }),
    ]);
    assert.equal(families.length, 1);
    assert.equal(families[0]!.familyId, "gemini-4-neon");
    assert.deepEqual(families[0]!.efforts, ["low", "medium", "high"]);
    assert.equal(families[0]!.byEffort.low?.id, "gemini-4-neon-low");
    assert.equal(families[0]!.byEffort.high?.id, "gemini-4-neon-high");
  });

  it("換家族預設 Low；Medium／High 解析互斥", () => {
    const fam = buildModelFamilies([
      opt({
        id: "agy-claude-sonnet-5-5-low",
        label: "Claude Sonnet 5.5 · Low",
        familyId: "agy-claude-sonnet-5-5",
        familyLabel: "Claude Sonnet 5.5",
        effort: "low",
        categoryLabel: "Claude",
      }),
      opt({
        id: "agy-claude-sonnet-5-5-medium",
        label: "Claude Sonnet 5.5 · Medium",
        familyId: "agy-claude-sonnet-5-5",
        familyLabel: "Claude Sonnet 5.5",
        effort: "medium",
        categoryLabel: "Claude",
      }),
      opt({
        id: "agy-claude-sonnet-5-5-high",
        label: "Claude Sonnet 5.5 · High",
        familyId: "agy-claude-sonnet-5-5",
        familyLabel: "Claude Sonnet 5.5",
        effort: "high",
        categoryLabel: "Claude",
      }),
    ])[0]!;

    assert.equal(resolveFamilyModelId(fam, "low"), "agy-claude-sonnet-5-5-low");
    assert.equal(resolveFamilyModelId(fam, "medium"), "agy-claude-sonnet-5-5-medium");
    assert.equal(resolveFamilyModelId(fam, "high"), "agy-claude-sonnet-5-5-high");
    // 取消勾選 → 回 Low
    assert.equal(resolveFamilyModelId(fam, "low"), "agy-claude-sonnet-5-5-low");
  });

  it("僅有 Medium 的家族不假裝有 Low", () => {
    const fam = buildModelFamilies([
      opt({
        id: "agy-gpt-oss-120b-medium",
        label: "GPT-OSS 120B · Medium",
        familyId: "agy-gpt-oss-120b",
        familyLabel: "GPT-OSS 120B",
        effort: "medium",
        categoryLabel: "GPT-OSS",
      }),
    ])[0]!;
    assert.deepEqual(fam.efforts, ["medium"]);
    assert.equal(resolveFamilyModelId(fam, "low"), "agy-gpt-oss-120b-medium");
  });

  it("無強度模型維持 singleton；xhigh 顯示為 High", () => {
    const fam = buildModelFamilies([
      opt({
        id: "gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        familyId: "gemini-3.1-pro",
        familyLabel: "Gemini 3.1 Pro",
      }),
    ])[0]!;
    assert.equal(fam.efforts.length, 0);
    assert.equal(fam.singleton?.id, "gemini-3.1-pro");
    assert.equal(resolveFamilyModelId(fam, "low"), "gemini-3.1-pro");

    assert.equal(
      uiEffortOf(
        opt({
          id: "gemini-4-neon-xhigh",
          label: "Gemini 4 Neon · Extra High",
          familyId: "gemini-4-neon",
          effort: "xhigh",
        }),
        "gemini-4-neon-xhigh",
      ),
      "high",
    );
  });
});
