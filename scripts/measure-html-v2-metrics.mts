/**
 * html-v2 fixture 指標：正文辨識率、殼頁誤標率、publishedAt 抽取率
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticleFromHtml } from "../lib/research-v2/article-extract";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "lib/research-v2/fixtures/html-v2");

function main() {
  const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
    holdOutIds: string[];
    items: {
      id: string;
      file: string;
      expectedLabel: "has_body" | "shell";
      pageKind: string;
      resolvedUrl?: string;
      requestUrl?: string;
    }[];
  };
  const hold = new Set(manifest.holdOutIds);
  const rows = [];
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let dateOnBody = 0;
  let bodyN = 0;

  for (const item of manifest.items) {
    const fpPath = path.join(DIR, item.file);
    if (!existsSync(fpPath)) continue;
    const html = readFileSync(fpPath, "utf8");
    const url = item.resolvedUrl || item.requestUrl || `https://fixture.local/${item.id}`;
    const r = extractArticleFromHtml(html, { url });
    const exp = item.expectedLabel === "has_body";
    const pred = r.isMainBody;
    if (pred && exp) tp++;
    else if (pred && !exp) fp++;
    else if (!pred && !exp) tn++;
    else fn++;
    if (exp) {
      bodyN++;
      if (r.publishedAt) dateOnBody++;
    }
    rows.push({
      id: item.id,
      holdOut: hold.has(item.id),
      pageKind: item.pageKind,
      expected: item.expectedLabel,
      predBody: pred,
      degrade: r.degradeReason ?? null,
      publishedAt: r.publishedAt ?? null,
    });
  }

  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const shellN = tn + fp;
  const shellFalseBodyRate = shellN ? fp / shellN : 0;
  const report = {
    measuredAt: new Date().toISOString(),
    totals: { n: rows.length, holdOut: hold.size },
    bodyRecognitionRecall: +recall.toFixed(4),
    shellFalseBodyRate: +shellFalseBodyRate.toFixed(4),
    precision: +precision.toFixed(4),
    publishedAtRateOnExpectedBody: bodyN ? +(dateOnBody / bodyN).toFixed(4) : null,
    confusion: { tp, fp, tn, fn },
    holdOutRows: rows.filter((r) => r.holdOut),
    rows,
  };
  const out = path.join(ROOT, "docs/live-e2e/html-v2-metrics.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    bodyRecognitionRecall: report.bodyRecognitionRecall,
    shellFalseBodyRate: report.shellFalseBodyRate,
    publishedAtRateOnExpectedBody: report.publishedAtRateOnExpectedBody,
    confusion: report.confusion,
  }, null, 2));
}

main();
