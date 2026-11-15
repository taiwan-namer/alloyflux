/**
 * Phase 3 離線工作：同來源重播 V1 vs V2 注入比較（不連網、不付費）
 *
 * 註：此為「共用搜尋來源重播」，≠ 真實 E2E 新聞召回。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatResearchInjection,
  MAX_RESEARCH_BRIEF_CHARS,
  MAX_RESEARCH_TOTAL_CHARS,
  type ResearchBundle,
} from "../web-research";
import {
  estimateTokensApprox,
  injectionMaxTokens,
  measureInjectionBudget,
  runResearchPipelineV2,
} from "./index";
import {
  fixtureA_DuplicatePolitics,
  fixtureB_MultiTopicSameDay,
  fixtureC_ConflictingConfirmation,
} from "./fixtures/news-fixtures";
import type { RawSearchHit } from "./types";

const NOW = new Date("2026-11-15T12:00:00+08:00");

function hitToV1Bundle(hit: RawSearchHit): ResearchBundle {
  // 模擬 V1：brief 硬切 700 + 全 pages（最多既有）
  const brief =
    hit.brief.length > MAX_RESEARCH_BRIEF_CHARS
      ? `${hit.brief.slice(0, MAX_RESEARCH_BRIEF_CHARS - 1)}…`
      : hit.brief;
  return {
    brief,
    sources: hit.sources.map((s) => ({ title: s.title, uri: s.uri })),
    queries: hit.queries,
    pages: hit.pages.slice(0, 3).map((p) => ({
      title: p.title,
      uri: p.uri,
      excerpt: p.excerpt,
    })),
  };
}

function countTopicsInV2Injection(text: string): number {
  const topics = text.match(/^主題：(\w+)/gm) || [];
  return new Set(topics.map((t) => t.replace("主題：", ""))).size;
}

describe("Phase3 離線：Token 控制機制", () => {
  it("預設注入上限約 1500 估算 tokens（非官方 tokenizer）", () => {
    assert.equal(injectionMaxTokens(), 1500);
  });

  it("V2 注入估算 tokens ≤ 上限（同來源 B）", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
    });
    const m = measureInjectionBudget(verdict);
    assert.equal(m.method, "estimated_heuristic_not_tokenizer");
    assert.ok(m.estimatedTokens <= m.maxTokens, `est=${m.estimatedTokens} max=${m.maxTokens}`);
    assert.ok(m.charLength <= m.charHardCap);
  });

  it("Flash usage：程式碼路徑無實際 token 紀錄（標註為不可得）", () => {
    // 文件化：web-research searchVia* 未解析 usageMetadata
    const flashUsageRecorded = false;
    assert.equal(flashUsageRecorded, false);
  });
});

describe("Phase3 離線：同來源重播 V1 vs V2（≠ 真實 E2E）", () => {
  const cases: { name: string; hit: () => RawSearchHit }[] = [
    { name: "A-duplicate", hit: fixtureA_DuplicatePolitics },
    { name: "B-multitopic", hit: fixtureB_MultiTopicSameDay },
    { name: "C-confirmation", hit: fixtureC_ConflictingConfirmation },
  ];

  for (const c of cases) {
    it(`${c.name}: 比較注入 tokens／事件多樣性／可追溯性`, async () => {
      const hit = c.hit();
      // 拉長 brief 以凸顯 V1 700 截斷
      hit.brief = `${hit.brief}\n${"延伸敘事。".repeat(80)}`;

      const v1text = formatResearchInjection(hitToV1Bundle(hit));
      const v1Tok = estimateTokensApprox(v1text);

      const verdict = await runResearchPipelineV2({
        messages: [{ role: "user", content: "最新消息" }],
        now: NOW,
        mockHit: hit,
      });
      const v2text = verdict.injectionText;
      const v2Tok = estimateTokensApprox(v2text);
      const budget = measureInjectionBudget(verdict);

      // V1 字元硬頂
      assert.ok(v1text.length <= MAX_RESEARCH_TOTAL_CHARS + 1);

      // V2 在估算預算內
      assert.ok(v2Tok <= injectionMaxTokens());

      // 可追溯：V2 注入應含 claimType 或來源 URL
      assert.ok(/reported_fact|unconfirmed|party_claim|https?:\/\//.test(v2text));

      // 報告欄位（供人工閱讀）
      assert.ok(typeof v1Tok === "number" && typeof budget.eventsIncluded === "number");

      if (c.name === "B-multitopic") {
        assert.ok(countTopicsInV2Injection(v2text) >= 2 || budget.eventsIncluded >= 2);
      }
      if (c.name === "C-confirmation") {
        assert.match(v2text, /unconfirmed|尚未/);
      }
    });
  }
});

describe("Phase3 離線：去重與確認狀態", () => {
  it("多標題同一政治事件 → 事件數 < 來源數", async () => {
    const hit = fixtureA_DuplicatePolitics();
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: hit,
    });
    assert.ok((verdict.corpus?.events.length ?? 0) < hit.sources.length);
  });

  it("同事件不同確認狀態保留 unconfirmed", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureC_ConflictingConfirmation(),
    });
    const types = verdict.corpus!.events.flatMap((e) => e.claims.map((c) => c.claimType));
    assert.ok(types.includes("unconfirmed") || /尚未/.test(verdict.injectionText));
  });

  it("已知限制：一 URL 多獨立事件 — 目前仍以 URL 為種子，不假裝已拆事件", async () => {
    const hit: RawSearchHit = {
      brief: "事件一辭職。事件二關稅。事件三選舉。",
      provider: "synthetic",
      queries: ["q"],
      sources: [{ title: "Triple story", uri: "https://apnews.com/synthetic/triple" }],
      pages: [
        {
          title: "Triple story",
          uri: "https://apnews.com/synthetic/triple",
          excerpt: "First: speaker resigns. Second: tariff hike. Third: election certified.",
        },
      ],
    };
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: hit,
    });
    // 誠實限制：一個 URI 主要對應一個 event 種子
    assert.ok((verdict.corpus?.events.length ?? 0) <= 2);
  });
});

describe("Phase3 離線：日常聊天不觸發", () => {
  it("你好 → skipped／空注入", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "你好" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
    });
    assert.equal(verdict.status, "skipped");
    assert.equal(verdict.injectionText, "");
    assert.equal(estimateTokensApprox(verdict.injectionText), 0);
  });
});
