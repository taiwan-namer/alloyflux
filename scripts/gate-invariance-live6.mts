/**
 * 離線：從 html-snapshots + supports 重建 6 題 corpus，
 * 驗證移除 search_synthesis 後 Gate status 完全一致。
 * Flash = 0。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticleFromHtml } from "../lib/research-v2/article-extract";
import {
  collectEventsFromHit,
  stripSearchSynthesisFromCorpus,
} from "../lib/research-v2/collector";
import { gateEvidence } from "../lib/research-v2/gate";
import { planResearch } from "../lib/research-v2/planner";
import type { RawSearchHit } from "../lib/research-v2/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "docs/live-e2e");
const SNAP = path.join(LIVE, "html-snapshots");
const SUPPORTS = path.join(LIVE, "flash-grounding-supports.jsonl");

type ResearchSnap = {
  qi: number;
  text: string;
  gate: string;
  searchSynthesisClaimCount: number;
  corpusSources: {
    title: string;
    url: string;
    originalUrl?: string;
    resolvedUrl?: string;
    publishedAt?: string | null;
    fetchStatus?: string;
    htmlPath?: string | null;
    htmlSha256?: string | null;
    provenance: string;
  }[];
};

function loadSupportsByQuery(): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>();
  if (!existsSync(SUPPORTS)) return map;
  for (const line of readFileSync(SUPPORTS, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        queryPreview?: string;
        rawGroundingSupports?: unknown[];
        at?: string;
      };
      const key = (row.queryPreview || "").slice(0, 40);
      if (!key) continue;
      // 後寫覆蓋（取最新一輪）
      map.set(key, row.rawGroundingSupports || []);
    } catch {
      /* skip */
    }
  }
  return map;
}

function findSupports(text: string, byQ: Map<string, unknown[]>): unknown[] {
  for (const [k, v] of byQ) {
    if (k.includes(text.slice(0, 12)) || text.includes(k.slice(0, 12))) return v;
  }
  // 題幹關鍵字
  for (const [k, v] of byQ) {
    const tip = text.replace(/[？?。，,\s]/g, "").slice(0, 8);
    if (tip && k.includes(tip)) return v;
  }
  return [];
}

function main() {
  const supportsMap = loadSupportsByQuery();
  const results = [];

  process.env.RESEARCH_SEARCH_SYNTHESIS = "1";
  try {
    for (let qi = 0; qi < 6; qi++) {
      const p = path.join(LIVE, `research-q${qi}.json`);
      const research = JSON.parse(readFileSync(p, "utf8")) as ResearchSnap;
      const plan = planResearch({
        text: research.text,
        now: new Date("2026-11-16T00:00:00.000Z"),
        timeZone: "Asia/Taipei",
      });

      const pages: RawSearchHit["pages"] = [];
      const sources: RawSearchHit["sources"] = [];
      for (const s of research.corpusSources) {
        const uri = s.resolvedUrl || s.url;
        sources.push({
          title: s.title,
          uri: s.url,
          originalUrl: s.originalUrl || s.url,
          resolvedUrl: s.resolvedUrl || undefined,
          publishedAt: s.publishedAt || undefined,
        });
        if (!s.htmlPath) continue;
        const abs = path.join(SNAP, s.htmlPath);
        if (!existsSync(abs)) continue;
        const html = readFileSync(abs, "utf8");
        const ex = extractArticleFromHtml(html, { url: uri });
        pages.push({
          title: s.title,
          uri: s.url,
          originalUrl: s.originalUrl || s.url,
          resolvedUrl: s.resolvedUrl || uri,
          excerpt: ex.excerpt || "",
          publishedAt: ex.publishedAt || s.publishedAt || undefined,
          fetchStatus: (s.fetchStatus as RawSearchHit["pages"][0]["fetchStatus"]) || "ok",
          htmlPath: s.htmlPath || undefined,
          htmlSha256: s.htmlSha256 || undefined,
        });
      }

      const supports = findSupports(research.text, supportsMap);
      const hit: RawSearchHit = {
        brief: "",
        sources,
        pages,
        queries: plan.queries,
        provider: "offline_replay",
        rawGroundingSupports: supports,
        limitations: ["offline_gate_invariance_replay"],
      };

      const corpus = collectEventsFromHit(plan, hit, {
        now: new Date("2026-11-16T00:00:00.000Z"),
      });
      const withGate = gateEvidence({ plan, corpus });
      const stripped = stripSearchSynthesisFromCorpus(corpus);
      const withoutGate = gateEvidence({ plan, corpus: stripped });
      const synthClaims = corpus.events
        .flatMap((e) => e.claims)
        .filter((c) => c.provenance === "search_synthesis").length;
      const truncatedSynth = (corpus.stats.excluded || []).filter((e) =>
        /synth|搜尋摘要/i.test(e.title),
      ).length;

      results.push({
        qi,
        text: research.text,
        frozenLiveGate: research.gate,
        frozenSynthClaims: research.searchSynthesisClaimCount,
        rawSupportCount: supports.length,
        rebuiltSynthClaims: synthClaims,
        truncatedSynthLikeExcluded: truncatedSynth,
        truncatedEvents: corpus.stats.truncatedEvents,
        excludedSample: corpus.stats.excluded.slice(0, 8),
        gateWithSynth: withGate.status,
        gateWithoutSynth: withoutGate.status,
        completionWith: withGate.completionStatus,
        completionWithout: withoutGate.completionStatus,
        invariant: withGate.status === withoutGate.status,
        conflictLimitations: corpus.limitations.filter((l) =>
          l.startsWith("synthesis_conflict_article_body_wins:"),
        ),
      });
    }
  } finally {
    delete process.env.RESEARCH_SEARCH_SYNTHESIS;
  }

  const allOk = results.every((r) => r.invariant);
  const report = {
    measuredAt: new Date().toISOString(),
    allInvariant: allOk,
    results,
    q3Note: (() => {
      const q3 = results.find((r) => r.qi === 3);
      if (!q3) return null;
      return {
        rawSupportCount: q3.rawSupportCount,
        rebuiltSynthClaims: q3.rebuiltSynthClaims,
        frozenSynthClaims: q3.frozenSynthClaims,
        explanation:
          q3.rawSupportCount > 0 && q3.frozenSynthClaims === 0
            ? "Flash 有回傳 groundingSupports；synthesis 事件被建立但在 rankEventsWithDiversity（maxEvents／主題多樣性）後被截斷，未進入最終 injection。非過濾、非 Flash 未回傳。"
            : q3.rawSupportCount === 0
              ? "未在 jsonl 對到 supports"
              : "見 results",
      };
    })(),
  };

  writeFileSync(path.join(LIVE, "gate-invariance-live6.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ allInvariant: allOk, q3: report.q3Note, results: results.map((r) => ({
    qi: r.qi,
    invariant: r.invariant,
    with: r.gateWithSynth,
    without: r.gateWithoutSynth,
    synth: r.rebuiltSynthClaims,
    supports: r.rawSupportCount,
  })) }, null, 2));
  if (!allOk) process.exit(1);
}

main();
