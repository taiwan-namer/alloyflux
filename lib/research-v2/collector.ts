import { cleanSourceUrl } from "../web-research";
import { sanitizeEvidenceText } from "./sanitize";
import type {
  EvidenceGrade,
  EvidenceLevel,
  EvidenceProvenance,
  FetchStatus,
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
const OFFICIAL_HOST_RE =
  /(sec\.gov|whitehouse\.gov|gov\.tw|europa\.eu|un\.org|nvidianews\.nvidia\.com)/i;

function hostnameOf(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function sourceQuality(host: string): ResearchSource["quality"] {
  if (PREFERRED_HOST_RE.test(host) || OFFICIAL_HOST_RE.test(host)) return "preferred";
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

function inferClaimType(text: string, provenance: EvidenceProvenance): ResearchClaimType {
  // 僅標題／搜尋摘要：不得升格為已核對事實
  if (provenance === "title_only" || provenance === "search_snippet") {
    if (/尚未確認|未正式確認|未證實|unconfirmed|not\s+confirm/i.test(text)) return "unconfirmed";
    if (/否認|駁斥|denied/i.test(text)) return "denied";
    if (/主張|質疑|聲稱|alleged|says?|claims?/i.test(text)) return "party_claim";
    return "unconfirmed";
  }
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

/**
 * 歸屬僅在來源文本支持時填寫；不可從 Flash brief 單獨捏造。
 */
function inferAttribution(text: string, provenance: EvidenceProvenance): string | undefined {
  if (provenance === "title_only" && text.length < 40) return undefined;
  if (/中方尚未|中國尚未|北京尚未/i.test(text)) return "中方尚未確認";
  if (/克里姆林|俄方確認|俄羅斯確認/i.test(text)) return "俄方／克里姆林宮";
  if (/白宮|美方宣布|美國宣布/i.test(text)) return "美方／白宮";
  if (/川普|特朗普/.test(text) && /表示|說|談/.test(text)) return "川普本人／陣營";
  return undefined;
}

function provenanceForSource(opts: {
  hasBody: boolean;
  host: string;
  fetchStatus: FetchStatus;
}): EvidenceProvenance {
  if (opts.hasBody) {
    if (OFFICIAL_HOST_RE.test(opts.host)) return "official_document";
    return "article_body";
  }
  if (opts.fetchStatus === "ok") return "title_only";
  return "title_only";
}

function evidenceLevelFor(
  quality: ResearchSource["quality"],
  claimType: ResearchClaimType,
  provenance: EvidenceProvenance,
): EvidenceLevel {
  if (claimType === "unconfirmed") return "weak";
  if (provenance === "title_only" || provenance === "search_snippet" || provenance === "unknown") {
    return "insufficient";
  }
  if (quality === "preferred" && provenance === "article_body") return "strong";
  if (quality === "preferred" && provenance === "official_document") return "strong";
  if (quality === "preferred") return "moderate";
  if (quality === "normal" && provenance === "article_body") return "moderate";
  if (quality === "demoted") return "weak";
  return "insufficient";
}

function gradeEvent(ev: ResearchEvent, sources: ResearchSource[]): EvidenceGrade {
  const linked = sources.filter((s) => ev.sourceIds.includes(s.sourceId));
  const hasBody = linked.some(
    (s) => s.provenance === "article_body" || s.provenance === "official_document",
  );
  const hasDate = Boolean(ev.publishedAt) || linked.some((s) => s.publishedAt);
  const hasConflict = ev.claims.some((c) => c.claimType === "denied") &&
    ev.claims.some((c) => c.claimType === "reported_fact" || c.claimType === "party_claim");
  if (hasConflict) return "conflict";
  if (hasBody && hasDate) return "body_with_date";
  if (hasBody) return "body_missing_date";
  if (linked.length === 0) return "search_failed";
  return "title_only";
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
 * 從 RawSearchHit 建立結構化 Corpus。
 * Flash brief 僅作線索／unconfirmed 提示，不得冒充 article_body。
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
    "flash_brief_is_search_snippet_not_article_body",
  ];

  const pageByUri = new Map(
    hit.pages.map((p) => [cleanSourceUrl(p.resolvedUrl || p.uri), p]),
  );
  // 也以 originalUrl 索引
  for (const p of hit.pages) {
    if (p.originalUrl) pageByUri.set(cleanSourceUrl(p.originalUrl), p);
    pageByUri.set(cleanSourceUrl(p.uri), p);
  }

  const rawSources: ResearchSource[] = [];
  const seenUri = new Set<string>();

  for (const s of hit.sources) {
    const originalUrl = cleanSourceUrl(s.originalUrl || s.uri);
    const resolvedUrl = s.resolvedUrl ? cleanSourceUrl(s.resolvedUrl) : undefined;
    const uri = resolvedUrl || originalUrl;
    if (!/^https?:\/\//i.test(uri)) continue;
    if (seenUri.has(uri)) continue;
    seenUri.add(uri);
    const host = hostnameOf(uri);
    const page = pageByUri.get(uri) || pageByUri.get(originalUrl);
    const hasBody = Boolean(page?.excerpt && page.excerpt.length >= 120);
    const fetchStatus: FetchStatus =
      page?.fetchStatus ?? (hasBody ? "ok" : page ? "ok" : "unresolved");
    const provenance = provenanceForSource({ hasBody, host, fetchStatus });
    const publishedAt = s.publishedAt || page?.publishedAt || undefined;
    rawSources.push({
      sourceId: stableId("src", uri),
      title: (s.title || page?.title || host || uri).trim(),
      uri,
      originalUrl,
      resolvedUrl: resolvedUrl || (page?.resolvedUrl ? cleanSourceUrl(page.resolvedUrl) : undefined),
      host,
      publishedAt,
      excerpt: hasBody && page?.excerpt ? sanitizeEvidenceText(page.excerpt, 900) : undefined,
      quality: sourceQuality(host),
      fetchStatus,
      provenance,
    });
  }

  for (const p of hit.pages) {
    const originalUrl = cleanSourceUrl(p.originalUrl || p.uri);
    const resolvedUrl = p.resolvedUrl ? cleanSourceUrl(p.resolvedUrl) : cleanSourceUrl(p.uri);
    const uri = resolvedUrl || originalUrl;
    if (!/^https?:\/\//i.test(uri) || seenUri.has(uri)) continue;
    seenUri.add(uri);
    const host = hostnameOf(uri);
    const hasBody = Boolean(p.excerpt && p.excerpt.length >= 120);
    const fetchStatus: FetchStatus = p.fetchStatus ?? (hasBody ? "ok" : "failed");
    rawSources.push({
      sourceId: stableId("src", uri),
      title: (p.title || host).trim(),
      uri,
      originalUrl,
      resolvedUrl,
      host,
      publishedAt: p.publishedAt || undefined,
      excerpt: hasBody ? sanitizeEvidenceText(p.excerpt, 900) : undefined,
      quality: sourceQuality(host),
      fetchStatus,
      provenance: provenanceForSource({ hasBody, host, fetchStatus }),
    });
  }

  const byMerge = new Map<string, ResearchEvent>();
  // brief 僅作 search_snippet 線索，不用來當 article_body claim
  const briefSafe = sanitizeEvidenceText(hit.brief, 2000);

  for (const src of rawSources) {
    const topic = guessTopic(`${src.title} ${src.excerpt ?? ""}`);
    const mergeKey = eventMergeKey(src.title, src.publishedAt, topic);
    const claimText =
      src.provenance === "article_body" || src.provenance === "official_document"
        ? `${src.title}\n${src.excerpt ?? ""}`
        : src.title;
    const claimType = inferClaimType(claimText, src.provenance);
    const attribution = inferAttribution(claimText, src.provenance);
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
      evidenceLevel: evidenceLevelFor(src.quality, claimType, src.provenance),
      provenance: src.provenance,
    };

    const existing = byMerge.get(mergeKey);
    if (existing) {
      if (!existing.sourceIds.includes(src.sourceId)) existing.sourceIds.push(src.sourceId);
      if (!existing.claims.some((c) => c.statement === claim.statement)) {
        existing.claims.push(claim);
      } else {
        const c0 = existing.claims.find((c) => c.statement === claim.statement);
        if (c0 && !c0.sourceIds.includes(src.sourceId)) c0.sourceIds.push(src.sourceId);
      }
      if (!existing.publishedAt && src.publishedAt) existing.publishedAt = src.publishedAt;
      existing.relevance = Math.max(existing.relevance, qualityScore(src.quality));
      existing.freshness = Math.max(existing.freshness, freshnessScore(src.publishedAt, plan, nowMs));
      continue;
    }

    const event: ResearchEvent = {
      eventId: stableId("evt", mergeKey),
      title: src.title.slice(0, 160),
      eventAt: undefined,
      publishedAt: src.publishedAt,
      topic,
      claims: [claim],
      sourceIds: [src.sourceId],
      relevance: qualityScore(src.quality),
      freshness: freshnessScore(src.publishedAt, plan, nowMs),
      diversityKey: topic,
      evidenceGrade: "unknown",
    };
    byMerge.set(mergeKey, event);
  }

  // brief 中「尚未確認」→ 以 search_snippet 補弱主張（明確 provenance）
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
        attribution: inferAttribution(briefSafe, "search_snippet"),
        evidenceLevel: "weak",
        provenance: "search_snippet",
      });
    }
  }

  for (const ev of byMerge.values()) {
    ev.evidenceGrade = gradeEvent(ev, rawSources);
  }

  const rawEvents = [...byMerge.values()];
  const ranked = rankEventsWithDiversity(rawEvents, plan.limits.maxEvents);

  let bodyWithDate = 0;
  let bodyMissingDate = 0;
  let titleOnly = 0;
  for (const e of ranked.events) {
    if (e.evidenceGrade === "body_with_date") bodyWithDate += 1;
    else if (e.evidenceGrade === "body_missing_date") bodyMissingDate += 1;
    else if (e.evidenceGrade === "title_only") titleOnly += 1;
  }

  return {
    plan,
    sources: rawSources,
    events: ranked.events,
    queriesUsed: hit.queries.slice(0, plan.limits.maxQueries),
    pagesFetched: hit.pages.filter((p) => p.fetchStatus !== "blocked_ssrf").length,
    limitations,
    searchProvider: hit.provider,
    stats: {
      rawSourceCount: hit.sources.length + hit.pages.length,
      dedupedSourceCount: rawSources.length,
      rawEventCount: rawEvents.length,
      dedupedEventCount: byMerge.size,
      truncatedEvents: ranked.truncated,
      excluded: ranked.excluded,
      bodyWithDate,
      bodyMissingDate,
      titleOnly,
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

  for (const e of scored) {
    if (picked.length >= maxEvents) break;
    const n = topicCount.get(e.diversityKey) ?? 0;
    if (n >= MAX_PER_TOPIC) continue;
    picked.push(e);
    topicCount.set(e.diversityKey, n + 1);
  }
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
