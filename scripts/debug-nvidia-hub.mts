import { readFileSync } from "node:fs";
import { extractMainHtmlFragment, looksLikeListOrHubPage } from "../lib/research-v2/article-extract";
import { cleanArticleText } from "../lib/web-research";

for (const id of ["nvidia_newsroom_hub", "sec_edgar_search"]) {
  const html = readFileSync(`lib/research-v2/fixtures/html/${id}.html`, "utf8");
  const frag = extractMainHtmlFragment(html);
  const text = cleanArticleText(
    frag
      .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const gate = looksLikeListOrHubPage(html, text);
  console.log(id, {
    a: (frag.match(/<a\b/gi) || []).length,
    h: (frag.match(/<h[1-3]\b/gi) || []).length,
    p: (frag.match(/<p\b/gi) || []).length,
    gate,
  });
}
