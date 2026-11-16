import { readFileSync, existsSync } from "node:fs";
import { extractArticleFromHtml } from "../lib/research-v2/article-extract";

const rows: { id: string; url: string; expectShell: boolean }[] = [
  { id: "cna_taiwan", url: "https://www.cna.com.tw/", expectShell: true },
  { id: "whitehouse_briefing", url: "https://www.whitehouse.gov/briefing-room/", expectShell: true },
  { id: "synthetic_css_shell", url: "https://example.com/synthetic-css-shell", expectShell: true },
  { id: "synthetic_good_article_zh", url: "https://example.com/articles/tw-market", expectShell: false },
  { id: "synthetic_good_article_en", url: "https://example.com/articles/summit", expectShell: false },
  { id: "ltn_news", url: "https://news.ltn.com.tw/", expectShell: true },
  { id: "nvidia_newsroom_hub", url: "https://nvidianews.nvidia.com/", expectShell: true },
  { id: "guardian_world", url: "https://www.theguardian.com/world", expectShell: true },
  { id: "sec_edgar_search", url: "https://www.sec.gov/edgar/search/", expectShell: true },
  { id: "cnn_world", url: "https://edition.cnn.com/world", expectShell: true },
];

let fail = 0;
for (const row of rows) {
  const p = `lib/research-v2/fixtures/html/${row.id}.html`;
  if (!existsSync(p)) {
    console.log(row.id, "MISSING");
    fail++;
    continue;
  }
  const html = readFileSync(p, "utf8");
  const r = extractArticleFromHtml(html, { url: row.url });
  const ok = row.expectShell ? !r.isMainBody : r.isMainBody;
  if (!ok) fail++;
  console.log(
    `${ok ? "OK" : "FAIL"}\t${row.id}\tbody=${r.isMainBody}\texpectShell=${row.expectShell}\t${r.degradeReason ?? "ok"}`,
  );
}
console.log(fail === 0 ? "ALL_PASS" : `FAILS=${fail}`);
process.exit(fail === 0 ? 0 : 1);
