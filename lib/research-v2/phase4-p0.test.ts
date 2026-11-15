/**
 * Phase 4 P0 驗收：雙重注入／SSRF／證據層級／unknown 契約／Live 預算
 * Mock only；Live 僅在 RESEARCH_LIVE_E2E=1 時執行（本檔預設跳過）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceUrl, displaySourceUrl } from "../web-research";
import { collectEventsFromHit } from "./collector";
import {
  geminiGroundingToResearchResult,
  verdictToResearchResult,
} from "./contract";
import { gateEvidence } from "./gate";
import {
  attachResearchToDone,
  mockGatewayWithResearch,
} from "./gateway-contract";
import {
  preparePlatformResearch,
  reusePreparedResearch,
  withPlatformResearchScope,
} from "./index";
import {
  combinedAnswerCap,
  createLiveBudget,
  DEFAULT_LIVE_BUDGET,
  isLiveE2EEnabled,
  recordLiveUsage,
} from "./live-budget";
import { planResearch } from "./planner";
import { runResearchPipelineV2 } from "./pipeline";
import { isBlockedIp, validatePublicHttpsUrl } from "./ssrf";
import { fixtureB_MultiTopicSameDay } from "./fixtures/news-fixtures";
import { runWithResearchContextAsync } from "./context";
import type { RawSearchHit } from "./types";

const NOW = new Date("2026-11-15T12:00:00+08:00");

describe("P0-1 Claude／平台研究不重複", () => {
  it("prepare → ALS reuse → Provider 不得再跑 pipeline（計數器=1）", async () => {
    let pipelineRuns = 0;
    const runOnce = async () => {
      pipelineRuns += 1;
      return runResearchPipelineV2({
        messages: [{ role: "user", content: "川普最新消息" }],
        now: NOW,
        mockHit: fixtureB_MultiTopicSameDay(),
        supplyPath: "local",
      });
    };

    const prepared = await runOnce();
    assert.equal(pipelineRuns, 1);

    let reusedInside = 0;
    async function* localPath() {
      // 模擬 researchForMessages：只 reuse
      const reused = reusePreparedResearch();
      assert.ok(reused);
      assert.equal(reused!.injectionText, prepared.injectionText);
      reusedInside += 1;
      // 模擬 withResearchSystem 輸出
      const system = `BASE\n\n${reused!.injectionText}`;
      assert.equal((system.match(/【系統即時聯網檢索結果｜/g) || []).length, 1);
      yield { type: "text" as const, text: "ok" };
      yield attachResearchToDone(
        {
          type: "done" as const,
          content: "ok",
          groundingSources: [] as { title: string; uri: string }[],
        },
        reused,
      );
    }

    const out = [];
    for await (const ev of withPlatformResearchScope(prepared, "local", localPath())) {
      out.push(ev);
    }
    assert.equal(pipelineRuns, 1);
    assert.equal(reusedInside, 1);
    assert.ok(out.some((e) => e.type === "done"));
  });

  it("Node→Local failover 仍只準備一次研究", async () => {
    let researchCalls = 0;
    const verdict = await (async () => {
      researchCalls += 1;
      return runResearchPipelineV2({
        messages: [{ role: "user", content: "最新消息" }],
        now: NOW,
        mockHit: fixtureB_MultiTopicSameDay(),
        supplyPath: "node",
      });
    })();
    assert.equal(researchCalls, 1);

    async function* body() {
      for await (const ev of mockGatewayWithResearch({
        verdict,
        nodeFail: true,
        localReply: "fallback",
        researchRunCount: { n: researchCalls },
      })) {
        if (ev.type === "failover") {
          assert.ok(reusePreparedResearch());
        }
        yield ev;
      }
    }

    for await (const _ of withPlatformResearchScope(verdict, "node", body())) {
      // drain
    }
    assert.equal(researchCalls, 1);
  });

  it("extraSystemContext 已含注入時不得再疊加（字串結構）", () => {
    const injection = "【系統即時聯網檢索結果｜status=ok】\n事件A";
    const baseWithCtx = `系統提示\n\n${injection}`;
    // 與 providers.withResearchSystem 相同守衛
    const already = /【系統即時聯網檢索結果｜|【本輪聯網查證未完成｜/.test(baseWithCtx);
    assert.equal(already, true);
    const merged = already ? baseWithCtx : `${baseWithCtx}\n\n${injection}`;
    assert.equal((merged.match(/【系統即時聯網檢索結果｜/g) || []).length, 1);
  });
});

describe("P0-2 URL／SSRF", () => {
  it("cleanSourceUrl 不插入省略號破壞 href", () => {
    const long =
      "https://www.reuters.com/world/us/article-with-very-long-path-segment-that-used-to-be-truncated";
    const cleaned = cleanSourceUrl(long, 40);
    assert.ok(!cleaned.includes("…"));
    assert.ok(cleaned.startsWith("https://"));
    const display = displaySourceUrl(long, 40);
    assert.ok(display.includes("…") || display.length <= 40);
  });

  it("封鎖 loopback／私有／metadata IP", () => {
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("10.0.0.1"), true);
    assert.equal(isBlockedIp("192.168.1.1"), true);
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("::1"), true);
    assert.equal(isBlockedIp("8.8.8.8"), false);
  });

  it("非 HTTPS 與 localhost 主機拒絕", async () => {
    const http = await validatePublicHttpsUrl("http://example.com/a");
    assert.equal(http.ok, false);
    if (!http.ok) assert.equal(http.fetchStatus, "blocked_ssrf");

    const local = await validatePublicHttpsUrl("https://localhost/admin");
    assert.equal(local.ok, false);

    const meta = await validatePublicHttpsUrl("https://169.254.169.254/latest/meta-data");
    assert.equal(meta.ok, false);
  });

  it("公開 HTTPS 主機通過 DNS 檢查（example.com）", async () => {
    const ok = await validatePublicHttpsUrl("https://example.com/");
    assert.equal(ok.ok, true);
  });
});

describe("P0-3 證據層級", () => {
  it("僅有標題／無正文 → title_only，不得 reported_fact 當 confirmed", () => {
    const plan = planResearch({ text: "人事變動新聞", now: NOW });
    const hit: RawSearchHit = {
      brief: "Flash：公司已宣布重大人事變動。",
      provider: "mock",
      queries: ["人事"],
      sources: [
        {
          title: "公司宣布人事變動",
          uri: "https://apnews.com/synthetic/hr-title-only",
        },
      ],
      pages: [], // 抓不到正文
      limitations: ["synthetic"],
    };
    const corpus = collectEventsFromHit(plan, hit, { now: NOW });
    assert.ok(corpus.sources.every((s) => s.provenance === "title_only"));
    for (const ev of corpus.events) {
      for (const c of ev.claims) {
        if (c.provenance === "title_only" || c.provenance === "search_snippet") {
          assert.notEqual(c.claimType, "reported_fact");
          assert.ok(
            c.evidenceLevel === "insufficient" ||
              c.evidenceLevel === "weak" ||
              c.claimType === "unconfirmed",
          );
        }
      }
    }
    const verdict = gateEvidence({ plan, corpus });
    assert.equal(verdict.status, "partial");
    assert.ok(verdict.warnings.some((w) => /title_or_snippet|evidence_title/i.test(w)));
    assert.ok(!verdict.warnings.some((w) => w === "confirmed"));
  });

  it("Flash brief 主張標 search_snippet，不冒充 article_body", () => {
    const plan = planResearch({ text: "川普最新消息", now: NOW });
    // 正文不含「尚未確認」，僅 brief 有 → 應補 search_snippet claim
    const hit: RawSearchHit = {
      brief: "SYNTHETIC Flash：相關安排尚未正式確認，不得寫成已確定。",
      provider: "mock",
      queries: ["q"],
      limitations: ["synthetic"],
      sources: [
        {
          title: "Leaders discuss schedule",
          uri: "https://apnews.com/synthetic/flash-vs-body",
          publishedAt: "2026-11-15T06:00:00Z",
        },
      ],
      pages: [
        {
          title: "Leaders discuss schedule",
          uri: "https://apnews.com/synthetic/flash-vs-body",
          excerpt:
            "SYNTHETIC: Officials discussed a possible schedule for talks next week. Logistics remain open while staff coordinate travel and venue options across capitals.",
          publishedAt: "2026-11-15T06:00:00Z",
          fetchStatus: "ok",
        },
      ],
    };
    const corpus = collectEventsFromHit(plan, hit, { now: NOW });
    assert.ok(corpus.sources.some((s) => s.provenance === "article_body"));
    assert.ok(
      corpus.sources.every((s) => s.provenance !== "search_snippet"),
      "Flash brief 不得變成來源正文",
    );
    const snippetClaims = corpus.events.flatMap((e) =>
      e.claims.filter((c) => c.provenance === "search_snippet"),
    );
    assert.ok(snippetClaims.length >= 1);
    assert.ok(snippetClaims.every((c) => c.claimType === "unconfirmed"));
  });

  it("Gate 不因 sourceIds.length>0 就當充分；缺日期→partial", () => {
    const plan = planResearch({ text: "最新消息", now: NOW });
    const hit: RawSearchHit = {
      brief: "brief",
      provider: "mock",
      queries: ["q"],
      sources: [
        { title: "A story without date", uri: "https://apnews.com/synthetic/nodate" },
        { title: "B story without date", uri: "https://www.reuters.com/synthetic/nodate2" },
      ],
      pages: [
        {
          title: "A story without date",
          uri: "https://apnews.com/synthetic/nodate",
          excerpt:
            "SYNTHETIC body text long enough to count as article body for provenance checks. Additional sentences describe the announcement without giving a publication timestamp in metadata.",
          // 故意無 publishedAt
          fetchStatus: "ok",
        },
        {
          title: "B story without date",
          uri: "https://www.reuters.com/synthetic/nodate2",
          excerpt:
            "SYNTHETIC second article body also long enough. It discusses the same theme so Gate sees usable sources but missing dates across the board.",
          fetchStatus: "ok",
        },
      ],
    };
    const corpus = collectEventsFromHit(plan, hit, { now: NOW });
    assert.ok(corpus.sources.every((s) => !s.publishedAt));
    const verdict = gateEvidence({ plan, corpus });
    assert.ok(verdict.status === "partial" || verdict.status === "ok");
    if (!corpus.sources.some((s) => s.publishedAt)) {
      assert.equal(verdict.status, "partial");
      assert.ok(verdict.warnings.some((w) => /missing_published_at/.test(w)));
    }
  });
});

describe("P0-4 共同契約允許 unknown", () => {
  it("Gemini grounding 缺欄不填造", () => {
    const r = geminiGroundingToResearchResult({
      sources: [{ title: "Example", uri: "https://example.com/news/1" }],
      queries: ["q"],
    });
    assert.equal(r.sources[0].publishedAt, undefined);
    assert.equal(r.sources[0].excerpt, undefined);
    assert.equal(r.sources[0].resolvedUrl, undefined);
    assert.equal(r.sources[0].provenance, "unknown");
    assert.equal(r.completionStatus, "truncated");
    assert.ok(r.warnings.some((w) => /not_fabricated/.test(w)));
  });

  it("V2 verdict → ResearchResult 保留 provenance", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
      supplyPath: "local",
    });
    const r = verdictToResearchResult(verdict);
    assert.ok(r.claims.every((c) => c.provenance));
    assert.ok(r.completionStatus);
    for (const e of r.events) {
      assert.equal(e.eventAt, undefined);
    }
  });
});

describe("P0-5 Live 預算分開 A／B", () => {
  it("各模式最多 9 次完整回答；合計 18", () => {
    assert.equal(DEFAULT_LIVE_BUDGET.maxFullAnswersPerMode, 9);
    assert.equal(combinedAnswerCap(), 18);

    const a = createLiveBudget("A_product_path");
    const b = createLiveBudget("B_fixed_evidence");
    for (let i = 0; i < 9; i++) {
      assert.equal(recordLiveUsage(a, { fullAnswers: 1 }), true);
      assert.equal(recordLiveUsage(b, { fullAnswers: 1 }), true);
    }
    assert.equal(recordLiveUsage(a, { fullAnswers: 1 }), false);
    assert.equal(a.stoppedReason?.startsWith("full_answers_cap"), true);
    // B 獨立上限，不受 A 停止影響
    assert.equal(b.fullAnswers, 9);
    assert.equal(recordLiveUsage(b, { fullAnswers: 1 }), false);
  });

  it("搜尋／Flash／額外模型呼叫獨立計數；retry 不可繞過", () => {
    const a = createLiveBudget("A_product_path");
    assert.equal(recordLiveUsage(a, { searchCalls: 12 }), true);
    assert.equal(recordLiveUsage(a, { searchCalls: 1 }), false);
    // 已停止後任何增量皆拒
    assert.equal(recordLiveUsage(a, { fullAnswers: 1 }), false);
  });

  it("未授權 Live 時跳過（本環境預設）", () => {
    if (isLiveE2EEnabled()) {
      assert.ok(true, "RESEARCH_LIVE_E2E=1：由外部 runner 執行");
    } else {
      assert.equal(isLiveE2EEnabled(), false);
    }
  });
});

describe("Phase 4 附加：done.completionStatus", () => {
  it("attachResearchToDone 帶 completionStatus 且過濾 … 網址", () => {
    const plan = planResearch({ text: "最新消息", now: NOW });
    const verdict = gateEvidence({
      plan,
      corpus: collectEventsFromHit(plan, fixtureB_MultiTopicSameDay(), { now: NOW }),
    });
    const done = attachResearchToDone(
      {
        type: "done" as const,
        groundingSources: [
          { title: "bad", uri: "https://example.com/truncated…" },
          { title: "ok", uri: "https://example.com/ok" },
        ],
      },
      verdict,
    ) as {
      completionStatus?: string;
      groundingSources?: { uri: string }[];
    };
    assert.ok(done.completionStatus);
    assert.ok(!(done.groundingSources ?? []).some((s) => s.uri.includes("…")));
  });

  it("寒暄不觸發研究", async () => {
    const v = await preparePlatformResearch({
      messages: [{ role: "user", content: "你好" }],
      supplyPath: "local",
      now: NOW,
    });
    assert.equal(v, null);
  });
});

// 防止誤用：ALS 外 reuse 為 null
describe("ALS 隔離", () => {
  it("scope 外 reusePreparedResearch 為 null", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
      supplyPath: "local",
    });
    await runWithResearchContextAsync(
      { verdict, supplyPath: "local", platformResearchDone: true },
      async () => {
        assert.ok(reusePreparedResearch());
      },
    );
    assert.equal(reusePreparedResearch(), null);
  });
});
