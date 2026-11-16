/**
 * 凍結 injection A/B：with_synth / without_synth × Astra／Claude × 6 題 = 24 回答
 * Flash = 0。不部署。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// 本腳本不打 Flash；synthesis flag 不影響凍結 injection
delete process.env.RESEARCH_SEARCH_SYNTHESIS;

const ENTITY_RE =
  /川普|特朗普|習近平|普丁|黃仁勳|Jensen|Kress|台積電|TSMC|NVIDIA|輝達|Fed|聯準會|Burnham|Trump|OpenAI|Anthropic|卓榮泰|美光|Micron|NSTC|工研院|Ground\s*Stop|APEC|加薩|Gaza|\d{4}[-/年]\d{1,2}|\d+\s*%|\d+\s*億|\$\s*\d+/gi;
const HEDGE_RE =
  /只有標題|無法確認|細節請|部分完成|不代表完整|不足以|查不到|請點來源|title_only|搜尋摘要|未經原文核對/gi;
const UNVERIFIED_MARK_RE = /未經原文核對|搜尋摘要|未核對|無法確認來自原文/g;

type Variant = "with_synth" | "without_synth";
type Slot = "astra" | "claude";

function stripSynthFromInjection(inj: string): string {
  const lines = inj.split(/\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 跳過純 synthesis 主張行
    if (/載體：search_synthesis|【搜尋摘要，未經原文核對】|衝突｜以正文為準/.test(line)) {
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  // 清掉沒有主張的空事件塊（### 標題後直接下一個 ### 或 ##）
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
    .filter((l) => l.includes(`載體：${carrier}`) || (carrier === "search_synthesis" && /搜尋摘要，未經原文核對/.test(l)))
    .join("\n");
}

function entitySet(text: string): Set<string> {
  return new Set((text.match(ENTITY_RE) || []).map((x) => x.toLowerCase()));
}

function analyzeAnswer(opts: {
  content: string;
  inj: string;
}): {
  entityCount: number;
  entityMatchBodyRate: number | null;
  entityMatchSynthOnlyRate: number | null;
  synthFactsMarkedUnverified: boolean | null;
  hedgeTitleOnlyCount: number;
  entities: string[];
  matchedBody: string[];
  matchedSynthOnly: string[];
} {
  const bodyBlob = extractCarrierBlob(opts.inj, "article_body");
  const synthBlob = extractCarrierBlob(opts.inj, "search_synthesis");
  const bodyEnts = entitySet(bodyBlob);
  const synthEnts = entitySet(synthBlob);
  const answerEnts = [...entitySet(opts.content)];
  const matchedBody = answerEnts.filter((e) =>
    [...bodyEnts].some((b) => b.includes(e) || e.includes(b)),
  );
  const matchedSynthOnly = answerEnts.filter((e) => {
    const inSynth = [...synthEnts].some((s) => s.includes(e) || e.includes(s));
    const inBody = [...bodyEnts].some((b) => b.includes(e) || e.includes(b));
    return inSynth && !inBody;
  });
  const hedges = opts.content.match(/只有標題|無法確認|細節請|部分完成|不代表完整|不足以|查不到|請點來源/g) || [];
  const hasSynthOnlyFacts = matchedSynthOnly.length > 0;
  const marked = UNVERIFIED_MARK_RE.test(opts.content);
  return {
    entityCount: answerEnts.length,
    entityMatchBodyRate: answerEnts.length
      ? +(matchedBody.length / answerEnts.length).toFixed(4)
      : null,
    entityMatchSynthOnlyRate: answerEnts.length
      ? +(matchedSynthOnly.length / answerEnts.length).toFixed(4)
      : null,
    synthFactsMarkedUnverified: hasSynthOnlyFacts ? marked : null,
    hedgeTitleOnlyCount: hedges.length,
    entities: answerEnts,
    matchedBody,
    matchedSynthOnly,
  };
}

async function main() {
  const dbPath = path.join(ROOT, "data", "app.db");
  if (!existsSync(dbPath)) {
    console.error("STOP: no data/app.db");
    process.exit(2);
  }
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
    console.error("STOP: APP_SECRET");
    process.exit(2);
  }

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
  type Candidate = import("../lib/sources").Candidate;
  type Source = import("../lib/sources").Source;
  type OAuthCredentials = import("../lib/oauth").OAuthCredentials;
  type ResearchVerdict = import("../lib/research-v2").ResearchVerdict;

  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT id, label, provider, auth_type, encrypted_key, enabled FROM sources WHERE enabled = 1 AND auth_type = 'oauth_sub'",
    )
    .all() as {
    id: string;
    label: string;
    provider: string;
    auth_type: string;
    encrypted_key: string;
    enabled: number;
  }[];

  type CredRow = { id: string; provider: "gemini" | "openai"; creds: OAuthCredentials; emailHint: string };
  const credsByProvider = new Map<string, CredRow>();
  for (const r of rows) {
    try {
      const creds = JSON.parse(decrypt(r.encrypted_key)) as OAuthCredentials;
      if (!creds.accessToken && !creds.refreshToken) continue;
      const emailHint = creds.email ? `${creds.email.split("@")[0]}@…` : "(no-email)";
      credsByProvider.set(r.provider, {
        id: r.id,
        provider: r.provider as "gemini" | "openai",
        creds,
        emailHint,
      });
    } catch {
      /* skip */
    }
  }
  const gemini = credsByProvider.get("gemini");
  const openai = credsByProvider.get("openai");
  if (!gemini || !openai) {
    console.error("STOP: need gemini+openai oauth");
    process.exit(2);
  }

  function makeSource(row: CredRow): Source {
    return {
      id: row.id,
      label: `synth-ab-${row.provider}`,
      kind: "supplier",
      provider: row.provider,
      authType: "oauth_sub",
      keyHint: row.emailHint,
      priority: 1,
      monthlyCapPoints: null,
      shareLimitPct: 100,
      quota: null,
      quotaUpdatedAt: null,
      enabled: true,
      fromEnv: false,
      ownerUserId: null,
    };
  }
  function makeCandidate(row: CredRow): Candidate {
    return { source: makeSource(row), oauthCreds: row.creds };
  }

  mkdirSync(AB_DIR, { recursive: true });

  const report: {
    startedAt: string;
    finishedAt?: string;
    flashCalls: number;
    answerBudget: number;
    answersRun: number;
    rows: unknown[];
    table: unknown[];
    stoppedReason: string | null;
  } = {
    startedAt: new Date().toISOString(),
    flashCalls: 0,
    answerBudget: 24,
    answersRun: 0,
    rows: [],
    table: [],
    stoppedReason: null,
  };

  for (let qi = 0; qi < 6; qi++) {
    const researchPath = path.join(OUT, `research-q${qi}.json`);
    if (!existsSync(researchPath)) {
      console.error(`missing ${researchPath}`);
      process.exit(2);
    }
    const research = JSON.parse(readFileSync(researchPath, "utf8")) as {
      qi: number;
      text: string;
      gate: string;
      completionStatus: string;
      injectionText: string;
      articleBodyCount: number;
      searchSynthesisClaimCount: number;
      corpusSources: unknown[];
      warnings?: string[];
    };

    const withInj = research.injectionText;
    const withoutInj = stripSynthFromInjection(withInj);
    writeFileSync(path.join(AB_DIR, `injection-q${qi}-with_synth.txt`), withInj, "utf8");
    writeFileSync(path.join(AB_DIR, `injection-q${qi}-without_synth.txt`), withoutInj, "utf8");

    const variants: { variant: Variant; injectionText: string }[] = [
      { variant: "with_synth", injectionText: withInj },
      { variant: "without_synth", injectionText: withoutInj },
    ];

    for (const { variant, injectionText } of variants) {
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

      for (const slot of ["astra", "claude"] as Slot[]) {
        if (report.answersRun >= 24) {
          report.stoppedReason = "answer_cap_24";
          break;
        }
        const modelId = PHASE4_PRODUCT_MODELS[slot];
        const model = findModel(modelId);
        if (!model) {
          report.rows.push({ qi, variant, slot, error: "model_not_found" });
          continue;
        }
        const candidate = slot === "astra" ? makeCandidate(openai) : makeCandidate(gemini);
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
            "synth-ab-safety",
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

        report.answersRun += 1;
        const metrics = analyzeAnswer({ content, inj: injectionText });
        const row = {
          qi,
          text: research.text,
          variant,
          slot,
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
        report.rows.push(row);
        report.table.push({
          qi,
          variant,
          slot,
          entityCount: metrics.entityCount,
          entityMatchBodyRate: metrics.entityMatchBodyRate,
          entityMatchSynthOnlyRate: metrics.entityMatchSynthOnlyRate,
          synthFactsMarkedUnverified: metrics.synthFactsMarkedUnverified,
          hedgeTitleOnlyCount: metrics.hedgeTitleOnlyCount,
          matchedSynthOnly: metrics.matchedSynthOnly,
          error,
        });
        writeFileSync(
          path.join(AB_DIR, `answer-q${qi}-${variant}-${slot}.json`),
          JSON.stringify(row, null, 2),
          "utf8",
        );
        console.log(
          `Q${qi} ${variant} ${slot}: ents=${metrics.entityCount} bodyMatch=${metrics.entityMatchBodyRate} synthOnly=${metrics.entityMatchSynthOnlyRate} hedge=${metrics.hedgeTitleOnlyCount} err=${error ?? "-"}`,
        );
      }
      if (report.stoppedReason) break;
    }
    if (report.stoppedReason) break;
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(AB_DIR, "synth-ab-report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(AB_DIR, "synth-ab-table.json"), JSON.stringify(report.table, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        answersRun: report.answersRun,
        flashCalls: report.flashCalls,
        tableRows: report.table.length,
        out: AB_DIR,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
