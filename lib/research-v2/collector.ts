import { cleanSourceUrl } from "../web-research";
import { sanitizeEvidenceText } from "./sanitize";
import { shouldEnableSearchSynthesis } from "./synthesis-flag";
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

/** 長正文切段門檻／目標塊長／最多段數（避免 FAQ／律所長文中後段被單條 claim 腰斬） */
export const BODY_EXCERPT_SPLIT_THRESHOLD = 700;
export const BODY_EXCERPT_CHUNK_CHARS = 700;
export const BODY_EXCERPT_MAX_PARTS = 3;
export const BODY_EXCERPT_HARD_CAP = 1800;

/**
 * 將 article_body／official_document 的 excerpt 切成最多 2~3 段。
 * 優先在段落／句號邊界切開，確保費率、條款等中後段細節不會整段丟掉。
 */
export function splitLongBodyExcerpt(
  excerpt: string,
  opts?: { threshold?: number; chunkSize?: number; maxParts?: number; hardCap?: number },
): string[] {
  const threshold = opts?.threshold ?? BODY_EXCERPT_SPLIT_THRESHOLD;
  const chunkSize = opts?.chunkSize ?? BODY_EXCERPT_CHUNK_CHARS;
  const maxParts = opts?.maxParts ?? BODY_EXCERPT_MAX_PARTS;
  const hardCap = opts?.hardCap ?? BODY_EXCERPT_HARD_CAP;
  const capped = excerpt.trim().slice(0, hardCap);
  if (!capped) return [];
  if (capped.length <= threshold) return [capped];

  const parts: string[] = [];
  let start = 0;
  while (parts.length < maxParts && start < capped.length) {
    if (parts.length === maxParts - 1) {
      const rest = capped.slice(start).trim();
      if (rest) parts.push(rest);
      break;
    }
    let end = Math.min(start + chunkSize, capped.length);
    if (end < capped.length) {
      const lookAhead = Math.min(capped.length, end + 100);
      const window = capped.slice(start, lookAhead);
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
      ].filter((i) => i >= Math.floor(chunkSize * 0.45));
      const breakAt = candidates.length ? Math.max(...candidates) : -1;
      if (breakAt >= 0) {
        const ch = window[breakAt];
        const eat =
          ch === "." || ch === "!" || ch === "?"
            ? breakAt + 1
            : ch === "。" || ch === "！" || ch === "？"
              ? breakAt + 1
              : breakAt + (ch === "\n" ? 1 : 0);
        end = start + Math.max(eat, Math.floor(chunkSize * 0.45));
      }
    }
    const piece = capped.slice(start, end).trim();
    if (piece) parts.push(piece);
    start = end;
    while (start < capped.length && /\s/.test(capped[start]!)) start += 1;
  }
  return parts.length ? parts : [capped];
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
  // 突發事故／災害優先，避免「機場／選舉」等誤傷
  if (/撞機|空難|墜機|地震|颱風|飓风|洪水|野火|事故|disaster|plane\s*crash|earthquake|hurricane/i.test(text)) {
    return "disaster";
  }
  if (/CEO|執行長|董事會|財報|併購|裁員|earnings|corporate|resign|newsroom|8-K|form\s*8/i.test(text)) {
    return "corporate";
  }
  if (
    /選舉|中期|期中|midterm|election|國會|congress|ballot/i.test(text) &&
    !/機場|航空|航班|airport|airline/i.test(text)
  ) {
    return "election";
  }
  // xi 需詞界，避免誤傷含 xi 字元序列的英文詞
  if (
    /會談|峰會|summit|APEC|會見|外交|trilateral|putin|習近平|普丁|普京/i.test(text) ||
    /(^|[^a-z])xi([^a-z]|$)/i.test(text)
  ) {
    return "diplomacy";
  }
  if (/伊朗|戰爭|軍事|攻擊|導彈|核武|military|missile/i.test(text)) return "security";
  if (/關稅|貿易|股市|經濟|tariff|trade|market|markets/i.test(text)) return "economy";
  return "other";
}

