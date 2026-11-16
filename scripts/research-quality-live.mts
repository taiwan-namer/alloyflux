/**
 * 新聞品質 Live：6 題 × 共用 injection 快照 × Astra/Claude/Argon
 * Flash ≤6、完整回答 ≤18。RESEARCH_LIVE_E2E=1 才跑。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/live-e2e");

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
process.env.RESEARCH_LIVE_E2E = process.env.RESEARCH_LIVE_E2E || "1";
process.env.SUPPLIER_NODE_MODE = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SUPABASE_DB_URL;
const HTML_ROOT = path.join(OUT, "html-snapshots");
mkdirSync(HTML_ROOT, { recursive: true });
process.env.RESEARCH_HTML_SNAPSHOT_DIR = HTML_ROOT;

const QUESTIONS = [
  "川普最新消息有哪些？請附來源與日期。",
  "明天股市預測重點是什麼？請標註不確定性。",
  "NVIDIA 過去 7 天新聞重點，附日期與網址。",
  "台灣最近科技新聞有哪些？",
  "今天台積電有什麼消息？",
  "英國政局或大選最新進展？",
];

type Slot = "astra" | "claude" | "argon";

async function main() {
  if (process.env.RESEARCH_LIVE_E2E !== "1") {
    console.error("STOP: RESEARCH_LIVE_E2E!=1");
    process.exit(2);
  }
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
    runResearchPipelineV2,
    withPlatformResearchScope,
    reusePreparedResearch,
    attachResearchToDone,
    createLiveBudget,
    recordLiveUsage,
    PHASE4_PRODUCT_MODELS,
    estimateTokensApprox,
  } = await import("../lib/research-v2");
  type Candidate = import("../lib/sources").Candidate;
  type Source = import("../lib/sources").Source;
  type OAuthCredentials = import("../lib/oauth").OAuthCredentials;

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
      console.log(`cred_ok provider=${r.provider} id=${r.id.slice(0, 8)}…`);
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
      label: `quality-live-${row.provider}`,
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

  const budgetCfg = {
    maxFullAnswersPerMode: 18,
    maxSearchCallsPerMode: 12,
    maxFlashCallsPerMode: 6,
    maxExtraModelCallsPerMode: 24,
    maxEstimatedTokensPerMode: 500_000,
  };
  const budget = createLiveBudget("A_product_path");
  mkdirSync(OUT, { recursive: true });

  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    questions: QUESTIONS,
    research: [] as unknown[],
    answers: [] as unknown[],
    stoppedReason: null as string | null,
  };

  for (let qi = 0; qi < QUESTIONS.length; qi++) {
    const text = QUESTIONS[qi];
    if (!recordLiveUsage(budget, { flashCalls: 1, searchCalls: 1 }, budgetCfg)) {
      report.stoppedReason = budget.stoppedReason ?? "flash_cap";
      break;
    }

    console.log(`\n=== Q${qi + 1} research ===`);
    const qHtmlDir = path.join(HTML_ROOT, `q${qi}`);
    mkdirSync(qHtmlDir, { recursive: true });
    process.env.RESEARCH_HTML_SNAPSHOT_DIR = qHtmlDir;
    const messages: ChatMessage[] = [{ role: "user", content: text }];
    const t0 = Date.now();
    const verdict = await runResearchPipelineV2({
      messages,
      supplyPath: "local",
      prefer: { sourceId: gemini.id, creds: gemini.creds },
      requestId: `quality-live-q${qi}-${Date.now()}`,
    });
    const researchMs = Date.now() - t0;
    const injFp = createHash("sha256").update(verdict.injectionText).digest("hex").slice(0, 16);
    const corpus = verdict.corpus;
    const sources = corpus?.sources ?? [];
    const researchRow = {
      qi,
      text,
      gate: verdict.status,
      completionStatus: verdict.completionStatus,
      researchMs,
      injectionText: verdict.injectionText,
      injectionChars: verdict.injectionText.length,
      injectionTokensEst: estimateTokensApprox(verdict.injectionText),
      injectionFingerprint: injFp,
      sourceCount: sources.length,
      articleBodyCount: sources.filter((s) => s.provenance === "article_body" || s.provenance === "official_document").length,
      publishedAtCount: sources.filter((s) => Boolean(s.publishedAt)).length,
      searchSynthesisClaimCount: corpus?.events.flatMap((e) => e.claims).filter((c) => c.provenance === "search_synthesis").length ?? 0,
      titleOnlyCount: sources.filter((s) => s.provenance === "title_only").length,
      dedup: {
        rawSourceCount: corpus?.stats.rawSourceCount ?? 0,
        dedupedSourceCount: corpus?.stats.dedupedSourceCount ?? 0,
        rawEventCount: corpus?.stats.rawEventCount ?? 0,
        dedupedEventCount: corpus?.stats.dedupedEventCount ?? 0,
      },
      corpusSources: sources.map((s) => ({
        sourceId: s.sourceId,
        title: s.title,
        url: s.uri,
        originalUrl: s.originalUrl,
        resolvedUrl: s.resolvedUrl,
        provenance: s.provenance,
        publishedAt: s.publishedAt ?? null,
        fetchStatus: s.fetchStatus,
        htmlPath: s.htmlPath ? `q${qi}/${s.htmlPath}` : null,
        htmlSha256: s.htmlSha256 ?? null,
        host: s.host,
      })),
      warnings: verdict.warnings.slice(0, 12),
      limitations: corpus?.limitations?.slice(0, 12) ?? [],
      htmlSnapshotDir: `html-snapshots/q${qi}`,
    };
    (report.research as unknown[]).push(researchRow);
    // 完整研究快照另存，避免主報告過大時仍可讀
    writeFileSync(
      path.join(OUT, `research-q${qi}.json`),
      JSON.stringify(researchRow, null, 2),
      "utf8",
    );
    console.log(
      JSON.stringify({
        qi,
        gate: verdict.status,
        injectionChars: researchRow.injectionChars,
        articleBodyCount: researchRow.articleBodyCount,
        publishedAtCount: researchRow.publishedAtCount,
        searchSynthesisClaimCount: researchRow.searchSynthesisClaimCount,
        dedup: researchRow.dedup,
      }),
    );

    for (const slot of ["astra", "claude", "argon"] as Slot[]) {
      if (!recordLiveUsage(budget, { fullAnswers: 1 }, budgetCfg)) {
        report.stoppedReason = budget.stoppedReason ?? "answer_cap";
        break;
      }
      const modelId = PHASE4_PRODUCT_MODELS[slot];
      const model = findModel(modelId);
      if (!model) {
        (report.answers as unknown[]).push({ qi, slot, error: "model_not_found" });
        continue;
      }
      const candidate = slot === "astra" ? makeCandidate(openai) : makeCandidate(gemini);

      let content = "";
      let completionStatus = "unknown";
      let groundingSources: { title: string; uri: string }[] = [];
      let error: string | null = null;
      const a0 = Date.now();

      async function* body() {
        const r = reusePreparedResearch();
        for await (const ev of streamFrom(
          candidate,
          model!,
          messages,
          "quality-live-safety",
          AbortSignal.timeout(180_000),
          undefined,
          undefined,
        )) {
          if (ev.type === "text") content += ev.text;
          else if (ev.type === "usage") {
            groundingSources = (ev.usage.groundingSources ?? []) as {
              title: string;
              uri: string;
            }[];
            const done = attachResearchToDone(
              { type: "done" as const, groundingSources },
              r,
            ) as {
              completionStatus?: string;
              groundingSources?: { title: string; uri: string }[];
            };
            completionStatus = done.completionStatus || completionStatus;
            if (done.groundingSources) groundingSources = done.groundingSources;
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

      const hedgeHits = (content.match(/只有標題|無法確認|細節請|部分完成|不代表完整|不足以|查不到|請點來源/g) || []).length;
      const row = {
        qi,
        slot,
        modelId,
        ms: Date.now() - a0,
        completionStatus,
        contentChars: content.length,
        content,
        contentPreview: content.slice(0, 360),
        groundingCount: groundingSources.length,
        gate: verdict.status,
        injectionFingerprint: injFp,
        hedgeHits,
        uiLabel:
          completionStatus === "complete"
            ? "已上網查證"
            : completionStatus === "truncated"
              ? "部分查證"
              : completionStatus === "failed"
                ? "查證未完成"
                : completionStatus,
        error,
      };
      (report.answers as unknown[]).push(row);
      writeFileSync(
        path.join(OUT, `answer-q${qi}-${slot}.json`),
        JSON.stringify(row, null, 2),
        "utf8",
      );
      console.log(`Q${qi + 1} ${slot}: ${completionStatus} chars=${content.length} hedge=${hedgeHits} err=${error ?? "-"}`);
    }
    if (report.stoppedReason) break;
  }

  report.finishedAt = new Date().toISOString();
  report.budget = budget;
  report.persistence = {
    injectionText: true,
    corpusSources: true,
    htmlSnapshots: true,
    dedupCounts: true,
    fullAnswers: true,
  };
  const outFile = path.join(OUT, "quality-live-report-v2.json");
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWrote ${outFile}; answers=${(report.answers as unknown[]).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
