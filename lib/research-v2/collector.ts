import { cleanSourceUrl } from "../web-research";
import { sanitizeEvidenceText } from "./sanitize";
import type {
  EvidenceLevel,
  RawSearchHit,
  ResearchClaim,
  ResearchClaimType,
  ResearchCorpus,
  ResearchEvent,
  ResearchPlan,
  ResearchSource,
} from "./types";

const PREFERRED_HOST_RE =
  /(reuters\.com|apnews\.com|bloomberg\.com|bbc\.(com|co\.uk)|nytimes\.com|wsj\.com|ft\.com|cnbc\.com|theguardian\.com|cbsnews\.com|independent\.co\.uk|cna\.com\.tw|udn\.com)/i;
const DEMOTED_HOST_RE =
  /(wikipedia\.org|youtube\.com|youtu\.be|bilibili\.com)/i;

function hostnameOf(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function sourceQuality(host: string): ResearchSource["quality"] {
  if (PREFERRED_HOST_RE.test(host)) return "preferred";
  if (DEMOTED_HOST_RE.test(host)) return "demoted";
  return "normal";
}

function stableId(prefix: string, ...parts: string[]): string {
  const raw = parts.join("|").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${(h >>> 0).toString(16)}`;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 主體＋日期＋標題 token 重疊 → 同一事件（不只標題 hash） */
function eventMergeKey(title: string, publishedAt?: string, topic?: string): string {
  const norm = normalizeTitle(title);
  const tokens = norm.split(" ").filter((t) => t.length > 1).slice(0, 8);
  const day = publishedAt?.slice(0, 10) ?? "nodate";
  const actors = extractActors(title).sort().join(",");
  return `${topic ?? guessTopic(title)}|${day}|${actors}|${tokens.slice(0, 4).join(" ")}`;
}

function extractActors(text: string): string[] {
  const actors: string[] = [];
  if (/川普|特朗普|trump/i.test(text)) actors.push("trump");
  if (/習近平|习近平|xi\b/i.test(text)) actors.push("xi");
  if (/普丁|普京|putin/i.test(text)) actors.push("putin");
  if (/拜登|biden/i.test(text)) actors.push("biden");
  return actors;
}

function guessTopic(text: string): string {
  if (/選舉|中期|期中|midterm|election|國會|congress|ballot/i.test(text)) return "election";
  if (/會談|峰會|summit|APEC|會見|訪問|行程|外交|trilateral|xi|putin|習|普丁/i.test(text)) {
    return "diplomacy";
  }
  if (/伊朗|戰爭|軍事|攻擊|導彈|核武|military|missile/i.test(text)) return "security";
  if (/關稅|貿易|股市|經濟|tariff|trade|market|markets/i.test(text)) return "economy";
  return "other";
}

function inferClaimType(text: string): ResearchClaimType {
  if (/尚未確認|未正式確認|未證實|沒有證實|unconfirmed|not\s+confirm/i.test(text)) {
    return "unconfirmed";
  }
  if (/否認|駁斥|denied|rejects?/i.test(text)) return "denied";
  if (/主張|質疑|聲稱|表示|宣布|確認|says?|claims?|alleged/i.test(text)) {
    if (/美方|白宮|克里姆林|俄方|中方|川普|特朗普/.test(text)) return "party_claim";
  }
  if (/質疑|聲稱|alleged|without\s+evidence/i.test(text)) return "party_claim";
  return "reported_fact";
}

function inferAttribution(text: string): string | undefined {
  if (/中方尚未|中國尚未|北京尚未/i.test(text)) return "中方尚未確認";
  if (/克里姆林|俄方確認|俄羅斯確認/i.test(text)) return "俄方／克里姆林宮";
  if (/白宮|美方宣布|美國宣布/i.test(text)) return "美方／白宮";
  if (/川普|特朗普/.test(text) && /表示|說|談/.test(text)) return "川普本人／陣營";
  return undefined;
}

function evidenceLevelFor(
  quality: ResearchSource["quality"],
  claimType: ResearchClaimType,
  hasExcerpt: boolean,
): EvidenceLevel {
  if (claimType === "unconfirmed") return "weak";
  if (quality === "preferred" && hasExcerpt) return "strong";
  if (quality === "preferred") return "moderate";
  if (quality === "normal" && hasExcerpt) return "moderate";
  if (quality === "demoted") return "weak";
  return "insufficient";
}

function freshnessScore(publishedAt: string | undefined, plan: ResearchPlan, nowMs: number): number {
  if (!publishedAt) return 0.35;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0.35;
  const ageH = (nowMs - t) / 3_600_000;
  const prefer = plan.timeWindow?.preferRecentHours ?? 72;
  if (ageH <= 24) return 1;
  if (ageH <= prefer) return 0.85;
  if (plan.timeWindow) {
    const from = Date.parse(plan.timeWindow.fromIso);
    if (Number.isFinite(from) && t >= from) return 0.55;
  }
  return 0.2;
}

function qualityScore(q: ResearchSource["quality"]): number {
  if (q === "preferred") return 1;
  if (q === "normal") return 0.6;
  return 0.25;
}

/**
 * 從 RawSearchHit 建立結構化 Corpus（不做 700 字真相截斷）
 */
export function collectEventsFromHit(
  plan: ResearchPlan,
  hit: RawSearchHit,
  opts?: { now?: Date },
): ResearchCorpus {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const limitations = [
    ...(hit.limitations ?? []),
    "grounding_partial_serp: Gemini Grounding 非完整 SERP，僅能使用回傳之 URI／摘要",
  ];

  const pageByUri = new Map(hit.pages.map((p) => [cleanSourceUrl(p.uri), p]));
  const rawSources: ResearchSource[] = [];
  const seenUri = new Set<string>();

  for (const s of hit.sources) {
    const uri = cleanSourceUrl(s.uri);
    if (!/^https?:\/\//i.test(uri)) continue;
    if (seenUri.has(uri)) continue;
    seenUri.add(uri);
    const host = hostnameOf(uri);
    const page = pageByUri.get(uri);
    const publishedAt = s.publishedAt || page?.publishedAt;
    rawSources.push({
      sourceId: stableId("src", uri),
      title: (s.title || page?.title || host || uri).trim(),
      uri,
      host,
      publishedAt: publishedAt || undefined,
      excerpt: page?.excerpt ? sanitizeEvidenceText(page.excerpt, 900) : undefined,
      quality: sourceQuality(host),
    });
  }

  // 頁面有、sources 沒有的也納入
  for (const p of hit.pages) {
    const uri = cleanSourceUrl(p.uri);
    if (!/^https?:\/\//i.test(uri) || seenUri.has(uri)) continue;
    seenUri.add(uri);
    const host = hostnameOf(uri);
    rawSources.push({
      sourceId: stableId("src", uri),
      title: (p.title || host).trim(),
      uri,
      host,
      publishedAt: p.publishedAt || undefined,
      excerpt: p.excerpt ? sanitizeEvidenceText(p.excerpt, 900) : undefined,
      quality: sourceQuality(host),
    });
  }

  const byMerge = new Map<string, ResearchEvent>();
  const briefSafe = sanitizeEvidenceText(hit.brief, 2000);

  for (const src of rawSources) {
    const topic = guessTopic(`${src.title} ${src.excerpt ?? ""}`);
    const mergeKey = eventMergeKey(src.title, src.publishedAt, topic);
    const claimType = inferClaimType(`${src.title}\n${src.excerpt ?? ""}\n${briefSafe}`);
    const attribution = inferAttribution(`${src.title}\n${src.excerpt ?? ""}\n${briefSafe}`);
    const statement = sanitizeEvidenceText(
      src.excerpt?.slice(0, 280) || src.title,
      280,
    );
    const claim: ResearchClaim = {
      claimId: stableId("clm", src.sourceId, statement.slice(0, 40)),
      statement,
      claimType,
      sourceIds: [src.sourceId],
      attribution,
      evidenceLevel: evidenceLevelFor(src.quality, claimType, Boolean(src.excerpt)),
    };

    const existing = byMerge.get(mergeKey);
    if (existing) {
      if (!existing.sourceIds.includes(src.sourceId)) existing.sourceIds.push(src.sourceId);
      // 同事件合併主張（去重 statement）
      if (!existing.claims.some((c) => c.statement === claim.statement)) {
        existing.claims.push(claim);
      } else {
        const c0 = existing.claims.find((c) => c.statement === claim.statement);
        if (c0 && !c0.sourceIds.includes(src.sourceId)) c0.sourceIds.push(src.sourceId);
      }
      // publishedAt：只在缺值時補；eventAt 永不由 publishedAt 填入
      if (!existing.publishedAt && src.publishedAt) existing.publishedAt = src.publishedAt;
      existing.relevance = Math.max(existing.relevance, qualityScore(src.quality));
      existing.freshness = Math.max(existing.freshness, freshnessScore(src.publishedAt, plan, nowMs));
      continue;
    }

    const event: ResearchEvent = {
      eventId: stableId("evt", mergeKey),
      title: src.title.slice(0, 160),
      // 不把 publishedAt 寫入 eventAt
      eventAt: undefined,
      publishedAt: src.publishedAt,
      topic,
      claims: [claim],
      sourceIds: [src.sourceId],
      relevance: qualityScore(src.quality),
      freshness: freshnessScore(src.publishedAt, plan, nowMs),
      diversityKey: topic,
    };
    byMerge.set(mergeKey, event);
  }

  // brief 中明確「尚未確認」→ 若尚無 unconfirmed claim，補一條弱主張（不新造新聞事實）
  if (/尚未確認|未正式確認|unconfirmed/i.test(briefSafe) && byMerge.size) {
    const first = [...byMerge.values()][0];
    if (first && !first.claims.some((c) => c.claimType === "unconfirmed")) {
      first.claims.push({
        claimId: stableId("clm", first.eventId, "unconfirmed"),
        statement: sanitizeEvidenceText(
          briefSafe.match(/[^。\n]*(尚未確認|未正式確認|unconfirmed)[^。\n]*/i)?.[0] ||
            "相關安排尚未獲全數相關方確認",
          200,
        ),
        claimType: "unconfirmed",
        sourceIds: first.sourceIds.slice(0, 1),
        attribution: inferAttribution(briefSafe),
        evidenceLevel: "weak",
      });
    }
  }

  const rawEvents = [...byMerge.values()];
  const ranked = rankEventsWithDiversity(rawEvents, plan.limits.maxEvents);

  return {
    plan,
    sources: rawSources,
    events: ranked.events,
    queriesUsed: hit.queries.slice(0, plan.limits.maxQueries),
    pagesFetched: hit.pages.length,
    limitations,
    searchProvider: hit.provider,
    stats: {
      rawSourceCount: hit.sources.length + hit.pages.length,
      dedupedSourceCount: rawSources.length,
      rawEventCount: rawEvents.length,
      dedupedEventCount: byMerge.size,
      truncatedEvents: ranked.truncated,
      excluded: ranked.excluded,
    },
  };
}

/** 相關性×時效×品質，並強制主題多樣（避免單一熱點占滿） */
export function rankEventsWithDiversity(
  events: ResearchEvent[],
  maxEvents: number,
): {
  events: ResearchEvent[];
  truncated: number;
  excluded: { eventId: string; title: string; reason: string }[];
} {
  const scored = [...events].sort((a, b) => {
    const sa = a.relevance * 0.35 + a.freshness * 0.45 + (a.claims.length ? 0.2 : 0);
    const sb = b.relevance * 0.35 + b.freshness * 0.45 + (b.claims.length ? 0.2 : 0);
    return sb - sa;
  });

  const picked: ResearchEvent[] = [];
  const topicCount = new Map<string, number>();
  const MAX_PER_TOPIC = 2;
  const excluded: { eventId: string; title: string; reason: string }[] = [];

  // 第一輪：每主題最多 2
  for (const e of scored) {
    if (picked.length >= maxEvents) break;
    const n = topicCount.get(e.diversityKey) ?? 0;
    if (n >= MAX_PER_TOPIC) continue;
    picked.push(e);
    topicCount.set(e.diversityKey, n + 1);
  }
  // 第二輪：填滿
  for (const e of scored) {
    if (picked.length >= maxEvents) break;
    if (picked.some((p) => p.eventId === e.eventId)) continue;
    picked.push(e);
  }

  const pickedIds = new Set(picked.map((e) => e.eventId));
  for (const e of scored) {
    if (pickedIds.has(e.eventId)) continue;
    const n = topicCount.get(e.diversityKey) ?? 0;
    const reason =
      picked.length >= maxEvents
        ? "max_events_cap"
        : n >= MAX_PER_TOPIC
          ? "topic_diversity_cap"
          : "ranked_out";
    excluded.push({ eventId: e.eventId, title: e.title.slice(0, 80), reason });
  }

  return { events: picked, truncated: excluded.length, excluded };
}
