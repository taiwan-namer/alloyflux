import { readFileSync } from "node:fs";
import {
  extractArticleFromHtml,
  extractMainHtmlFragment,
  looksLikeListOrHubPage,
} from "../lib/research-v2/article-extract";
import { cleanArticleText } from "../lib/web-research";

function htmlToText(fragment: string): string {
  return fragment
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

for (const id of ["cna_taiwan", "synthetic_good_article_zh", "whitehouse_briefing"]) {
  const html = readFileSync(`lib/research-v2/fixtures/html/${id}.html`, "utf8");
  const frag = extractMainHtmlFragment(html);
  const text = cleanArticleText(
    frag
      .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const gate = looksLikeListOrHubPage(html, text);
  const aCount = (frag.match(/<a\b/gi) || []).length;
  const pCount = (frag.match(/<p\b/gi) || []).length;
  const hCount = (frag.match(/<h[1-3]\b/gi) || []).length;
  console.log("---", id);
  console.log({ aCount, pCount, hCount, textLen: text.length, gate });
  console.log("lines sample", text.split("\n").slice(0, 8));
  console.log("extract", extractArticleFromHtml(html, { url: "https://x/" + id }));
}
