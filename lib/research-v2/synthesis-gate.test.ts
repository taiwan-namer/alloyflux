/**
 * Gate 不變性：移除 search_synthesis 後 status 必須一致；
 * 衝突時以 article_body 為準。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slideMessagesForUpstream } from "../context-window";
import { effectiveSourceHost, pickSourcesDiverse } from "../web-research";
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

  it("pickSourcesDiverse 穿透 vertexaisearch 轉址並優先挑選問題點名官網與法院卷宗", () => {
    const sources = [
      {
        title: "activepieces.com",
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa",
      },
      {
        title: "randomblog.example.org",
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb",
      },
      {
        title: "OpenRouter Docs — Provider Routing",
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ccc",
      },
      {
        title: "openrouter.ai",
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ddd",
      },
    ];
    assert.equal(effectiveSourceHost(sources[0]!), "activepieces.com");
    assert.equal(effectiveSourceHost(sources[3]!), "openrouter.ai");

    const picked = pickSourcesDiverse(
      sources,
      2,
      "幫我細查 OpenRouter 是如何運作的？路由機制與計費抽成方式",
    );
    assert.equal(picked.length, 2);
    assert.ok(
      picked.every((s) => /openrouter/i.test(s.title)),
      `應優先抓 OpenRouter 官方來源而非第三方部落格，實際：${picked.map((p) => p.title).join(", ")}`,
    );
  });

  it("深度查證：Planner 產出英文交叉查詢詞，且 >900 字層 1 brief 分段完整注入不腰斬", () => {
    const plan = planResearch({
      text: "幫我細查 Microsoft 起訴 Storm-2139 的訴訟判例與案號，他們具體是怎麼破解或濫用 API 的？",
      now: new Date("2026-11-16T00:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    assert.equal(plan.intent, "factcheck");
    assert.ok(plan.queries.length >= 2, "應同時產出中文主查詢與英文精準補充查詢");
    assert.match(plan.queries[1]!, /Microsoft.*Storm-2139.*docket|default judgment/i);

    const richBrief = [
      "1. 案號與進度：Microsoft Corp. v. Arian Yadegarnia et al., Civil Action No. 1:24-cv-02323-MSN-WEF (E.D. Va.)，2024/12/19 秘密起訴（Filed Under Seal）並取得暫時禁制令（TRO）扣押核心網域 aitism.net。",
      "2. 第一修正起訴狀（First Amended Complaint, Dkt. No. 41，2025/02/28）正式點名四位跨國被告：Arian Yadegarnia（化名 Fiz，伊朗）、Alan Krysiak（化名 Drago，英國）、Ricky Yuen（化名 cg-dot，香港）、Phát Phùng Tấn（化名 Asakuri，越南），另有美國境內涉案者配合刑事調查未公開。",
      "3. 技術工具鏈（LLMjacking 雙層架構）：自動化爬蟲搜刮 GitHub 公開儲存庫誤傳之 52 字元 Azure OpenAI Service API Keys，透過 Cloudflare Tunnels 架設 oai-reverse-proxy 隱藏真實 IP 並繞過地理圍欄，搭配客製化前端工具 de3u（託管於 GitHub 與 rentry.org/de3u）進行提示詞改寫以繞過內容安全分類器。",
      "4. 微軟主張法條（Dkt. No. 41）：CFAA（18 U.S.C. § 1030）、DMCA（17 U.S.C. § 1201(a)(1) & (a)(2)）、Lanham Act（15 U.S.C. § 1125(a) 虛假產地標示）、RICO（18 U.S.C. § 1962(c) 電信詐欺與存取設備詐欺）及普通法動產侵害與侵權干預契約。",
      "5. 角色分類勘誤與 Akin Gump 篇幅：Akin Gump 2025/03/17 文章僅為約 220 字兩段式 Tracker 短訊；微軟官方定義三類角色為 Creators、Providers、Users（原文寫 Providers modified and supplied these tools to end users，並非把第三類命名為 Supplier）。",
      "6. 最新法院進展（2026/05/26 Dkt. No. 71）：聯邦治安法官 William E. Fitzpatrick 已提交長達 33 頁建議書，建議法院准許微軟對違約被告作出缺席判決（Default Judgment）與永久禁制令。TAIL_DKT_71_MARKER",
    ].join("\n");
    assert.ok(richBrief.length > 900, `測試 brief 應超過 900 字以驗證 3 段切分，實際 ${richBrief.length}`);

    const corpus = collectEventsFromHit(
      plan,
      {
        provider: "test",
        queries: plan.queries,
        sources: [
          {
            title: "courtlistener.com",
            uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/dkt71",
            resolvedUrl: "https://www.courtlistener.com/docket/69480000/microsoft-corporation-v-does-1-10/",
          },
        ],
        pages: [],
        brief: richBrief,
        limitations: [],
      },
      { autoSynthesisFallback: true },
    );

    const injected = formatVerdictInjection(gateEvidence({ plan, corpus }));
    assert.ok(injected.includes("TAIL_DKT_71_MARKER"), "超過 500 字的層 1 brief 尾部 Dkt. 71 不得被截斷");
    assert.ok(
      injected.includes("https://www.courtlistener.com/docket/69480000/microsoft-corporation-v-does-1-10"),
      "即使防爬未抓到正文，解開後的真實 resolvedUrl 也應保留給模型與前端",
    );
  });

  it("多輪對話滑動視窗：前幾輪 1,200 字回答完整保留，不在 300 字處腰斬名單與工具名", () => {
    const claudeQ1 =
      "結論：這是一件民事訴訟，案名 Microsoft Corp. v. Does 1–10，案號 1:24-cv-2323（E.D. Va.）。".repeat(5) +
      "\n修正訴狀點名 4 人：Arian Yadegarnia、Alan Krysiak、Ricky Yuen、Phát Phùng Tấn。\n" +
      "濫用工具鏈：自製工具 de3u 加反向代理，主張 CFAA、DMCA §1201、Lanham Act、RICO。";
    assert.ok(claudeQ1.length > 350 && claudeQ1.length < 1800);

    const msgs = slideMessagesForUpstream([
      { role: "user", content: "問題一：Storm-2139 案號與法條？" },
      { role: "assistant", content: claudeQ1 },
      { role: "user", content: "問題二：Akin Gump 分析？" },
      { role: "assistant", content: "Akin Gump 摘要說明。" },
      { role: "user", content: "幫我對照前面回答查到與沒查到的項目" },
    ]);

    const keptQ1 = msgs[1]!.content;
    assert.ok(keptQ1.includes("Arian Yadegarnia"), "前幾輪回答中的被告姓名不得被 300 字截斷");
    assert.ok(keptQ1.includes("de3u"), "前幾輪回答中的具體工具名 de3u 不得被截斷");
  });

  it("syn_brief 在多筆空殼 title_only 與零碎 supports 競爭預算時仍保送注入", () => {
    delete process.env.RESEARCH_SEARCH_SYNTHESIS;
    const plan = planResearch({
      text: "幫我細查 OpenRouter 是如何運作的？路由機制、計費抽成方式與服務條款規範是什麼？",
      now: new Date("2026-11-16T00:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    const faqBody = "OpenRouter passes through the pricing of the underlying providers and unifies billing. ".repeat(14);
    const corpus = collectEventsFromHit(
      plan,
      {
        provider: "test",
        queries: plan.queries,
        sources: [
          { title: "OpenRouter FAQ", uri: "https://openrouter.ai/docs/faq" },
          { title: "OpenRouter Pricing", uri: "https://openrouter.ai/pricing" },
          { title: "OpenRouter Terms", uri: "https://openrouter.ai/terms" },
          { title: "Forum post 1", uri: "https://forum1.example.com/post" },
          { title: "Forum post 2", uri: "https://forum2.example.com/post" },
          { title: "Forum post 3", uri: "https://forum3.example.com/post" },
        ],
        pages: [
          {
            uri: "https://openrouter.ai/docs/faq",
            title: "OpenRouter FAQ",
            excerpt: faqBody,
            fetchStatus: "ok",
          },
        ],
        rawGroundingSupports: Array.from({ length: 6 }, (_, i) => ({
          segment: {
            text: `Minor scattered forum snippet number ${i + 1} with tangential chatter that should not crowd out pricing summary.`.repeat(
              2,
            ),
          },
        })),
        brief:
          "OpenRouter Pricing 實證：Standard 儲值收 5.5%（最低 $0.80），Business 收 8.0%，BYOK 每月前 $25,000 免路由費、超額 5%。PRICING_BRIEF_SURVIVED",
        limitations: [],
      },
      { autoSynthesisFallback: true },
    );

    const injected = formatVerdictInjection(gateEvidence({ plan, corpus }));
    assert.ok(
      injected.includes("PRICING_BRIEF_SURVIVED"),
      "層 1 關鍵 Pricing 摘要必須排在零碎 title_only／supports 之前，不得被預算擠掉",
    );
  });

  it("factcheck 官方文件無新聞 publishedAt 時，只要正文與來源齊全即判 ok（已上網查證）", () => {
    const plan = planResearch({
      text: "幫我細查 OpenRouter 是如何運作的？路由機制與計費抽成方式是什麼？",
      now: new Date("2026-11-16T00:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    assert.equal(plan.intent, "factcheck");
    assert.equal(plan.timeWindow, null);

    const corpus = collectEventsFromHit(plan, {
      provider: "test",
      queries: plan.queries,
      sources: [
        { title: "OpenRouter FAQ", uri: "https://openrouter.ai/docs/faq" },
        { title: "OpenRouter Routing", uri: "https://openrouter.ai/docs/provider-routing" },
      ],
      pages: [
        {
          uri: "https://openrouter.ai/docs/faq",
          title: "OpenRouter FAQ",
          excerpt: "OpenRouter unifies access to hundreds of models and passes through underlying provider token pricing. ".repeat(3),
          fetchStatus: "ok",
          // 官方技術文件無 publishedAt
        },
        {
          uri: "https://openrouter.ai/docs/provider-routing",
          title: "OpenRouter Provider Routing",
          excerpt: "Default routing balances effective price, TTFT, throughput, and rate-limit error rates with automatic fallbacks. ".repeat(3),
          fetchStatus: "ok",
        },
      ],
      brief: "",
      limitations: [],
    });

    const verdict = gateEvidence({ plan, corpus });
    assert.equal(verdict.status, "ok");
    assert.equal(verdict.completionStatus, "complete");
  });
});
