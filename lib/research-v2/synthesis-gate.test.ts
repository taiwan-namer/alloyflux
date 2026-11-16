/**
 * Gate 不變性：移除 search_synthesis 後 status 必須一致；
 * 衝突時以 article_body 為準。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectEventsFromHit, stripSearchSynthesisFromCorpus } from "./collector";
import { gateEvidence } from "./gate";
import { CLAIM_CHARS_COMPACT, CLAIM_CHARS_DEFAULT, CLAIM_CHARS_DEEP_BODY, formatVerdictInjection, resolveClaimCharCap } from "./inject";
import { runResearchPipelineV2 } from "./pipeline";
import { planResearch } from "./planner";
import type { RawSearchHit, ResearchCorpus, ResearchEvent } from "./types";

function basePlan() {
  return planResearch({
    text: "川普最新消息有哪些？請附來源與日期。",
    now: new Date("2026-11-16T00:00:00.000Z"),
    timeZone: "Asia/Taipei",
  });
}

function hitWithBodyAndSynth(opts?: { conflictingSynth?: boolean }): RawSearchHit {
  const body =
    "President Trump spoke on November 15 about the nationwide ground stop and asked Congress for funding to upgrade air traffic control systems. Officials said the outage affected major hubs.";
  const synthSeg = opts?.conflictingSynth
    ? "President Trump spoke on November 15 about the nationwide ground stop and asked Congress for funding to upgrade air traffic control systems"
    : "A separate search summary claims an unrelated APEC summit side deal was signed in Lima without any article body backing.";
  return {
    provider: "test",
    queries: ["trump news"],
    sources: [
      {
        title: "Example News",
        uri: "https://example.com/news/trump-ground-stop-2026",
      },
    ],
    pages: [
      {
        uri: "https://example.com/news/trump-ground-stop-2026",
        title: "Trump on ground stop",
        excerpt: body,
        fetchStatus: "ok",
        publishedAt: "2026-11-15T16:00:00.000Z",
      },
    ],
    brief: "unconfirmed lead",
    rawGroundingSupports: [
      {
        segment: { text: synthSeg },
      },
    ],
    limitations: [],
  };
}

describe("search_synthesis Gate 不變性與衝突", () => {
  it("flag 關閉時即使有 raw supports 也不注入 synthesis", () => {
    delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    const plan = basePlan();
    const corpus = collectEventsFromHit(plan, hitWithBodyAndSynth());
    const synthClaims = corpus.events.flatMap((e) => e.claims).filter((c) => c.provenance === "search_synthesis");
    assert.equal(synthClaims.length, 0);
    assert.ok(corpus.limitations.some((l) => l.includes("search_synthesis_disabled_by_flag")));
  });

  it("移除 synthesis 後 Gate status 完全一致", () => {
    process.env.RESEARCH_SEARCH_SYNTHESIS = "1";
    try {
      const plan = basePlan();
      const corpus = collectEventsFromHit(plan, hitWithBodyAndSynth());
      const withSynth = gateEvidence({ plan, corpus });
      const stripped = stripSearchSynthesisFromCorpus(corpus);
      const without = gateEvidence({ plan, corpus: stripped });
      assert.equal(withSynth.status, without.status);
      assert.equal(withSynth.completionStatus, without.completionStatus);
      assert.equal(withSynth.showVerifiedBadge, without.showVerifiedBadge);
      const remainingSynth = stripped.events
        .flatMap((e) => e.claims)
        .filter((c) => c.provenance === "search_synthesis");
      assert.equal(remainingSynth.length, 0);
    } finally {
      delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    }
  });

  it("synthesis 與 article_body 衝突時以正文為準並標記", () => {
    process.env.RESEARCH_SEARCH_SYNTHESIS = "1";
    try {
      const plan = basePlan();
      const corpus = collectEventsFromHit(plan, hitWithBodyAndSynth({ conflictingSynth: true }));
      assert.ok(
        corpus.limitations.some((l) => l.startsWith("synthesis_conflict_article_body_wins:")),
        "應標記衝突",
      );
      const standaloneSynthEvents = corpus.events.filter(
        (e) =>
          e.claims.length > 0 &&
          e.claims.every((c) => c.provenance === "search_synthesis") &&
          !e.claims.some((c) => c.statement.includes("衝突｜以正文為準")),
      );
      assert.equal(standaloneSynthEvents.length, 0, "衝突不得另建未標註的 synth 事件");
      const conflictNotes = corpus.events.flatMap((e) => e.claims).filter((c) =>
        c.statement.includes("衝突｜以正文為準"),
      );
      assert.ok(conflictNotes.length >= 1);
      const bodyClaims = corpus.events.flatMap((e) => e.claims).filter((c) => c.provenance === "article_body");
      assert.ok(bodyClaims.length >= 1);
    } finally {
      delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    }
  });

  it("純手工 corpus：strip 後 Gate 不變", () => {
    const plan = basePlan();
    const bodyEvent: ResearchEvent = {
      eventId: "evt_body",
      title: "Body event",
      topic: "other",
      publishedAt: "2026-11-15T00:00:00.000Z",
      claims: [
        {
          claimId: "clm_body",
          statement: "Trump addressed the ground stop on Nov 15.",
          claimType: "reported_fact",
          sourceIds: ["src_1"],
          evidenceLevel: "moderate",
          provenance: "article_body",
        },
      ],
      sourceIds: ["src_1"],
      relevance: 0.9,
      freshness: 0.9,
      diversityKey: "other",
      evidenceGrade: "body_with_date",
    };
    const synthEvent: ResearchEvent = {
      eventId: "evt_synth",
      title: "Synth only",
      topic: "other",
      claims: [
        {
          claimId: "clm_synth",
          statement: "【搜尋摘要，未經原文核對】APEC side deal in Lima",
          claimType: "unconfirmed",
          sourceIds: ["src_1"],
          evidenceLevel: "insufficient",
          provenance: "search_synthesis",
        },
      ],
      sourceIds: ["src_1"],
      relevance: 0.45,
      freshness: 0.5,
      diversityKey: "other",
      evidenceGrade: "title_only",
    };
    const corpus: ResearchCorpus = {
      plan,
      sources: [
        {
          sourceId: "src_1",
          title: "Example",
          uri: "https://example.com/a",
          originalUrl: "https://example.com/a",
          host: "example.com",
          quality: "preferred",
          provenance: "article_body",
          fetchStatus: "ok",
          publishedAt: "2026-11-15T00:00:00.000Z",
        },
      ],
      events: [bodyEvent, synthEvent],
      queriesUsed: ["q"],
      pagesFetched: 1,
      limitations: [],
      stats: {
        rawSourceCount: 1,
        dedupedSourceCount: 1,
        rawEventCount: 2,
        dedupedEventCount: 2,
        truncatedEvents: 0,
        excluded: [],
        bodyWithDate: 1,
        bodyMissingDate: 0,
        titleOnly: 1,
      },
    };
    const a = gateEvidence({ plan, corpus });
    const b = gateEvidence({ plan, corpus: stripSearchSynthesisFromCorpus(corpus) });
    assert.equal(a.status, b.status);
  });

  it("層 2 防爬（合格正文 < 2 篇）時，管線自動開啟 search_synthesis 與 brief 雙重保底", async () => {
    delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    // 模擬政府／律所網站 403 抓不到正文，但層 1 有 grounding URL 與 Flash 摘要／supports
    const blockedHit: RawSearchHit = {
      provider: "test",
      queries: ["SEC Ripple ruling details"],
      sources: [
        {
          title: "SEC v. Ripple Ruling Analysis - Law Firm Memo",
          uri: "https://reuters.com/legal/sec-ripple-case-2026",
        },
      ],
      pages: [], // 層 2 全數防爬失敗
      brief:
        "法院在該案裁定機構銷售構成投資契約，但交易所程式化銷售不構成證券發行，並對違規部分處以民事罰金。",
      rawGroundingSupports: [
        {
          segment: {
            text: "The court held that institutional sales satisfied Howey while programmatic exchange sales did not constitute investment contracts.",
          },
        },
      ],
      limitations: [],
    };

    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "幫我細查 SEC v. Ripple 判例細節與條款" }],
      now: new Date("2026-11-16T00:00:00.000Z"),
      mockHit: blockedHit,
    });

    assert.equal(verdict.status, "partial");
    assert.ok(
      verdict.warnings.some((w) => w.startsWith("search_synthesis_auto_fallback_enabled")),
      "應記錄觸發自動備援",
    );
    assert.match(verdict.injectionText, /Howey|程式化銷售/);
  });

  it("單條 claim 動態截斷上限：<=3 事件正文放寬至 800 字，一般 500 字，壓縮 240 字", () => {
    assert.equal(resolveClaimCharCap(2, "article_body", false), CLAIM_CHARS_DEEP_BODY);
    assert.equal(resolveClaimCharCap(3, "official_document", false), 800);
    assert.equal(resolveClaimCharCap(5, "article_body", false), CLAIM_CHARS_DEFAULT);
    assert.equal(resolveClaimCharCap(1, "search_synthesis", false), 500);
    assert.equal(resolveClaimCharCap(1, "article_body", true), CLAIM_CHARS_COMPACT);

    const plan = basePlan();
    const longBody = "法條細節與判決理由完整段落內容。".repeat(45); // ~720 字（> 560 舊上限、< 800 新上限）
    const corpus = collectEventsFromHit(plan, {
      provider: "test",
      queries: ["ruling full text"],
      sources: [{ title: "Reuters Legal", uri: "https://reuters.com/legal/ruling-2026" }],
      pages: [
        {
          uri: "https://reuters.com/legal/ruling-2026",
          title: "Ruling Full Text",
          excerpt: longBody,
          fetchStatus: "ok",
          publishedAt: "2026-11-15T12:00:00.000Z",
        },
      ],
      brief: "",
      limitations: [],
    });
    const verdict = gateEvidence({ plan, corpus });
    const injected = formatVerdictInjection(verdict);
    // 720 字應完整保留，不被舊版 320 或 560 字腰斬
    assert.ok(injected.includes(longBody.slice(0, 700)), "700+ 字單篇深度正文不應被 320/560 腰斬");
  });
});
