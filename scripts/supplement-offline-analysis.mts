/**
 * 補件離線分析：不打 Flash／主模型。
 * 產出 docs/live-e2e/supplement-A-L-followup.json + 供報告引用的數字。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractArticleFromHtml,
  looksLikeCssOrTemplatePollution,
} from "../lib/research-v2/article-extract";
import { isUsablePageExcerpt } from "../lib/web-research";
import { collectEventsFromHit } from "../lib/research-v2/collector";
import { planResearch } from "../lib/research-v2/planner";
import type { RawSearchHit } from "../lib/research-v2/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_DIR = path.join(ROOT, "lib/research-v2/fixtures/html");
const OUT_DIR = path.join(ROOT, "docs/live-e2e");

type PageKind = "single_article" | "list_hub" | "shell" | "sec_search" | "redirect_interstitial";

/** 標註修正：has_body = 單篇可抽正文；列表／殼／SEC 搜尋頁 ≠ 正文 */
const LABEL_CORRECTIONS: Record<
  string,
  {
    pageKind: PageKind;
    origin: "live_fetch" | "fetch_failed_placeholder" | "synthetic";
    oldExpected: "has_body" | "shell";
    correctedExpected: "has_body" | "shell";
    reason: string;
  }
> = {
  reuters_tech_sample: {
    pageKind: "shell",
    origin: "fetch_failed_placeholder",
    oldExpected: "shell",
    correctedExpected: "shell",
    reason: "真實 SSRF 嘗試 reuters.com/technology → http_401；寫入 130B 失敗殼，非真實頁面 HTML",
  },
  apnews_world: {
    pageKind: "shell",
    origin: "fetch_failed_placeholder",
    oldExpected: "shell",
    correctedExpected: "shell",
    reason: "真實嘗試 → http_403；失敗殼",
  },
  marketwatch_home: {
    pageKind: "shell",
    origin: "fetch_failed_placeholder",
    oldExpected: "shell",
    correctedExpected: "shell",
    reason: "真實嘗試 → http_401；失敗殼",
  },
  guardian_world: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "真實抓取 /world 列表頁，非單篇文章；舊標 has_body 錯誤（hold-out 僅改標註）",
  },
  cnn_world: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "真實抓取世界新聞列表／入口，非單篇",
  },
  cnbc_markets: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "真實抓取 markets 入口，非單篇",
  },
  cna_taiwan: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "中央社首頁為列表／導覽聚合，非單篇正文",
  },
  udn_money: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "經濟日報金錢頻道首頁／列表",
  },
  ltn_news: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "自由時報新聞首頁／列表",
  },
  microsoft_newsroom: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "Newsroom hub（redirect→/source/），非單篇",
  },
  apple_newsroom: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "Apple Newsroom 列表 hub",
  },
  nvidia_newsroom_hub: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "NVIDIA newsroom hub／列表",
  },
  whitehouse_briefing: {
    pageKind: "list_hub",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "briefing-room → /news/ 列表（redirectHops=1），非單篇",
  },
  sec_edgar_search: {
    pageKind: "sec_search",
    origin: "live_fetch",
    oldExpected: "has_body",
    correctedExpected: "shell",
    reason: "EDGAR 搜尋 UI，非單份 filing 正文",
  },
  synthetic_css_shell: {
    pageKind: "shell",
    origin: "synthetic",
    oldExpected: "shell",
    correctedExpected: "shell",
    reason: "合成 CSS／Skip-to 殼",
  },
  synthetic_grounding_redirect: {
    pageKind: "redirect_interstitial",
    origin: "synthetic",
    oldExpected: "shell",
    correctedExpected: "shell",
    reason: "合成 grounding redirect 中間頁",
  },
  synthetic_good_article_en: {
    pageKind: "single_article",
    origin: "synthetic",
    oldExpected: "has_body",
    correctedExpected: "has_body",
    reason: "合成單篇英文 article",
  },
  synthetic_good_article_zh: {
    pageKind: "single_article",
    origin: "synthetic",
    oldExpected: "has_body",
    correctedExpected: "has_body",
    reason: "合成單篇中文 article",
  },
};

