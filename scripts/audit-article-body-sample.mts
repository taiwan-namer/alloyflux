/**
 * 從 Live article_body 來源隨機抽 15 筆（固定 seed），對照 html-snapshots 人工判定欄位。
 * 不打 Flash。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractArticleFromHtml,
  looksLikeListOrHubPage,
} from "../lib/research-v2/article-extract";
import { cleanArticleText } from "../lib/web-research";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "docs/live-e2e");
const SNAP = path.join(LIVE, "html-snapshots");
const SEED = 20261116;

type SourceRow = {
  qi: number;
  sourceId: string;
  title: string;
  resolvedUrl?: string | null;
  url: string;
  provenance: string;
  htmlPath?: string | null;
  htmlSha256?: string | null;
};

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function classifyAudit(opts: {
  listGate: { isList: boolean; reason?: string; linkTextRatio: number; longParagraphCount: number };
  extractIsMainBody: boolean;
  degradeReason: string | null;
  excerptLen: number;
  htmlBytes: number;
  preview: string;
}): "single_article" | "list" | "shell" | "partial_body" {
  // 獨立 list-gate（不直接抄 Live 標籤）
  if (opts.listGate.isList) return "list";
  if (
    opts.htmlBytes < 1500 ||
    /@font-face|skip to main content/i.test(opts.preview) ||
    opts.degradeReason === "template_or_css_pollution"
  ) {
    return "shell";
  }
  if (opts.excerptLen >= 400 && opts.listGate.longParagraphCount >= 2 && !opts.listGate.isList) {
    return "single_article";
  }
  if (opts.excerptLen >= 120) return "partial_body";
  return "shell";
}

function main() {
  const pool: SourceRow[] = [];
  for (let qi = 0; qi < 6; qi++) {
    const p = path.join(LIVE, `research-q${qi}.json`);
    if (!existsSync(p)) continue;
    const r = JSON.parse(readFileSync(p, "utf8")) as {
      qi: number;
      corpusSources: SourceRow[];
    };
    for (const s of r.corpusSources || []) {
      if (s.provenance === "article_body" || s.provenance === "official_document") {
        pool.push({ ...s, qi: r.qi });
      }
    }
  }

  const rnd = mulberry32(SEED);
  const sampled = shuffle(pool, rnd).slice(0, 15);

  const rows = [];
  let mislabel = 0;
  for (const s of sampled) {
    const rel = s.htmlPath;
    const abs = rel ? path.join(SNAP, rel) : null;
    let html = "";
    let htmlBytes = 0;
    let extractIsMainBody = false;
    let degradeReason: string | null = null;
    let excerptLen = 0;
    let publishedAt: string | null = null;
    let missingSnapshot = false;
    let listGate = {
      isList: false,
      reason: undefined as string | undefined,
      linkTextRatio: 0,
      longParagraphCount: 0,
    };
    let preview = "";

    if (!abs || !existsSync(abs)) {
      missingSnapshot = true;
    } else {
      html = readFileSync(abs, "utf8");
      htmlBytes = Buffer.byteLength(html);
      const url = s.resolvedUrl || s.url;
      const rawText = cleanArticleText(html);
      listGate = looksLikeListOrHubPage(html, rawText, { url });
      const ex = extractArticleFromHtml(html, { url });
      extractIsMainBody = ex.isMainBody;
      degradeReason = ex.degradeReason ?? null;
      excerptLen = ex.excerpt?.length ?? 0;
      publishedAt = ex.publishedAt ?? null;
      preview = (ex.excerpt || rawText).slice(0, 220);
    }

    const auditLabel = missingSnapshot
      ? ("missing_snapshot" as const)
      : classifyAudit({
          listGate,
          extractIsMainBody,
          degradeReason,
          excerptLen,
          htmlBytes,
          preview,
        });

    // Live 標成 article_body：若稽核為 list/shell/missing → 誤標
    const liveSaidBody = true;
    const isMislabel =
      auditLabel === "list" || auditLabel === "shell" || auditLabel === "missing_snapshot";
    if (isMislabel) mislabel += 1;

    rows.push({
      qi: s.qi,
      sourceId: s.sourceId,
      title: s.title,
      resolvedUrl: s.resolvedUrl || s.url,
      htmlPath: s.htmlPath ?? null,
      htmlSha256:
        s.htmlSha256 ||
        (html ? createHash("sha256").update(html).digest("hex") : null),
      liveProvenance: s.provenance,
      extractIsMainBody,
      degradeReason,
      excerptLen,
      publishedAt,
      listGateIsList: listGate.isList,
      listGateReason: listGate.reason ?? null,
      linkTextRatio: +listGate.linkTextRatio.toFixed(3),
      longParagraphCount: listGate.longParagraphCount,
      preview,
      auditLabel,
      liveSaidBody,
      mislabel: isMislabel,
      missingSnapshot,
    });
  }

  const fixtureManifest = JSON.parse(
    readFileSync(path.join(ROOT, "lib/research-v2/fixtures/html-v2/manifest.json"), "utf8"),
  ) as { items: { htmlSha256?: string; id: string }[] };
  const fixtureHashes = new Set(
    fixtureManifest.items.map((i) => i.htmlSha256).filter(Boolean) as string[],
  );

  const allBodySources = pool;
  let inSample = 0;
  for (const s of allBodySources) {
    const abs = s.htmlPath ? path.join(SNAP, s.htmlPath) : null;
    if (!abs || !existsSync(abs)) continue;
    const hash =
      s.htmlSha256 || createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (fixtureHashes.has(hash)) inSample += 1;
  }

  const report = {
    measuredAt: new Date().toISOString(),
    seed: SEED,
    poolSize: pool.length,
    sampleSize: rows.length,
    mislabelCount: mislabel,
    mislabelRate: rows.length ? +(mislabel / rows.length).toFixed(4) : null,
    note: "auditLabel 由抽取器訊號＋長度啟發式判定；list/shell/missing 計入誤標",
    inSample: {
      liveArticleBodySources: allBodySources.length,
      alsoInHtmlV2Fixture: inSample,
      inSampleRate: allBodySources.length
        ? +(inSample / allBodySources.length).toFixed(4)
        : null,
    },
    rows,
  };

  const out = path.join(LIVE, "article-body-audit-15.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        sampleSize: report.sampleSize,
        mislabelRate: report.mislabelRate,
        inSample: report.inSample,
        byLabel: rows.reduce(
          (acc, r) => {
            acc[r.auditLabel] = (acc[r.auditLabel] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      },
      null,
      2,
    ),
  );
}

main();