function inferClaimType(text: string, provenance: EvidenceProvenance): ResearchClaimType {
  // 僅標題／搜尋摘要／synthesis：不得升格為已核對事實
  if (
    provenance === "title_only" ||
    provenance === "search_snippet" ||
    provenance === "search_synthesis"
  ) {
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
  if (
    provenance === "title_only" ||
    provenance === "search_snippet" ||
    provenance === "search_synthesis" ||
    provenance === "unknown"
  ) {
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

/** 從 Flash groundingSupports 取出 segment.text */
function groundingSupportSegmentText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const segment = (raw as { segment?: unknown }).segment;
  if (!segment || typeof segment !== "object") return null;
  const text = (segment as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

/** 與既有 article_body 事件重疊 → 衝突，以正文為準 */
function findArticleBodyConflict(
  seg: string,
  byMerge: Map<string, ResearchEvent>,
): ResearchEvent | null {
  const tokens = seg
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 16);
  if (tokens.length < 3) return null;
  for (const ev of byMerge.values()) {
    const hasBody = ev.claims.some((c) => c.provenance === "article_body");
    if (!hasBody) continue;
    const blob = `${ev.title} ${ev.claims.map((c) => c.statement).join(" ")}`.toLowerCase();
    const hits = tokens.filter((t) => blob.includes(t)).length;
    if (hits >= 3) return ev;
  }
  return null;
}

/**
 * 移除 search_synthesis 主張／純 synthesis 事件（Gate 不變性／A/B without_synth）。
 * 不改其他 provenance。
 */
export function stripSearchSynthesisFromCorpus(corpus: ResearchCorpus): ResearchCorpus {
  const events = corpus.events
    .map((e) => ({
      ...e,
      claims: e.claims.filter((c) => c.provenance !== "search_synthesis"),
    }))
    .filter((e) => e.claims.length > 0);
  return {
    ...corpus,
    events,
    limitations: [
      ...corpus.limitations.filter((l) => !l.startsWith("search_synthesis")),
      "search_synthesis_stripped_for_gate_check",
    ],
    stats: {
      ...corpus.stats,
      dedupedEventCount: events.length,
    },
  };
}

/**
 * 從 RawSearchHit 建立結構化 Corpus。
 * Flash brief 僅作線索／unconfirmed 提示，不得冒充 article_body。
 */
export function collectEventsFromHit(
  plan: ResearchPlan,
  hit: RawSearchHit,
  opts?: { now?: Date; autoSynthesisFallback?: boolean },
): ResearchCorpus {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const limitations = [
    ...(hit.limitations ?? []),
    "grounding_partial_serp: Gemini Grounding 非完整 SERP，僅能使用回傳之 URI／摘要",
    "flash_brief_is_search_snippet_not_article_body",
  ];

  const canon = (u: string) => cleanSourceUrl(u).toLowerCase().replace(/\/$/, "");

  const pageByUri = new Map(
    hit.pages.map((p) => [canon(p.resolvedUrl || p.uri), p]),
  );
  for (const p of hit.pages) {
    if (p.originalUrl) pageByUri.set(canon(p.originalUrl), p);
    pageByUri.set(canon(p.uri), p);
  }

  const rawSources: ResearchSource[] = [];
  const seenUri = new Set<string>();

  for (const s of hit.sources) {
    const originalUrl = cleanSourceUrl(s.originalUrl || s.uri);
    const resolvedUrl = s.resolvedUrl ? cleanSourceUrl(s.resolvedUrl) : undefined;
    const uri = resolvedUrl || originalUrl;
    if (!/^https?:\/\//i.test(uri)) continue;
    const key = canon(uri);
    if (seenUri.has(key)) continue;
    seenUri.add(key);
    const host = hostnameOf(uri);
    const page = pageByUri.get(key) || pageByUri.get(canon(originalUrl));
    const excerptRaw = page?.excerpt?.trim() || "";
    const hasBody =
      Boolean(excerptRaw.length >= 120) &&
      page?.fetchStatus === "ok" &&
      !/@font-face|skip\s+to\s+main/i.test(excerptRaw);
    const fetchStatus: FetchStatus =
      page?.fetchStatus ?? (hasBody ? "ok" : page ? "failed" : "unresolved");
    const provenance = provenanceForSource({ hasBody, host, fetchStatus });
    const publishedAt = s.publishedAt || page?.publishedAt || undefined;
    rawSources.push({
      sourceId: stableId("src", key),
      title: (s.title || page?.title || host || uri).trim(),
      uri,
      originalUrl,
      resolvedUrl: resolvedUrl || (page?.resolvedUrl ? cleanSourceUrl(page.resolvedUrl) : undefined),
      host,
      publishedAt,
      excerpt: hasBody ? sanitizeEvidenceText(excerptRaw, 1800) : undefined,
      quality: sourceQuality(host),
      fetchStatus,
      provenance,
      htmlPath: page?.htmlPath,
      htmlSha256: page?.htmlSha256,
    });
  }

  for (const p of hit.pages) {
    const originalUrl = cleanSourceUrl(p.originalUrl || p.uri);
    const resolvedUrl = p.resolvedUrl ? cleanSourceUrl(p.resolvedUrl) : cleanSourceUrl(p.uri);
    const uri = resolvedUrl || originalUrl;
    const key = canon(uri);
    if (!/^https?:\/\//i.test(uri) || seenUri.has(key)) continue;
    seenUri.add(key);
    const host = hostnameOf(uri);
    const excerptRaw = p.excerpt?.trim() || "";
    const hasBody =
      Boolean(excerptRaw.length >= 120) &&
      (p.fetchStatus ?? "ok") === "ok" &&
      !/@font-face|skip\s+to\s+main/i.test(excerptRaw);
    const fetchStatus: FetchStatus = p.fetchStatus ?? (hasBody ? "ok" : "failed");
    rawSources.push({
      sourceId: stableId("src", key),
      title: (p.title || host).trim(),
      uri,
      originalUrl,
      resolvedUrl,
      host,
      publishedAt: p.publishedAt || undefined,
      excerpt: hasBody ? sanitizeEvidenceText(excerptRaw, 1800) : undefined,
      quality: sourceQuality(host),
      fetchStatus,
      provenance: provenanceForSource({ hasBody, host, fetchStatus }),
      htmlPath: p.htmlPath,
      htmlSha256: p.htmlSha256,
    });
  }

  const byMerge = new Map<string, ResearchEvent>();
  // brief 僅作 search_snippet 線索，不用來當 article_body claim
  const briefSafe = sanitizeEvidenceText(hit.brief, 4000);

  for (const src of rawSources) {
    const topic = guessTopic(`${src.title} ${src.excerpt ?? ""}`);
    // 同一 canonical URL 只形成一個事件（標題差異不裂開）
    const mergeKey = `url:${canon(src.uri)}`;
    const isBodyBacked =
      src.provenance === "article_body" || src.provenance === "official_document";
    const claimText = isBodyBacked ? `${src.title}\n${src.excerpt ?? ""}` : src.title;
    const claimType = inferClaimType(claimText, src.provenance);
    const attribution = inferAttribution(claimText, src.provenance);
    const statementParts = isBodyBacked
      ? splitLongBodyExcerpt(src.excerpt || src.title)
      : [sanitizeEvidenceText(src.title, 560)];
    const claims: ResearchClaim[] = statementParts.map((part, idx) => {
      const statement = sanitizeEvidenceText(part, isBodyBacked ? 750 : 560);
      return {
        claimId: stableId("clm", src.sourceId, `${idx}:${statement.slice(0, 40)}`),
        statement,
        claimType,
        sourceIds: [src.sourceId],
        attribution,
        evidenceLevel: evidenceLevelFor(src.quality, claimType, src.provenance),
        provenance: src.provenance,
      };
    });

    const existing = byMerge.get(mergeKey);
    if (existing) {
      if (!existing.sourceIds.includes(src.sourceId)) existing.sourceIds.push(src.sourceId);
      for (const claim of claims) {
        if (!existing.claims.some((c) => c.statement === claim.statement)) {
          existing.claims.push(claim);
        } else {
          const c0 = existing.claims.find((c) => c.statement === claim.statement);
          if (c0 && !c0.sourceIds.includes(src.sourceId)) c0.sourceIds.push(src.sourceId);
        }
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
      claims,
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

  // search_synthesis（feature flag 預設關；autoFallback 時：正文不足／任一 title_only／factcheck → 開啟）
  // 不得升格 article_body；與正文衝突時以 article_body 為準
  const validBodyPageCount = rawSources.filter(
    (s) => s.provenance === "article_body" || s.provenance === "official_document",
  ).length;
  const titleOnlySourceCount = rawSources.filter((s) => s.provenance === "title_only").length;
  const bodyClaimCount = [...byMerge.values()].reduce(
    (acc, ev) =>
      acc +
      ev.claims.filter(
        (c) => c.provenance === "article_body" || c.provenance === "official_document",
      ).length,
    0,
  );
  const synthDecision = shouldEnableSearchSynthesis({
    autoFallback: opts?.autoSynthesisFallback,
    validBodyPageCount,
    bodyClaimCount,
    titleOnlySourceCount,
    intent: plan.intent,
  });
  const supports = synthDecision.enabled ? (hit.rawGroundingSupports ?? []) : [];
  if (hit.rawGroundingSupports?.length && !synthDecision.enabled) {
    limitations.push("search_synthesis_disabled_by_flag: raw supports present but not injected");
  }
  if (synthDecision.enabled && synthDecision.reason === "auto_fallback") {
    limitations.push(
      `search_synthesis_auto_fallback_enabled: valid_body_pages=${validBodyPageCount},body_claims=${bodyClaimCount},title_only=${titleOnlySourceCount},intent=${plan.intent}`,
    );
  }
  let addedSynthCount = 0;
  if (supports.length) {
    limitations.push(
      "search_synthesis_from_grounding_supports: 搜尋摘要，未經原文核對；不得當成 article_body",
    );
    let synIdx = 0;
    for (const raw of supports) {
      if (synIdx >= 6) break;
      const seg = groundingSupportSegmentText(raw);
      if (!seg || seg.length < 40) continue;
      const conflict = findArticleBodyConflict(seg, byMerge);
      if (conflict) {
        limitations.push(
          `synthesis_conflict_article_body_wins:${conflict.eventId}`,
        );
        // 標記在正文事件上，不另建 synthesis 事件
        if (!conflict.claims.some((c) => c.provenance === "search_synthesis")) {
          conflict.claims.push({
            claimId: stableId("clm", conflict.eventId, "synth_conflict"),
            statement: sanitizeEvidenceText(
              `【衝突｜以正文為準｜搜尋摘要未採用】${seg.slice(0, 160)}`,
              200,
            ),
            claimType: "unconfirmed",
            sourceIds: conflict.sourceIds.slice(0, 1),
            evidenceLevel: "insufficient",
            provenance: "search_synthesis",
          });
        }
        synIdx += 1;
        continue;
      }
      const statement = sanitizeEvidenceText(
        `【搜尋摘要，未經原文核對】${seg}`,
        800,
      );
      const topic = guessTopic(statement);
      const mergeKey = `synth:${stableId("syn", statement.slice(0, 48))}`;
      if (byMerge.has(mergeKey)) continue;
      const srcId = rawSources[synIdx % Math.max(rawSources.length, 1)]?.sourceId;
      const claim: ResearchClaim = {
        claimId: stableId("clm", mergeKey),
        statement,
        claimType: inferClaimType(statement, "search_synthesis"),
        sourceIds: srcId ? [srcId] : [],
        evidenceLevel: "insufficient",
        provenance: "search_synthesis",
      };
      byMerge.set(mergeKey, {
        eventId: stableId("evt", mergeKey),
        title: sanitizeEvidenceText(seg, 120),
        topic,
        claims: [claim],
        sourceIds: srcId ? [srcId] : [],
        relevance: 0.45,
        freshness: 0.5,
        diversityKey: topic,
        evidenceGrade: "title_only",
      });
      synIdx += 1;
      addedSynthCount += 1;
    }
  }

  // 雙重保底：auto_fallback 時，無論 bodyClaimCount／已注入 supports 數量，只要 brief 可用就掛入層 1 摘要
  // （解決「配角正文夠 2 篇、主角 title_only 仍瞎掉」：層 1 Google 事實一律補足）
  // 此路徑不再用 findArticleBodyConflict 擋 brief：停用詞易誤判，且 brief 本即標 search_synthesis 供模型區分
  if (
    synthDecision.enabled &&
    synthDecision.reason === "auto_fallback" &&
    briefSafe.length >= 40 &&
    !/^NO_SEARCH\b/i.test(briefSafe)
  ) {
    // 切成最多 3 段（每段連同標記 <= 490 字），避免進 inject 時被單條 500 字上限截斷後半部深度事實
    const briefChunks = splitLongBodyExcerpt(briefSafe, {
      threshold: 450,
      chunkSize: 450,
      maxParts: 3,
      hardCap: 1350,
    });
    const primarySrcId =
      rawSources.find((s) => s.provenance === "title_only")?.sourceId ?? rawSources[0]?.sourceId;
    const briefMergeKey = `synth:${stableId("syn_brief", briefSafe.slice(0, 64))}`;
    if (!byMerge.has(briefMergeKey) && briefChunks.length > 0) {
      const topic = guessTopic(briefSafe);
      const briefTitleLine =
        briefSafe
          .split(/\n+/)
          .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
          .find((l) => l.length >= 8) ?? plan.rawUserQuery;
      const briefClaims: ResearchClaim[] = briefChunks.map((chunk, idx) => {
        const stmt = sanitizeEvidenceText(`【搜尋摘要，未經原文核對】${chunk}`, 495);
        return {
          claimId: stableId("clm", briefMergeKey, String(idx)),
          statement: stmt,
          claimType: inferClaimType(stmt, "search_synthesis"),
          sourceIds: primarySrcId ? [primarySrcId] : [],
          evidenceLevel: "insufficient",
          provenance: "search_synthesis",
        };
      });
      byMerge.set(briefMergeKey, {
        eventId: stableId("evt", briefMergeKey),
        title: sanitizeEvidenceText(briefTitleLine, 120),
        topic,
        claims: briefClaims,
        sourceIds: primarySrcId ? [primarySrcId] : [],
        relevance: 0.55,
        freshness: 0.55,
        diversityKey: topic,
        evidenceGrade: "title_only",
      });
      limitations.push(
        `search_synthesis_from_flash_brief_fallback: auto_fallback 層1摘要保底（parts=${briefClaims.length},title_only=${titleOnlySourceCount},body_claims=${bodyClaimCount},supports=${addedSynthCount}）`,
      );
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
