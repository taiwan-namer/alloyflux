/**
 * 抽取品質：修正前／後＋hold-out＋反向正文辨識率
 * 用法：npx tsx scripts/measure-extract-quality.mts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticleFromHtml, looksLikeCssOrTemplatePollution } from "../lib/research-v2/article-extract";
import { isUsablePageExcerpt } from "../lib/web-research";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_DIR = path.join(ROOT, "lib/research-v2/fixtures/html");
const OUT_DIR = path.join(ROOT, "docs/live-e2e");

type Manifest = {
  holdOutIds: string[];
  items: {
    id: string;
    file: string;
    htmlSha256: string;
    expectedLabel: "has_body" | "shell";
    type: string;
  }[];
};

/** 修正前：裸 strip，幾乎不擋 CSS／導覽殼 */
function naiveExtractBefore(html: string): { isMainBody: boolean; excerpt: string; publishedAt?: string } {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  return { isMainBody: text.length >= 120, excerpt: text };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function scoreSet(
  rows: { id: string; expected: "has_body" | "shell"; pred: boolean }[],
) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const r of rows) {
    const predBody = r.pred;
    const expBody = r.expected === "has_body";
    if (predBody && expBody) tp++;
    else if (predBody && !expBody) fp++;
    else if (!predBody && !expBody) tn++;
    else fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  /** 反向：殼／污染被誤標正文的比例（越低越好） */
  const shellTotal = tn + fp;
  const reverseFalseBodyRate = shellTotal ? fp / shellTotal : 0;
  return {
    n: rows.length,
    tp,
    fp,
    tn,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    reverseFalseBodyRate: Number(reverseFalseBodyRate.toFixed(4)),
  };
}

function main() {
  const manifestPath = path.join(HTML_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("缺少 manifest.json，請先跑 collect-html-fixtures.mts");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  // 附加合成正文 fixture（不改 hold-out）
  const extra: Manifest["items"] = [
    {
      id: "synthetic_good_article_en",
      file: "synthetic_good_article_en.html",
      htmlSha256: "",
      expectedLabel: "has_body",
      type: "synthetic_article",
    },
    {
      id: "synthetic_good_article_zh",
      file: "synthetic_good_article_zh.html",
      htmlSha256: "",
      expectedLabel: "has_body",
      type: "synthetic_article",
    },
  ];

  const allItems = [...manifest.items, ...extra];
  const hold = new Set(manifest.holdOutIds);

  const detail: Record<string, unknown>[] = [];
  const beforeAll: { id: string; expected: "has_body" | "shell"; pred: boolean }[] = [];
  const afterAll: { id: string; expected: "has_body" | "shell"; pred: boolean }[] = [];
  const beforeHold: typeof beforeAll = [];
  const afterHold: typeof afterAll = [];
  const beforeDev: typeof beforeAll = [];
  const afterDev: typeof afterAll = [];

  for (const item of allItems) {
    const fp = path.join(HTML_DIR, item.file);
    if (!existsSync(fp)) {
      console.warn("missing", item.file);
      continue;
    }
    const html = readFileSync(fp, "utf8");
    const hash = sha256(html);
    if (item.htmlSha256 && item.htmlSha256 !== hash && hold.has(item.id)) {
      console.warn(`hold-out hash drift: ${item.id}`);
    }

    const before = naiveExtractBefore(html);
    const after = extractArticleFromHtml(html, { url: `https://fixture.local/${item.id}` });
    const afterBody =
      after.isMainBody && isUsablePageExcerpt(after.excerpt) && !looksLikeCssOrTemplatePollution(after.excerpt);

    const row = {
      id: item.id,
      type: item.type,
      expected: item.expectedLabel,
      holdOut: hold.has(item.id),
      beforeIsMainBody: before.isMainBody,
      afterIsMainBody: afterBody,
      afterDegradeReason: after.degradeReason ?? null,
      afterHasDate: Boolean(after.publishedAt),
      beforePollution: looksLikeCssOrTemplatePollution(before.excerpt),
      htmlSha256: hash,
    };
    detail.push(row);

    const b = { id: item.id, expected: item.expectedLabel, pred: before.isMainBody };
    const a = { id: item.id, expected: item.expectedLabel, pred: afterBody };
    beforeAll.push(b);
    afterAll.push(a);
    if (hold.has(item.id)) {
      beforeHold.push(b);
      afterHold.push(a);
    } else {
      beforeDev.push(b);
      afterDev.push(a);
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    note: "before=裸 HTML strip；after=extractArticleFromHtml 品質閘門。hold-out 鎖定後未針對其調規則。",
    totals: {
      fixtures: detail.length,
      holdOut: beforeHold.length,
      dev: beforeDev.length,
    },
    before: {
      all: scoreSet(beforeAll),
      holdOut: scoreSet(beforeHold),
      dev: scoreSet(beforeDev),
    },
    after: {
      all: scoreSet(afterAll),
      holdOut: scoreSet(afterHold),
      dev: scoreSet(afterDev),
    },
    detail,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "extract-quality-metrics.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ before: report.before, after: report.after, totals: report.totals }, null, 2));
  console.log(`Wrote ${out}`);
}

main();