function naiveBefore(html: string): { isMainBody: boolean; excerpt: string } {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  return { isMainBody: text.length >= 120, excerpt: text };
}

function score(rows: { expected: "has_body" | "shell"; pred: boolean }[]) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const r of rows) {
    const exp = r.expected === "has_body";
    if (r.pred && exp) tp++;
    else if (r.pred && !exp) fp++;
    else if (!r.pred && !exp) tn++;
    else fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1; // 正文辨識率
  const shellN = tn + fp;
  const shellFalseBodyRate = shellN ? fp / shellN : 0; // 殼頁誤標率
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    n: rows.length,
    tp,
    fp,
    tn,
    fn,
    precision: +precision.toFixed(4),
    bodyRecognitionRecall: +recall.toFixed(4),
    shellFalseBodyRate: +shellFalseBodyRate.toFixed(4),
    f1: +f1.toFixed(4),
  };
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function analyzeAnswers(answers: {
  qi: number;
  slot: string;
  contentPreview: string;
  completionStatus: string;
  gate: string;
  groundingCount: number;
}[]) {
  const hedgeRe =
    /只有標題|無法確認|細節請|部分完成|不代表完整|查不到|不足以|未核|title_only|無法支|不確定|尚待確認|請點來源|無法從提供/gi;
  const dateRe = /\b20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/g;
  const numRe = /\d+(?:\.\d+)?%|\d+(?:,\d{3})+(?:\.\d+)?|\d+\s*億|\d+\s*萬|\$\s*\d+/g;
  const nameRe =
    /川普|特朗普|習近平|普丁|黃仁勳|柯蕾絲|Colette\s*Kress|台積電|NVIDIA|輝達|Fed|聯準會|Burnham|伯恩罕|梅洛尼|Trump|Jensen/gi;

  return answers.map((a) => {
    const t = a.contentPreview || "";
    const hedges = t.match(hedgeRe) || [];
    const dates = t.match(dateRe) || [];
    const nums = t.match(numRe) || [];
    const names = t.match(nameRe) || [];
    return {
      qi: a.qi,
      slot: a.slot,
      completionStatus: a.completionStatus,
      gate: a.gate,
      groundingCount: a.groundingCount,
      hedgeHits: hedges.length,
      hedgeSamples: [...new Set(hedges.map((x) => x.toLowerCase()))].slice(0, 6),
      entityDates: dates.length,
      entityNums: nums.length,
      entityNames: names.length,
      entityTotal: dates.length + nums.length + names.length,
      previewChars: t.length,
    };
  });
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(HTML_DIR, "manifest.json"), "utf8")) as {
    holdOutIds: string[];
    items: {
      id: string;
      file: string;
      htmlSha256: string;
      expectedLabel: "has_body" | "shell";
      fetchStatus: string;
      redirectHops: number;
      resolvedUrl: string;
      url: string;
      publishedAt: string | null;
    }[];
  };
  const hold = new Set(manifest.holdOutIds);

  const extras = [
    { id: "synthetic_good_article_en", file: "synthetic_good_article_en.html" },
    { id: "synthetic_good_article_zh", file: "synthetic_good_article_zh.html" },
  ];

  const rows: Record<string, unknown>[] = [];
  const beforeOld: { expected: "has_body" | "shell"; pred: boolean }[] = [];
  const afterOld: typeof beforeOld = [];
  const beforeCorr: typeof beforeOld = [];
  const afterCorr: typeof beforeOld = [];
  const beforeCorrHold: typeof beforeOld = [];
  const afterCorrHold: typeof beforeOld = [];
  const beforeCorrDev: typeof beforeOld = [];
  const afterCorrDev: typeof beforeOld = [];

  const injectionDiffs: Record<string, unknown>[] = [];

  const allIds = [
    ...manifest.items.map((i) => ({ id: i.id, file: i.file, meta: i })),
    ...extras.map((e) => ({
      id: e.id,
      file: e.file,
      meta: null as (typeof manifest.items)[0] | null,
    })),
  ];

  let fixturePublishedAt = 0;
  let fixtureN = 0;

  for (const { id, file, meta } of allIds) {
    const corr = LABEL_CORRECTIONS[id];
    if (!corr) continue;
    const fp = path.join(HTML_DIR, file);
    if (!existsSync(fp)) continue;
    const html = readFileSync(fp, "utf8");
    fixtureN++;
    const before = naiveBefore(html);
    const after = extractArticleFromHtml(html, {
      url: meta?.resolvedUrl || meta?.url || `https://fixture.local/${id}`,
    });
    const afterBody =
      after.isMainBody &&
      isUsablePageExcerpt(after.excerpt) &&
      !looksLikeCssOrTemplatePollution(after.excerpt);
    if (after.publishedAt) fixturePublishedAt++;

    const oldExp = corr.oldExpected;
    const newExp = corr.correctedExpected;
    const isHold = hold.has(id);

    const row = {
      id,
      holdOut: isHold,
      origin: corr.origin,
      pageKind: corr.pageKind,
      fetchStatus: meta?.fetchStatus ?? "synthetic",
      redirectHops: meta?.redirectHops ?? 0,
      resolvedUrl: meta?.resolvedUrl ?? null,
      originalUrl: meta?.url ?? null,
      oldExpected: oldExp,
      correctedExpected: newExp,
      labelFixReason: corr.reason,
      beforeIsMainBody: before.isMainBody,
      afterIsMainBody: afterBody,
      afterDegradeReason: after.degradeReason ?? null,
      afterPublishedAt: after.publishedAt ?? null,
      htmlSha256: sha256(html),
      hashMatchesManifest: meta ? meta.htmlSha256 === sha256(html) : true,
    };
    rows.push(row);

    beforeOld.push({ expected: oldExp, pred: before.isMainBody });
    afterOld.push({ expected: oldExp, pred: afterBody });
    beforeCorr.push({ expected: newExp, pred: before.isMainBody });
    afterCorr.push({ expected: newExp, pred: afterBody });
    if (isHold) {
      beforeCorrHold.push({ expected: newExp, pred: before.isMainBody });
      afterCorrHold.push({ expected: newExp, pred: afterBody });
    } else {
      beforeCorrDev.push({ expected: newExp, pred: before.isMainBody });
      afterCorrDev.push({ expected: newExp, pred: afterBody });
    }

    // injection 對照候選
    if (
      id === "synthetic_good_article_zh" ||
      id === "synthetic_css_shell" ||
      id === "cna_taiwan"
    ) {
      injectionDiffs.push({
        id,
        pageKind: corr.pageKind,
        beforeExcerpt: before.excerpt.slice(0, 280),
        afterExcerpt: afterBody ? after.excerpt.slice(0, 280) : `(降級：${after.degradeReason ?? "empty"})`,
        beforeWouldInjectAsBody: before.isMainBody,
        afterWouldInjectAsBody: afterBody,
      });
    }
  }

  // topic 規則：CEO resign 不得標 diplomacy
  const plan = planResearch({ text: "NVIDIA CEO resigns news", now: new Date("2026-11-16T04:00:00+08:00") });
  const hit: RawSearchHit = {
    brief: "SYNTHETIC",
    provider: "offline",
    queries: ["nvidia ceo"],
    sources: [
      {
        title: "NVIDIA CEO Jensen Huang resigns amid board review",
        uri: "https://www.reuters.com/synthetic/nvidia-ceo-resign",
        publishedAt: "2026-11-12T08:00:00Z",
      },
    ],
    pages: [
      {
        title: "NVIDIA CEO Jensen Huang resigns amid board review",
        uri: "https://www.reuters.com/synthetic/nvidia-ceo-resign",
        excerpt:
          "NVIDIA CEO Jensen Huang resigns effective immediately. The board named an interim chief executive while the corporate succession process continues. Earnings guidance unchanged.",
        publishedAt: "2026-11-12T08:00:00Z",
        fetchStatus: "ok",
      },
    ],
  };
  const corpus = collectEventsFromHit(plan, hit);
  const ceoTopic = corpus.events[0]?.topic ?? null;

  // canonical 去重示範
  const dupHit: RawSearchHit = {
    brief: "dup",
    provider: "offline",
    queries: ["dup"],
    sources: [
      { title: "A", uri: "https://www.reuters.com/world/story?utm_source=x" },
      { title: "A copy", uri: "https://www.reuters.com/world/story" },
      { title: "B", uri: "https://www.reuters.com/world/other" },
    ],
    pages: [],
  };
  const dupCorpus = collectEventsFromHit(plan, dupHit);

  // Live 離線
  const live = JSON.parse(
    readFileSync(path.join(OUT_DIR, "quality-live-report.json"), "utf8"),
  ) as {
    research: {
      qi: number;
      text: string;
      gate: string;
      warnings: string[];
      sourceCount: number;
    }[];
    answers: {
      qi: number;
      slot: string;
      contentPreview: string;
      completionStatus: string;
      gate: string;
      groundingCount: number;
    }[];
  };

  const supportsLines = readFileSync(path.join(OUT_DIR, "flash-grounding-supports.jsonl"), "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { supportCount: number; queryPreview: string; at: string });

  const liveSupports = supportsLines.filter((s) =>
    /川普|股市|NVIDIA 過去|台灣最近|台積電|英國政局/.test(s.queryPreview),
  );

  const answerStats = analyzeAnswers(live.answers);
  const byQi = live.research.map((r) => {
    const ans = answerStats.filter((a) => a.qi === r.qi);
    const truncated = r.warnings.find((w) => w.startsWith("truncated_events:"));
    const bodyMissing = r.warnings.includes("some_events_body_missing_date");
    const titleOnlyWarn = r.warnings.some((w) => /title_or_snippet|evidence_title/i.test(w));
    return {
      qi: r.qi,
      text: r.text,
      gate: r.gate,
      sourceCount: r.sourceCount,
      warningsKey: r.warnings.filter((w) =>
        /body_missing|truncated_events|title_or_snippet|unconfirmed|fewer_than|ok_does_not/.test(w),
      ),
      truncatedEventsHint: truncated ?? null,
      bodyMissingDateWarning: bodyMissing,
      titleOnlyWarningInGate: titleOnlyWarn,
      snapshotLacksProvenanceBreakdown: true,
      articleBodyCount: null as number | null,
      publishedAtCount: null as number | null,
      note: "quality-live-report 未存 corpus.sources[].provenance／publishedAt；無法直接計 article_body／日期數",
      answers: ans,
      hedgeTotal: ans.reduce((s, a) => s + a.hedgeHits, 0),
      entityTotal: ans.reduce((s, a) => s + a.entityTotal, 0),
    };
  });

  // redirect 比例（fixture 鏈）
  const fetchOk = manifest.items.filter((i) => i.fetchStatus === "ok" || i.fetchStatus === "synthetic");
  const withRedirect = manifest.items.filter((i) => (i.redirectHops ?? 0) > 0);
  const publisherResolved = withRedirect.filter((i) => {
    try {
      const o = new URL(i.url).hostname;
      const r = new URL(i.resolvedUrl).hostname;
      return o !== r || i.url.split("?")[0] !== i.resolvedUrl.split("?")[0];
    } catch {
      return false;
    }
  });

  const out = {
    measuredAt: new Date().toISOString(),
    fixtureInventory: {
      totalInMetrics: rows.length,
      liveFetchOk: rows.filter((r) => r.origin === "live_fetch").length,
      fetchFailedPlaceholder: rows.filter((r) => r.origin === "fetch_failed_placeholder").length,
      synthetic: rows.filter((r) => r.origin === "synthetic").length,
      reutersClarification:
        "reuters_tech_sample：曾對真實 URL 發 SSRF，但 http_401，磁碟上是失敗占位殼（130B），不是 Reuters 真實 HTML",
    },
    whyBeforeDevF1Was1: {
      explanation:
        "舊標註把多數列表／入口標成 has_body，而 before（裸 strip）只要字元≥120 就算正文。dev 的「殼」幾乎都是 fetch 失敗短殼（before=false 正確），真正難的 CSS 殼 synthetic_css_shell 在 hold-out。因此 before 在「錯誤標註標準」下對 dev 看似完美。",
      conclusion: "before F1=1.0 不代表抽取正確，而是標註≈『有沒有足夠文字』",
    },
    metricsOldLabels: {
      before: { all: score(beforeOld) },
      after: { all: score(afterOld) },
    },
    metricsCorrectedLabels: {
      before: {
        all: score(beforeCorr),
        holdOut: score(beforeCorrHold),
        dev: score(beforeCorrDev),
      },
      after: {
        all: score(afterCorr),
        holdOut: score(afterCorrHold),
        dev: score(afterCorrDev),
      },
      note: "並列 bodyRecognitionRecall（正文辨識率）與 shellFalseBodyRate（殼頁誤標率）",
    },
    perFixture: rows,
    injectionDiffs,
    publishedAt: {
      fixtureExtractRate: fixtureN ? +(fixturePublishedAt / fixtureN).toFixed(4) : 0,
      fixtureWithDate: fixturePublishedAt,
      fixtureTotal: fixtureN,
      liveSnapshot: "未存 per-source publishedAt；對照 phase4 round1 報告先前 Live 常為 0/N 級別。本輪僅能從 warnings 見 some_events_body_missing_date。",
    },
    redirect: {
      itemsWithRedirectHops: withRedirect.map((i) => ({
        id: i.id,
        hops: i.redirectHops,
        from: i.url,
        to: i.resolvedUrl,
      })),
      publisherHostChangedCount: publisherResolved.length,
      amongRedirected: withRedirect.length,
      rateAmongAllFetched: manifest.items.length
        ? +(withRedirect.length / manifest.items.length).toFixed(4)
        : 0,
      codeStatus: "完成：safeFetchText 記錄 redirectHops＋resolvedUrl；grounding redirect 中間頁仍常無法升格正文",
    },
    canonicalDedup: {
      codeStatus: "完成：collector 以 cleanSourceUrl 正規化＋seenUri；同 canonical 不重複建 source",
      offlineDemo: {
        rawSources: 3,
        dedupedSources: dupCorpus.stats.dedupedSourceCount,
        rawSourceCount: dupCorpus.stats.rawSourceCount,
      },
      liveSnapshot: "快照未記 dedup 前後數；無法從 quality-live-report 還原",
    },
    topic: {
      codeStatus: "完成：guessTopic 先匹配 CEO/執行長/resign → corporate，再匹配外交",
      offlineTest: {
        title: "NVIDIA CEO Jensen Huang resigns amid board review",
        topic: ceoTopic,
        expect: "corporate",
        pass: ceoTopic === "corporate",
      },
    },
    liveOffline: {
      flashSupportsAmong6Live: {
        linesMatched: liveSupports.length,
        withSupportsGt0: liveSupports.filter((s) => s.supportCount > 0).length,
        supportCounts: liveSupports.map((s) => s.supportCount),
        note: "jsonl 另含 1 筆探測；Live 6 題皆有 supportCount>0",
      },
      perQuestion: byQi,
      limitation:
        "無法計算 article_body 數／publishedAt 數／實體對應 injection 比例——快照未存 injection 全文與 provenance。下列 hedge／實體僅來自 contentPreview（截斷）。",
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "supplement-A-L-followup.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify({
    corrected: out.metricsCorrectedLabels,
    whyBefore: out.whyBeforeDevF1Was1.conclusion,
    ceoTopic: out.topic.offlineTest,
    supports: out.liveOffline.flashSupportsAmong6Live,
    injectionIds: injectionDiffs.map((x) => x.id),
  }, null, 2));
  console.log("Wrote", outPath);
}

main();
