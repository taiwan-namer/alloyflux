/**
 * html-v2 指標拆成 dev / hold-out；並列 Live article_body in-sample 比例。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticleFromHtml } from "../lib/research-v2/article-extract";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "lib/research-v2/fixtures/html-v2");
const LIVE = path.join(ROOT, "docs/live-e2e");

type Item = {
  id: string;
  file: string;
  expectedLabel: "has_body" | "shell";
  pageKind: string;
  resolvedUrl?: string;
  requestUrl?: string;
  htmlSha256?: string;
};

function metricsFor(items: Item[], hold: Set<string>, onlyHold: boolean | null) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let dateOnBody = 0;
  let bodyN = 0;
  const rows = [];

  for (const item of items) {
    const isHold = hold.has(item.id);
    if (onlyHold === true && !isHold) continue;
    if (onlyHold === false && isHold) continue;
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
      holdOut: isHold,
      expected: item.expectedLabel,
      predBody: pred,
      degrade: r.degradeReason ?? null,
      publishedAt: r.publishedAt ?? null,
    });
  }

  const recall = tp + fn ? tp / (tp + fn) : 1;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const shellN = tn + fp;
  return {
    n: rows.length,
    bodyRecognitionRecall: +recall.toFixed(4),
    shellFalseBodyRate: shellN ? +(fp / shellN).toFixed(4) : 0,
    precision: +precision.toFixed(4),
    publishedAtRateOnExpectedBody: bodyN ? +(dateOnBody / bodyN).toFixed(4) : null,
    confusion: { tp, fp, tn, fn },
    rows,
  };
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
    holdOutIds: string[];
    items: Item[];
  };
  const hold = new Set(manifest.holdOutIds);
  const all = metricsFor(manifest.items, hold, null);
  const holdOut = metricsFor(manifest.items, hold, true);
  const dev = metricsFor(manifest.items, hold, false);

  const fixtureHashes = new Set(
    manifest.items.map((i) => i.htmlSha256).filter(Boolean) as string[],
  );
  let liveBody = 0;
  let inSample = 0;
  for (let qi = 0; qi < 6; qi++) {
    const p = path.join(LIVE, `research-q${qi}.json`);
    if (!existsSync(p)) continue;
    const r = JSON.parse(readFileSync(p, "utf8")) as {
      corpusSources: {
        provenance: string;
        htmlPath?: string | null;
        htmlSha256?: string | null;
      }[];
    };
    for (const s of r.corpusSources || []) {
      if (s.provenance !== "article_body" && s.provenance !== "official_document") continue;
      liveBody += 1;
      const abs = s.htmlPath ? path.join(LIVE, "html-snapshots", s.htmlPath) : null;
      const hash =
        s.htmlSha256 ||
        (abs && existsSync(abs)
          ? createHash("sha256").update(readFileSync(abs)).digest("hex")
          : null);
      if (hash && fixtureHashes.has(hash)) inSample += 1;
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    split: {
      all,
      dev,
      holdOut,
    },
    liveInSample: {
      liveArticleBodySources: liveBody,
      alsoInHtmlV2Fixture: inSample,
      inSampleRate: liveBody ? +(inSample / liveBody).toFixed(4) : null,
    },
  };

  const out = path.join(LIVE, "html-v2-metrics-split.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  // 同步更新合併檔並附 split 欄
  writeFileSync(
    path.join(LIVE, "html-v2-metrics.json"),
    JSON.stringify(
      {
        measuredAt: report.measuredAt,
        totals: { n: all.n, holdOut: hold.size, dev: all.n - holdOut.n },
        bodyRecognitionRecall: all.bodyRecognitionRecall,
        shellFalseBodyRate: all.shellFalseBodyRate,
        precision: all.precision,
        publishedAtRateOnExpectedBody: all.publishedAtRateOnExpectedBody,
        confusion: all.confusion,
        split: {
          dev: {
            n: dev.n,
            bodyRecognitionRecall: dev.bodyRecognitionRecall,
            shellFalseBodyRate: dev.shellFalseBodyRate,
            publishedAtRateOnExpectedBody: dev.publishedAtRateOnExpectedBody,
            confusion: dev.confusion,
          },
          holdOut: {
            n: holdOut.n,
            bodyRecognitionRecall: holdOut.bodyRecognitionRecall,
            shellFalseBodyRate: holdOut.shellFalseBodyRate,
            publishedAtRateOnExpectedBody: holdOut.publishedAtRateOnExpectedBody,
            confusion: holdOut.confusion,
          },
        },
        liveInSample: report.liveInSample,
        holdOutRows: holdOut.rows,
        rows: all.rows,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        all: {
          recall: all.bodyRecognitionRecall,
          shellFalse: all.shellFalseBodyRate,
        },
        dev: {
          recall: dev.bodyRecognitionRecall,
          shellFalse: dev.shellFalseBodyRate,
          n: dev.n,
        },
        holdOut: {
          recall: holdOut.bodyRecognitionRecall,
          shellFalse: holdOut.shellFalseBodyRate,
          n: holdOut.n,
        },
        liveInSample: report.liveInSample,
      },
      null,
      2,
    ),
  );
}

main();
