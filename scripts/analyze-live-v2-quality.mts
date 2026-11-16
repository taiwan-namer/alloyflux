/**
 * 離線：用持久化 injectionText + 全文回答做品質分析（不打 Flash）
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "docs/live-e2e");

const ENTITY_RE =
  /川普|特朗普|習近平|普丁|黃仁勳|Jensen|Kress|台積電|NVIDIA|輝達|Fed|聯準會|Burnham|Trump|OpenAI|Anthropic|\d{4}[-/年]\d{1,2}|\d+\s*%|\d+\s*億|\$\s*\d+/gi;
const HEDGE_RE = /只有標題|無法確認|細節請|部分完成|不代表完整|不足以|查不到|請點來源|title_only|搜尋摘要/gi;

function main() {
  const researchFiles = readdirSync(LIVE).filter((f) => /^research-q\d+\.json$/.test(f));
  const perQ = [];

  for (const rf of researchFiles.sort()) {
    const research = JSON.parse(readFileSync(path.join(LIVE, rf), "utf8")) as {
      qi: number;
      text: string;
      gate: string;
      injectionText: string;
      articleBodyCount: number;
      publishedAtCount: number;
      searchSynthesisClaimCount: number;
      sourceCount: number;
      titleOnlyCount: number;
      dedup: Record<string, number>;
    };
    const inj = research.injectionText || "";
    const injEntities = new Set((inj.match(ENTITY_RE) || []).map((x) => x.toLowerCase()));

    const answers = [];
    for (const slot of ["astra", "claude", "argon"]) {
      const af = path.join(LIVE, `answer-q${research.qi}-${slot}.json`);
      try {
        const a = JSON.parse(readFileSync(af, "utf8")) as {
          content: string;
          hedgeHits: number;
          completionStatus: string;
        };
        const ents = a.content.match(ENTITY_RE) || [];
        const unique = [...new Set(ents.map((x) => x.toLowerCase()))];
        const matched = unique.filter((e) =>
          [...injEntities].some((ie) => ie.includes(e) || e.includes(ie)),
        );
        const hedges = a.content.match(HEDGE_RE) || [];
        answers.push({
          slot,
          completionStatus: a.completionStatus,
          entityCount: unique.length,
          entityMatchedToInjection: matched.length,
          entityMatchRate: unique.length ? +(matched.length / unique.length).toFixed(4) : null,
          hedgeHits: hedges.length,
        });
      } catch {
        answers.push({ slot, error: "missing" });
      }
    }

    // before/after injection：去掉 search_synthesis 段落作 before 對照
    const injBefore = inj
      .split(/\n/)
      .filter((l) => !/search_synthesis|搜尋摘要，未經原文核對/.test(l))
      .join("\n");
    perQ.push({
      qi: research.qi,
      text: research.text,
      gate: research.gate,
      articleBodyCount: research.articleBodyCount,
      publishedAtCount: research.publishedAtCount,
      sourceCount: research.sourceCount,
      titleOnlyCount: research.titleOnlyCount,
      searchSynthesisClaimCount: research.searchSynthesisClaimCount,
      dedup: research.dedup,
      injectionCharsAfter: inj.length,
      injectionCharsBeforeSynthStripped: injBefore.length,
      injectionEntityCount: injEntities.size,
      answers,
    });
  }

  const out = {
    measuredAt: new Date().toISOString(),
    note: "品質結論僅在有 injectionText 持久化時有效",
    perQuestion: perQ,
    totals: {
      questions: perQ.length,
      meanArticleBody: +(
        perQ.reduce((s, q) => s + q.articleBodyCount, 0) / Math.max(perQ.length, 1)
      ).toFixed(2),
      meanPublishedAt: +(
        perQ.reduce((s, q) => s + q.publishedAtCount, 0) / Math.max(perQ.length, 1)
      ).toFixed(2),
      meanSynthClaims: +(
        perQ.reduce((s, q) => s + q.searchSynthesisClaimCount, 0) / Math.max(perQ.length, 1)
      ).toFixed(2),
    },
  };
  writeFileSync(path.join(LIVE, "live-v2-quality-analysis.json"), JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(out.totals, null, 2));
  for (const q of perQ) {
    console.log(
      `Q${q.qi} body=${q.articleBodyCount}/${q.sourceCount} date=${q.publishedAtCount} synth=${q.searchSynthesisClaimCount}`,
      q.answers.map((a) => `${(a as { slot: string }).slot}:ent=${(a as { entityCount?: number }).entityCount}/match=${(a as { entityMatchedToInjection?: number }).entityMatchedToInjection}/hedge=${(a as { hedgeHits?: number }).hedgeHits}`).join(" "),
    );
  }
}

main();
