/**
 * 從 Live 持久化 corpusSources 的 resolvedUrl 重建真實單篇 fixture。
 * 舊 hold-out 作廢；新 hold-out：5 單篇 + 2 列表/殼，先鎖再開發。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticleFromHtml } from "../lib/research-v2/article-extract";
import { safeFetchText } from "../lib/research-v2/ssrf";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "docs/live-e2e");
const OUT = path.join(ROOT, "lib/research-v2/fixtures/html-v2");

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function looksArticleUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (/vertexaisearch\.cloud\.google\.com/i.test(url.hostname)) return true; // resolve via SSRF
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return true;
    if (/\d{4}\/\d{2}/.test(url.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(LIVE).filter((f) => /^research-q\d+\.json$/.test(f));
  if (!files.length) {
    console.error("No research-q*.json — run live with persistence first");
    process.exit(2);
  }

  const urlMap = new Map<string, { title: string; fromQi: number }>();
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(LIVE, f), "utf8")) as {
      qi: number;
      corpusSources: { title: string; resolvedUrl?: string | null; url: string }[];
    };
    for (const s of j.corpusSources || []) {
      const u = s.resolvedUrl || s.url;
      if (!u || !looksArticleUrl(u)) continue;
      if (!urlMap.has(u)) urlMap.set(u, { title: s.title, fromQi: j.qi });
    }
  }

  console.log(`candidate URLs: ${urlMap.size}`);
  const items: Record<string, unknown>[] = [];
  let n = 0;
  for (const [url, meta] of urlMap) {
    if (n >= 24) break;
    const id = `live_article_${String(n + 1).padStart(2, "0")}`;
    let html = "";
    let fetchStatus = "ok";
    let resolvedUrl = url;
    let redirectHops = 0;
    let reason = "";
    try {
      const r = await safeFetchText(url, { maxBytes: 500_000 });
      html = r.body || "";
      fetchStatus = r.fetchStatus;
      resolvedUrl = r.resolvedUrl || url;
      redirectHops = r.redirectHops;
      reason = r.reason || "";
      if (!html) {
        html = `<!doctype html><html><body>Skip to main content. fetch=${fetchStatus}</body></html>`;
        fetchStatus = "failed";
      }
    } catch (e) {
      html = `<!doctype html><html><body>Skip to main content. error</body></html>`;
      fetchStatus = "error";
      reason = e instanceof Error ? e.message : String(e);
    }

    const extracted = extractArticleFromHtml(html, { url: resolvedUrl });
    const hash = sha256(html);
    const file = `${id}.html`;
    writeFileSync(path.join(OUT, file), html, "utf8");
    const pageKind = extracted.isMainBody ? "single_article" : "shell_or_list";
    items.push({
      id,
      file,
      sourceTitle: meta.title,
      fromQi: meta.fromQi,
      requestUrl: url,
      resolvedUrl,
      redirectHops,
      fetchStatus,
      reason,
      htmlSha256: hash,
      bytes: html.length,
      pageKind,
      expectedLabel: extracted.isMainBody ? "has_body" : "shell",
      extractIsMainBody: extracted.isMainBody,
      extractDegradeReason: extracted.degradeReason ?? null,
      publishedAt: extracted.publishedAt ?? null,
      collectedAt: new Date().toISOString(),
    });
    console.log(
      `${id}: body=${extracted.isMainBody} status=${fetchStatus} hops=${redirectHops} ${resolvedUrl.slice(0, 80)}`,
    );
    n++;
  }

  // 合成殼＋既有列表對照
  const shellHtml = readFileSync(
    path.join(ROOT, "lib/research-v2/fixtures/html/synthetic_css_shell.html"),
    "utf8",
  );
  writeFileSync(path.join(OUT, "shell_css.html"), shellHtml, "utf8");
  items.push({
    id: "shell_css",
    file: "shell_css.html",
    pageKind: "shell",
    expectedLabel: "shell",
    htmlSha256: sha256(shellHtml),
    extractIsMainBody: false,
    origin: "synthetic",
  });

  const listCandidates = items.filter((x) => x.pageKind === "shell_or_list");
  const articles = items.filter((x) => x.pageKind === "single_article");
  console.log(`articles=${articles.length} non_body=${listCandidates.length}`);

  // 新 hold-out：5 單篇 + 2 列表/殼（不足則能鎖多少鎖多少並標不足）
  const holdArticles = articles.slice(0, 5);
  const holdShells = [
    items.find((x) => x.id === "shell_css"),
    ...listCandidates.slice(0, 1),
  ].filter(Boolean);
  const holdOut = [...holdArticles, ...holdShells];
  const holdOutIds = holdOut.map((x) => (x as { id: string }).id);

  const manifest = {
    lockedAt: new Date().toISOString(),
    note: "舊 hold-out 作廢。本 hold-out 鎖定後不得針對其調規則。來源＝Live grounding resolvedUrl。",
    holdOutIds,
    holdOutComposition: {
      singleArticles: holdArticles.length,
      listOrShell: holdShells.length,
      target: "5 single + 2 list/shell",
      met: holdArticles.length >= 5 && holdShells.length >= 2,
    },
    holdOut: holdOut.map((x) => ({
      id: (x as { id: string }).id,
      htmlSha256: (x as { htmlSha256: string }).htmlSha256,
      pageKind: (x as { pageKind: string }).pageKind,
      expectedLabel: (x as { expectedLabel: string }).expectedLabel,
    })),
    items,
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Wrote ${items.length} fixtures; hold-out=${holdOutIds.join(",")}`);
  if (!manifest.holdOutComposition.met) {
    console.warn("WARN: hold-out composition below target — need more successful article fetches");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
