/**
 * Gate 不變性：移除 search_synthesis 後 status 必須一致；
 * 衝突時以 article_body 為準。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectEventsFromHit,
  splitLongBodyExcerpt,
  stripSearchSynthesisFromCorpus,
} from "./collector";
import { gateEvidence } from "./gate";
import {
  CLAIM_CHARS_COMPACT,
  CLAIM_CHARS_DEFAULT,
  CLAIM_CHARS_DEEP_BODY,
  formatVerdictInjection,
  resolveClaimCharCap,
} from "./inject";
import { runResearchPipelineV2 } from "./pipeline";
import { planResearch } from "./planner";
import { shouldEnableSearchSynthesis } from "./synthesis-flag";
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

  it("單條 claim 動態截斷上限：<=3 事件正文放寬至 750 字，一般 500 字，壓縮 240 字", () => {
    assert.equal(resolveClaimCharCap(2, "article_body", false), CLAIM_CHARS_DEEP_BODY);
    assert.equal(resolveClaimCharCap(3, "official_document", false), 750);
    assert.equal(resolveClaimCharCap(5, "article_body", false), CLAIM_CHARS_DEFAULT);
    assert.equal(resolveClaimCharCap(1, "search_synthesis", false), 500);
    assert.equal(resolveClaimCharCap(1, "article_body", true), CLAIM_CHARS_COMPACT);

    const plan = basePlan();
    const longBody = "法條細節與判決理由完整段落內容。".repeat(45); // ~675 字
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
    assert.ok(injected.includes(longBody.slice(0, 600)), "深度正文不應被 320/560 腰斬");
  });

  it("長正文 >700 字應切成最多 3 段 claims，中後段費率細節可注入", () => {
    const parts = splitLongBodyExcerpt(
      [
        "OpenRouter FAQ 開頭：平台彙總多家模型 API。",
        "中段說明路由與用量統計 while pooling requests across providers.",
        "後段關鍵：平台向使用者收取約 5.5% 手續費，並另計上游模型成本。FEE_RATE_MARKER_55",
      ].join("\n\n") + "\n" + "補充條款段落內容。".repeat(80),
    );
    assert.ok(parts.length >= 2 && parts.length <= 3, `應切 2~3 段，實際 ${parts.length}`);
    assert.ok(parts.some((p) => /FEE_RATE_MARKER_55|5\.5%/.test(p)), "中後段費率標記不可丟");

    const plan = planResearch({
      text: "OpenRouter 怎麼運作？抽成與計費細節？",
      now: new Date("2026-11-16T00:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    const longFaq =
      "OpenRouter FAQ start while pooling requests across providers for latency. ".repeat(8) +
      "\n\nMid section explains credits and provider markup. ".repeat(6) +
      "\n\nFinal billing: OpenRouter charges approximately 5.5% platform fee on top of upstream model costs. FEE_RATE_MARKER_55";
    const corpus = collectEventsFromHit(plan, {
      provider: "test",
      queries: ["OpenRouter fee"],
      sources: [{ title: "OpenRouter FAQ", uri: "https://openrouter.ai/docs/faq" }],
      pages: [
        {
          uri: "https://openrouter.ai/docs/faq",
          title: "OpenRouter FAQ",
          excerpt: longFaq.slice(0, 1800),
          fetchStatus: "ok",
        },
      ],
      brief: "",
      limitations: [],
    });
    const bodyClaims = corpus.events.flatMap((e) => e.claims).filter((c) => c.provenance === "article_body");
    assert.ok(bodyClaims.length >= 2, `長 FAQ 應產生多段正文 claim，實際 ${bodyClaims.length}`);
    const injected = formatVerdictInjection(gateEvidence({ plan, corpus }));
    assert.ok(
      injected.includes("FEE_RATE_MARKER_55") || injected.includes("5.5%"),
      "注入文字必須保留 FAQ 中後段費率，不可停在 while poo…",
    );
    assert.match(injected, /直接整合回答|不必|不要在開頭反覆/);
  });

  it("autoFallback：任一 title_only 或 factcheck 即開啟；brief 無條件掛入", () => {
    delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    assert.equal(
      shouldEnableSearchSynthesis({
        autoFallback: true,
        validBodyPageCount: 2,
        bodyClaimCount: 2,
        titleOnlySourceCount: 1,
      }).reason,
      "auto_fallback",
    );
    assert.equal(
      shouldEnableSearchSynthesis({
        autoFallback: true,
        validBodyPageCount: 3,
        bodyClaimCount: 3,
        titleOnlySourceCount: 0,
        intent: "factcheck",
      }).reason,
      "auto_fallback",
    );
    assert.equal(
      shouldEnableSearchSynthesis({
        autoFallback: true,
        validBodyPageCount: 2,
        bodyClaimCount: 2,
        titleOnlySourceCount: 0,
        intent: "news",
      }).reason,
      "default_off",
    );

    // 模擬 Akin Gump：2 篇配角有正文、主角律所 title_only；brief 含關鍵事實
    const plan = planResearch({
      text: "請詳細分析 Akin Gump 對此案的法律意見與角色分工",
      now: new Date("2026-11-16T00:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    const corpus = collectEventsFromHit(
      plan,
      {
        provider: "test",
        queries: ["Akin Gump analysis"],
        sources: [
          { title: "Akin Gump Memo", uri: "https://akingump.com/en/insights/alert/case-note" },
          { title: "The Record coverage", uri: "https://therecord.media/case-coverage-2026" },
          { title: "Malpedia entry", uri: "https://malpedia.caad.fkie.fraunhofer.de/details/win.x" },
        ],
        pages: [
          {
            uri: "https://akingump.com/en/insights/alert/case-note",
            title: "Akin Gump Memo",
            excerpt: "",
            fetchStatus: "failed",
          },
          {
            uri: "https://therecord.media/case-coverage-2026",
            title: "The Record coverage",
            excerpt:
              "Secondary outlet summarized the dispute and named outside counsel without quoting the firm memo body. ".repeat(
                3,
              ),
            fetchStatus: "ok",
            publishedAt: "2026-11-14T10:00:00.000Z",
          },
          {
            uri: "https://malpedia.caad.fkie.fraunhofer.de/details/win.x",
            title: "Malpedia entry",
            excerpt:
              "Malpedia lists malware family aliases and technical indicators related to the campaign. ".repeat(3),
            fetchStatus: "ok",
            publishedAt: "2026-11-13T08:00:00.000Z",
          },
        ],
        brief:
          "Akin Gump advised the client on Storm-2139 attribution and recommended coordinated disclosure with counsel leading regulatory outreach; partners split litigation vs advisory roles.",
        rawGroundingSupports: [
          {
            segment: {
              text: "Search snippet only lists the Akin Gump URL without body text.",
            },
          },
        ],
        limitations: [],
      },
      { autoSynthesisFallback: true },
    );

    assert.ok(
      corpus.sources.some((s) => s.host?.includes("akingump") && s.provenance === "title_only"),
      "主角應為 title_only",
    );
    assert.ok(
      corpus.limitations.some((l) => l.startsWith("search_synthesis_auto_fallback_enabled")),
      "即使已有 2 篇配角正文，title_only 也應觸發備援",
    );
    assert.ok(
      corpus.limitations.some((l) => l.startsWith("search_synthesis_from_flash_brief_fallback")),
      "auto_fallback 應無條件掛入 brief",
    );
    const injected = formatVerdictInjection(gateEvidence({ plan, corpus }));
    assert.match(injected, /Storm-2139|coordinated disclosure|Akin Gump advised/i);
  });
});
