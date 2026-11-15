import {
  formatResearchInjection,
  MAX_RESEARCH_BRIEF_CHARS,
  type ResearchBundle,
} from "../../web-research.ts";
import { estimateTokensApprox, measureInjectionBudget, runResearchPipelineV2 } from "../index.ts";
import {
  fixtureA_DuplicatePolitics,
  fixtureB_MultiTopicSameDay,
  fixtureC_ConflictingConfirmation,
} from "../fixtures/news-fixtures.ts";
import type { RawSearchHit } from "../types.ts";

const NOW = new Date("2026-11-15T12:00:00+08:00");

function toV1(hit: RawSearchHit): ResearchBundle {
  const brief =
    hit.brief.length > MAX_RESEARCH_BRIEF_CHARS
      ? `${hit.brief.slice(0, MAX_RESEARCH_BRIEF_CHARS - 1)}…`
      : hit.brief;
  return {
    brief,
    sources: hit.sources.map((s) => ({ title: s.title, uri: s.uri })),
    queries: hit.queries,
    pages: hit.pages.slice(0, 3).map((p) => ({ title: p.title, uri: p.uri, excerpt: p.excerpt })),
  };
}

const fixtures: [string, RawSearchHit][] = [
  ["A", fixtureA_DuplicatePolitics()],
  ["B", fixtureB_MultiTopicSameDay()],
  ["C", fixtureC_ConflictingConfirmation()],
];

for (const [name, hit] of fixtures) {
  hit.brief = `${hit.brief}\n${"延伸。".repeat(80)}`;
  const v1 = formatResearchInjection(toV1(hit));
  const verdict = await runResearchPipelineV2({
    messages: [{ role: "user", content: "最新消息" }],
    now: NOW,
    mockHit: hit,
  });
  const m = measureInjectionBudget(verdict);
  const topics = [...new Set((verdict.corpus?.events || []).map((e) => e.topic))];
  console.log(
    JSON.stringify({
      fixture: name,
      kind: "offline_same_source_replay",
      v1: { chars: v1.length, estTokens: estimateTokensApprox(v1) },
      v2: {
        chars: m.charLength,
        estTokens: m.estimatedTokens,
        maxTokens: m.maxTokens,
        eventsIncluded: m.eventsIncluded,
        eventsTotal: verdict.corpus?.events.length,
        topics,
      },
    }),
  );
}
