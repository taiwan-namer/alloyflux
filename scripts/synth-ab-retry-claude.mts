/**
 * 重試 synth A/B 中失敗的 Claude 回答（不打 Flash）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/live-e2e");
const AB_DIR = path.join(OUT, "synth-ab");

function loadEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();
process.env.SUPPLIER_NODE_MODE = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SUPABASE_DB_URL;

const ENTITY_RE =
  /川普|特朗普|習近平|普丁|黃仁勳|Jensen|Kress|台積電|TSMC|NVIDIA|輝達|Fed|聯準會|Burnham|Trump|OpenAI|Anthropic|卓榮泰|美光|Micron|NSTC|工研院|Ground\s*Stop|APEC|加薩|Gaza|\d{4}[-/年]\d{1,2}|\d+\s*%|\d+\s*億|\$\s*\d+/gi;
const UNVERIFIED_MARK_RE = /未經原文核對|搜尋摘要|未核對|無法確認來自原文/g;

function stripSynthFromInjection(inj: string): string {
  const lines = inj.split(/\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/載體：search_synthesis|【搜尋摘要，未經原文核對】|衝突｜以正文為準/.test(line)) continue;
    out.push(line);
  }
  const cleaned: string[] = [];
  for (let j = 0; j < out.length; j++) {
    if (out[j].startsWith("### ")) {
      let k = j + 1;
      let hasClaim = false;
      while (k < out.length && !out[k].startsWith("### ") && !out[k].startsWith("## ")) {
        if (/^-\s*（/.test(out[k])) hasClaim = true;
        k += 1;
      }
      if (!hasClaim) {
        j = k - 1;
        continue;
      }
    }
    cleaned.push(out[j]);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n");
}

function extractCarrierBlob(inj: string, carrier: "article_body" | "search_synthesis"): string {
  return inj
    .split(/\n/)
    .filter(
      (l) =>
        l.includes(`載體：${carrier}`) ||
        (carrier === "search_synthesis" && /搜尋摘要，未經原文核對/.test(l)),
    )
    .join("\n");
}

function entitySet(text: string): Set<string> {
  return new Set((text.match(ENTITY_RE) || []).map((x) => x.toLowerCase()));
}

function analyzeAnswer(content: string, inj: string) {
  const bodyEnts = entitySet(extractCarrierBlob(inj, "article_body"));
  const synthEnts = entitySet(extractCarrierBlob(inj, "search_synthesis"));
  const answerEnts = [...entitySet(content)];
  const matchedBody = answerEnts.filter((e) =>
    [...bodyEnts].some((b) => b.includes(e) || e.includes(b)),
  );
  const matchedSynthOnly = answerEnts.filter((e) => {
    const inSynth = [...synthEnts].some((s) => s.includes(e) || e.includes(s));
    const inBody = [...bodyEnts].some((b) => b.includes(e) || e.includes(b));
    return inSynth && !inBody;
  });
  const hedges =
    content.match(/只有標題|無法確認|細節請|部分完成|不代表完整|不足以|查不到|請點來源/g) || [];
  const hasSynthOnlyFacts = matchedSynthOnly.length > 0;
  return {
    entityCount: answerEnts.length,
    entityMatchBodyRate: answerEnts.length
      ? +(matchedBody.length / answerEnts.length).toFixed(4)
      : null,
    entityMatchSynthOnlyRate: answerEnts.length
      ? +(matchedSynthOnly.length / answerEnts.length).toFixed(4)
      : null,
    synthFactsMarkedUnverified: hasSynthOnlyFacts ? UNVERIFIED_MARK_RE.test(content) : null,
    hedgeTitleOnlyCount: hedges.length,
    entities: answerEnts,
    matchedBody,
    matchedSynthOnly,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { DatabaseSync } = await import("node:sqlite");
  const { decrypt } = await import("../lib/crypto");
  const { findModel } = await import("../lib/models");
  const { streamFrom } = await import("../lib/providers");
  type ChatMessage = import("../lib/providers").ChatMessage;
  const {
    withPlatformResearchScope,
    reusePreparedResearch,
    attachResearchToDone,
    PHASE4_PRODUCT_MODELS,
    planResearch,
  } = await import("../lib/research-v2");
  type OAuthCredentials = import("../lib/oauth").OAuthCredentials;
  type ResearchVerdict = import("../lib/research-v2").ResearchVerdict;

  const db = new DatabaseSync(path.join(ROOT, "data", "app.db"));
  const rows = db
    .prepare(
      "SELECT id, label, provider, auth_type, encrypted_key, enabled FROM sources WHERE enabled = 1 AND auth_type = 'oauth_sub'",
    )
    .all() as {
    id: string;
    provider: string;
    encrypted_key: string;
  }[];

  let gemini: { id: string; creds: OAuthCredentials; emailHint: string } | null = null;
  for (const r of rows) {
    try {
      const creds = JSON.parse(decrypt(r.encrypted_key)) as OAuthCredentials;
      if (!creds.accessToken && !creds.refreshToken) continue;
      if (r.provider === "gemini") {
        gemini = {
          id: r.id,
          creds,
          emailHint: creds.email ? `${creds.email.split("@")[0]}@…` : "(no-email)",
        };
      }
    } catch {
      /* skip */
    }
  }
  if (!gemini) {
    console.error("STOP: no gemini oauth");
    process.exit(2);
  }

  // Opus medium 速率鎖定時，改走同帳 Claude Sonnet medium（報告標明非產品 Claude）
  const preferred = PHASE4_PRODUCT_MODELS.claude;
  const fallback = "agy-claude-sonnet-5-5-medium";
  let modelId = preferred;
  let model = findModel(modelId);
  if (!model) {
    console.error("STOP: model not found", modelId);
    process.exit(2);
  }
  const forceSonnet = process.env.SYNTH_AB_CLAUDE_SONNET === "1";
  if (forceSonnet) {
    modelId = fallback;
    model = findModel(modelId);
    if (!model) {
      console.error("STOP: sonnet fallback not found");
      process.exit(2);
    }
    console.log(`using_claude_fallback modelId=${modelId} (opus rate-limited)`);
  }
  const candidate = {
    source: {
      id: gemini.id,
      label: "synth-ab-retry-claude",
      kind: "supplier" as const,
      provider: "gemini" as const,
      authType: "oauth_sub" as const,
      keyHint: gemini.emailHint,
      priority: 1,
      monthlyCapPoints: null,
      shareLimitPct: 100,
      quota: null,
      quotaUpdatedAt: null,
      enabled: true,
      fromEnv: false,
      ownerUserId: null,
    },
    oauthCreds: gemini.creds,
  };

  const report = JSON.parse(readFileSync(path.join(AB_DIR, "synth-ab-report.json"), "utf8")) as {
    rows: Array<Record<string, unknown>>;
    table: Array<Record<string, unknown>>;
    finishedAt?: string;
    claudeRetries?: number;
  };

  let retries = 0;
  let ok = 0;
  let fail = 0;

  for (let qi = 0; qi < 6; qi++) {
    const research = JSON.parse(readFileSync(path.join(OUT, `research-q${qi}.json`), "utf8")) as {
      text: string;
      gate: string;
      completionStatus: string;
      injectionText: string;
      searchSynthesisClaimCount: number;
      warnings?: string[];
    };
    for (const variant of ["with_synth", "without_synth"] as const) {
      const existing = report.rows.find(
        (r) => r.qi === qi && r.variant === variant && r.slot === "claude",
      );
      if (existing && Number(existing.contentChars || 0) > 0 && !existing.error) {
        ok += 1;
        continue;
      }

      const injectionText =
        variant === "with_synth"
          ? research.injectionText
          : stripSynthFromInjection(research.injectionText);
      const plan = planResearch({
        text: research.text,
        now: new Date("2026-11-16T00:00:00.000Z"),
        timeZone: "Asia/Taipei",
      });
      const injFp = createHash("sha256").update(injectionText).digest("hex").slice(0, 16);
      const verdict: ResearchVerdict = {
        status: research.gate as ResearchVerdict["status"],
        plan,
        corpus: null,
        injectionText,
        sources: [],
        webSearchQueries: [],
        warnings: research.warnings ?? [],
        showVerifiedBadge: research.gate === "ok",
        forbidStaleNewsVoice: true,
        completionStatus: research.completionStatus as ResearchVerdict["completionStatus"],
        researchCost: {
          estimatedInjectionTokens: Math.ceil(injectionText.length / 3.5),
          flashCalls: 0,
          pageFetchAttempts: 0,
          unavailableActualUsage: true,
        },
      };

      const messages: ChatMessage[] = [{ role: "user", content: research.text }];
      let content = "";
      let completionStatus = "unknown";
      let error: string | null = null;
      const a0 = Date.now();

      async function* body() {
        const r = reusePreparedResearch();
        for await (const ev of streamFrom(
          candidate,
          model!,
          messages,
          "synth-ab-retry",
          AbortSignal.timeout(180_000),
          undefined,
          undefined,
        )) {
          if (ev.type === "text") content += ev.text;
          else if (ev.type === "usage") {
            const done = attachResearchToDone(
              { type: "done" as const, groundingSources: ev.usage.groundingSources ?? [] },
              r,
            ) as { completionStatus?: string };
            completionStatus = done.completionStatus || completionStatus;
          }
        }
      }

      try {
        for await (const _ of withPlatformResearchScope(verdict, "local", body())) {
          /* drain */
        }
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400);
      }

      retries += 1;
      const metrics = analyzeAnswer(content, injectionText);
      const row = {
        qi,
        text: research.text,
        variant,
        slot: "claude",
        modelId,
        ms: Date.now() - a0,
        completionStatus,
        injectionFingerprint: injFp,
        injectionChars: injectionText.length,
        frozenGate: research.gate,
        frozenSynthClaims: research.searchSynthesisClaimCount,
        contentChars: content.length,
        content,
        error,
        ...metrics,
      };

      report.rows = report.rows.filter(
        (r) => !(r.qi === qi && r.variant === variant && r.slot === "claude"),
      );
      report.rows.push(row);
      report.table = report.table.filter(
        (r) => !(r.qi === qi && r.variant === variant && r.slot === "claude"),
      );
      report.table.push({
        qi,
        variant,
        slot: "claude",
        entityCount: metrics.entityCount,
        entityMatchBodyRate: metrics.entityMatchBodyRate,
        entityMatchSynthOnlyRate: metrics.entityMatchSynthOnlyRate,
        synthFactsMarkedUnverified: metrics.synthFactsMarkedUnverified,
        hedgeTitleOnlyCount: metrics.hedgeTitleOnlyCount,
        matchedSynthOnly: metrics.matchedSynthOnly,
        error,
      });
      writeFileSync(
        path.join(AB_DIR, `answer-q${qi}-${variant}-claude.json`),
        JSON.stringify(row, null, 2),
        "utf8",
      );
      if (error || content.length === 0) fail += 1;
      else ok += 1;
      console.log(
        `RETRY Q${qi} ${variant} claude: ents=${metrics.entityCount} bodyMatch=${metrics.entityMatchBodyRate} err=${error ?? "-"}`,
      );
      await sleep(12_000);
    }
  }

  report.claudeRetries = retries;
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(AB_DIR, "synth-ab-report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(AB_DIR, "synth-ab-table.json"), JSON.stringify(report.table, null, 2), "utf8");
  console.log(JSON.stringify({ retries, ok, fail }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
