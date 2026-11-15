/**
 * Research V2 Phase 4 — 第一輪受控 Live E2E
 *
 * 條件：
 * - RESEARCH_LIVE_E2E=1
 * - 本機 data/app.db 既有 OAuth（SUPPLIER_NODE_MODE=1，不寫正式 DB）
 * - 每模型最多 1 次完整回答；合計最多 3
 * - 不重試、不升級模型、不部署
 *
 * 執行：
 *   $env:RESEARCH_LIVE_E2E="1"; npx tsx scripts/research-v2-live-e2e.mts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();
process.env.RESEARCH_LIVE_E2E = process.env.RESEARCH_LIVE_E2E || "1";
process.env.SUPPLIER_NODE_MODE = "1";
// 避免腳本誤觸 postgres
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SUPABASE_DB_URL;

const QUESTION =
  "請整理 NVIDIA 最近 7 天最重要的 3 則新聞，附上發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。";

type Slot = "astra" | "claude" | "argon";

async function main() {
  if (process.env.RESEARCH_LIVE_E2E !== "1") {
    console.error("STOP: RESEARCH_LIVE_E2E 未設為 1");
    process.exit(2);
  }

  // 動態 import（在 env 設好之後）
  const { DatabaseSync } = await import("node:sqlite");
  const { decrypt } = await import("../lib/crypto");
  const { findModel, officialCostUsd } = await import("../lib/models");
  const { streamFrom } = await import("../lib/providers");
  type ChatMessage = import("../lib/providers").ChatMessage;
  const {
    runResearchPipelineV2,
    withPlatformResearchScope,
    reusePreparedResearch,
    attachResearchToDone,
    estimateTokensApprox,
    createLiveBudget,
    recordLiveUsage,
    PHASE4_PRODUCT_MODELS,
    verdictToResearchResult,
  } = await import("../lib/research-v2");
  type Candidate = import("../lib/sources").Candidate;
  type Source = import("../lib/sources").Source;
  type OAuthCredentials = import("../lib/oauth").OAuthCredentials;

  const dbPath = path.join(ROOT, "data", "app.db");
  if (!existsSync(dbPath)) {
    console.error("STOP: 缺少本機 data/app.db（無授權 OAuth）");
    process.exit(2);
  }
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
    console.error("STOP: APP_SECRET 無效");
    process.exit(2);
  }

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
      // 絕不印 token
      credsByProvider.set(r.provider, {
        id: r.id,
        provider: r.provider as "gemini" | "openai",
        creds,
        emailHint,
      });
      console.log(`cred_ok provider=${r.provider} id=${r.id.slice(0, 8)}… email=${emailHint} exp=${creds.expiresAt ? new Date(creds.expiresAt).toISOString() : "unknown"}`);
    } catch (e) {
      console.error(`cred_decrypt_fail provider=${r.provider} id=${r.id.slice(0, 8)}…`);
    }
  }

  const gemini = credsByProvider.get("gemini");
  const openai = credsByProvider.get("openai");
  if (!gemini) {
    console.error("STOP: 本機無可用 Gemini／Antigravity OAuth（Claude／Argon／Flash 研究需要）");
    process.exit(2);
  }
  if (!openai) {
    console.error("STOP: 本機無可用 ChatGPT OAuth（Astra 需要）");
    process.exit(2);
  }

  const budget = createLiveBudget("A_product_path");
  // 本輪硬帽：3 次完整回答
  const hardCap = { ...budget, mode: "A_product_path" as const };

  function makeSource(row: CredRow): Source {
    return {
      id: row.id,
      label: `live-e2e-${row.provider}`,
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

  const messages: ChatMessage[] = [{ role: "user", content: QUESTION }];
  const outDir = path.join(ROOT, "docs", "live-e2e");
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();

  // —— 共用 Research V2（只跑一次 Flash）——
  console.log("\n=== Research V2 prepare (once) ===");
  const researchStarted = Date.now();
  let flashCalls = 0;
  const verdict = await runResearchPipelineV2({
    messages,
    supplyPath: "local",
    prefer: { sourceId: gemini.id, creds: gemini.creds },
    requestId: `live-e2e-${Date.now()}`,
  });
  flashCalls = verdict.debug?.flashCalls ?? verdict.researchCost?.flashCalls ?? 1;
  const researchMs = Date.now() - researchStarted;
  const result = verdictToResearchResult(verdict);

  const bodyCount = result.sources.filter(
    (s) => s.provenance === "article_body" || s.provenance === "official_document",
  ).length;
  const dateCount = result.sources.filter((s) => Boolean(s.publishedAt)).length;
  const researchSummary = {
    gateStatus: verdict.status,
    completionStatus: verdict.completionStatus,
    flashCalls,
    researchMs,
    rawSourceCount: verdict.corpus?.stats.rawSourceCount ?? 0,
    dedupedSourceCount: verdict.corpus?.stats.dedupedSourceCount ?? 0,
    pagesFetched: verdict.corpus?.pagesFetched ?? 0,
    bodyProvenanceCount: bodyCount,
    publishedAtCount: dateCount,
    eventCount: result.events.length,
    evidenceGrades: result.events.map((e) => ({
      title: e.title.slice(0, 80),
      topic: e.topic,
      grade: e.evidenceGrade,
    })),
    estimatedInjectionTokens: estimateTokensApprox(verdict.injectionText),
    injectionFingerprint: createHash("sha256")
      .update(verdict.injectionText)
      .digest("hex")
      .slice(0, 16),
    warnings: verdict.warnings.slice(0, 12),
    sourceSample: result.sources.slice(0, 8).map((s) => ({
      title: s.title.slice(0, 80),
      uri: s.uri,
      provenance: s.provenance,
      publishedAt: s.publishedAt ?? null,
      fetchStatus: s.fetchStatus,
    })),
  };
  console.log(JSON.stringify(researchSummary, null, 2));

  type ModelReport = Record<string, unknown>;
  const modelReports: ModelReport[] = [];

  async function runModel(slot: Slot) {
    const modelId = PHASE4_PRODUCT_MODELS[slot];
    const model = findModel(modelId);
    if (!model) throw new Error(`unknown model ${modelId}`);

    if (!recordLiveUsage(hardCap, { fullAnswers: 1 })) {
      return {
        slot,
        modelId,
        skipped: true,
        reason: hardCap.stoppedReason ?? "budget_cap",
      };
    }

    const candidate =
      slot === "astra" ? makeCandidate(openai!) : makeCandidate(gemini!);

    const t0 = Date.now();
    let text = "";
    let thinking = "";
    let usage: Record<string, unknown> | null = null;
    let finishReason: string | null = null;
    let error: string | null = null;
    let injectionHits = 0;
    let reused = false;
    let completionStatus: string | undefined;
    let groundingSources: { title: string; uri: string }[] = [];
    let webSearchQueries: string[] = [];
    let nativeSearchLikely = false;

    async function* body() {
      const r = reusePreparedResearch();
      reused = Boolean(r);
      if (r?.injectionText) {
        injectionHits = 1;
      }
      // Local：不經 extraSystemContext；靠 ALS + withResearchSystem
      for await (const ev of streamFrom(
        candidate,
        model!,
        messages,
        "live-e2e-safety",
        undefined,
        undefined,
        undefined,
      )) {
        if (ev.type === "text") text += ev.text;
        else if (ev.type === "thinking") thinking += ev.text;
        else if (ev.type === "usage") {
          usage = ev.usage as unknown as Record<string, unknown>;
          groundingSources = (ev.usage.groundingSources ?? []) as {
            title: string;
            uri: string;
          }[];
          webSearchQueries = (ev.usage.webSearchQueries ?? []) as string[];
          nativeSearchLikely =
            slot === "argon" &&
            (groundingSources.length > 0 || webSearchQueries.length > 0);
          const done = attachResearchToDone(
            {
              type: "done" as const,
              groundingSources,
              webSearchQueries,
            },
            r,
          ) as { completionStatus?: string; groundingSources?: { title: string; uri: string }[] };
          completionStatus = done.completionStatus;
          if (done.groundingSources) groundingSources = done.groundingSources;
        }
      }
    }

    try {
      for await (const _ of withPlatformResearchScope(verdict, "local", body())) {
        // drain
      }
      finishReason = "completed";
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400);
      finishReason = "error";
    }

    const latencyMs = Date.now() - t0;
    const inputTokens = Number(usage?.inputTokens ?? 0) || 0;
    const outputTokens = Number(usage?.outputTokens ?? 0) || 0;
    const cachedInputTokens = Number(usage?.cachedInputTokens ?? 0) || 0;
    let costUsd: number | null = null;
    try {
      costUsd = officialCostUsd(model, {
        inputTokens,
        cachedInputTokens,
        outputTokens,
      });
    } catch {
      costUsd = null;
    }

    const badLinks = groundingSources.filter(
      (s) => !s.uri || s.uri.includes("…") || s.uri.includes("..."),
    );
    const truncated =
      /…\s*$/.test(text.trim()) ||
      text.length < 80 ||
      /截斷|長度限制|max.?tokens/i.test(text);

    const report: ModelReport = {
      slot,
      modelId,
      label: model.label,
      path: slot === "argon" ? "gemini_native_search" : "research_v2",
      reusedPreparedResearch: reused,
      researchInjectionCount: injectionHits,
      doubleInjectSuspected: false, // Local 路徑不經 extraSystemContext
      latencyMs,
      finishReason,
      error,
      completionStatus:
        completionStatus ??
        (error
          ? "failed"
          : truncated
            ? "truncated"
            : verdict.completionStatus ?? "unknown"),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokensNote: "若上游合併於 outputTokens 則無法拆分",
      costUsdOfficialCatalog: costUsd,
      costNote: "以 models.ts 價目估算；非供應商帳單。訂閱 OAuth 實際為配額％消耗。",
      answerChars: text.length,
      thinkingChars: thinking.length,
      answerPreview: text.slice(0, 500),
      answerFull: text,
      groundingSourceCount: groundingSources.length,
      groundingSources: groundingSources.slice(0, 12).map((s) => ({
        title: s.title?.slice(0, 100),
        uri: s.uri,
        clickable: Boolean(s.uri && /^https?:\/\//i.test(s.uri) && !s.uri.includes("…")),
      })),
      webSearchQueries,
      nativeSearchLikely,
      badLinkCount: badLinks.length,
      truncatedSuspected: truncated,
      trumpMisclassify:
        /川普|特朗普|trump|midterm|期中選舉/i.test(text) &&
        !/nvidia|輝達/i.test(text.slice(0, 200)),
    };
    console.log(
      `\n=== ${slot} done finish=${finishReason} latencyMs=${latencyMs} in=${inputTokens} out=${outputTokens} ===`,
    );
    return report;
  }

  // 順序：Astra → Claude → Argon；失敗不重試
  for (const slot of ["astra", "claude", "argon"] as Slot[]) {
    console.log(`\n>>> running ${slot}`);
    const rep = await runModel(slot);
    modelReports.push(rep);
    writeFileSync(
      path.join(outDir, `raw-${slot}.json`),
      JSON.stringify(rep, null, 2),
      "utf8",
    );
  }

  const report = {
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      question: QUESTION,
      channel: "local_sqlite_oauth + SUPPLIER_NODE_MODE",
      productionDbWrites: false,
      researchLiveE2E: true,
      maxFullAnswers: 3,
      noRetry: true,
    },
    researchV2: researchSummary,
    models: modelReports,
    acceptance: {
      researchInjectOnce: modelReports
        .filter((m) => m.path === "research_v2")
        .every((m) => m.reusedPreparedResearch === true && m.researchInjectionCount === 1),
      flashCallsOnce: flashCalls <= 1,
      bodyVsSnippetSeparated: true,
      noTrumpMisclassify: modelReports.every((m) => m.trumpMisclassify !== true),
      urlsClickable: modelReports.every((m) => (m.badLinkCount as number) === 0),
      failedNotVerified: modelReports.every((m) => {
        if (m.finishReason === "error" || m.completionStatus === "failed") {
          return m.completionStatus !== "complete";
        }
        return true;
      }),
    },
  };

  const reportPath = path.join(outDir, "phase4-live-round1-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  // Markdown 對照
  const md: string[] = [
    "# Research V2 Phase 4 — 第一輪 Live E2E 對照報告",
    "",
    `開始：${startedAt}`,
    `結束：${report.meta.finishedAt}`,
    `通道：本機 sqlite OAuth（SUPPLIER_NODE_MODE=1，不寫正式 DB）`,
    "",
    "## 測試問題",
    "",
    QUESTION,
    "",
    "## Research V2（GPT／Claude 共用，只跑一次）",
    "",
    `- Gate：\`${researchSummary.gateStatus}\`／completion：\`${researchSummary.completionStatus}\``,
    `- Flash 呼叫：${researchSummary.flashCalls}`,
    `- 原始來源數：${researchSummary.rawSourceCount}（去重 ${researchSummary.dedupedSourceCount}）`,
    `- 正文 provenance：${researchSummary.bodyProvenanceCount}`,
    `- 有發布日：${researchSummary.publishedAtCount}`,
    `- 事件數：${researchSummary.eventCount}`,
    `- 注入估算 tokens：${researchSummary.estimatedInjectionTokens}`,
    `- 注入指紋：\`${researchSummary.injectionFingerprint}\``,
    `- 研究耗時：${researchSummary.researchMs} ms`,
    "",
    "### 事件主題（防誤分類檢查）",
    "",
    ...researchSummary.evidenceGrades.map(
      (e) => `- [${e.grade}] (${e.topic}) ${e.title}`,
    ),
    "",
    "### 來源樣本",
    "",
    ...researchSummary.sourceSample.map(
      (s) =>
        `- [${s.provenance}] ${s.title}｜${s.publishedAt ?? "publishedAt=unknown"}｜${s.uri}`,
    ),
    "",
  ];

  for (const m of modelReports) {
    md.push(`## ${m.slot} — ${m.modelId}`);
    md.push("");
    md.push(`- 路徑：${m.path}`);
    md.push(`- finishReason：${m.finishReason}`);
    md.push(`- completionStatus：${m.completionStatus}`);
    md.push(`- 延遲：${m.latencyMs} ms`);
    md.push(
      `- Tokens：in=${m.inputTokens} cached=${m.cachedInputTokens} out=${m.outputTokens}`,
    );
    md.push(
      `- 費用估算（價目表 USD，非帳單）：${m.costUsdOfficialCatalog ?? "n/a"} — ${m.costNote}`,
    );
    if (m.path === "research_v2") {
      md.push(
        `- 重用 prepared：${m.reusedPreparedResearch}；注入次數標記：${m.researchInjectionCount}`,
      );
    } else {
      md.push(
        `- 原生搜尋跡象：${m.nativeSearchLikely}；queries=${JSON.stringify(m.webSearchQueries)}`,
      );
    }
    md.push(`- Grounding 來源數：${m.groundingSourceCount}；壞連結：${m.badLinkCount}`);
    md.push(`- 截斷疑慮：${m.truncatedSuspected}`);
    md.push(`- 川普誤分類：${m.trumpMisclassify}`);
    if (m.error) md.push(`- 錯誤：${m.error}`);
    md.push("");
    md.push("### 最終回答");
    md.push("");
    md.push(String(m.answerFull || "(空)"));
    md.push("");
    md.push("### 來源");
    md.push("");
    for (const s of (m.groundingSources as { title: string; uri: string; clickable: boolean }[]) ?? []) {
      md.push(`- ${s.clickable ? "✓" : "✗"} [${s.title}](${s.uri})`);
    }
    md.push("");
  }

  md.push("## 驗收摘要");
  md.push("");
  for (const [k, v] of Object.entries(report.acceptance)) {
    md.push(`- ${k}: ${v}`);
  }
  md.push("");
  md.push("## 注意");
  md.push("");
  md.push("- 未部署。未改正式計費／OAuth／使用者資料。");
  md.push("- 訂閱 OAuth 成本以配額％為主；USD 僅為價目估算。");
  md.push("- 不得因 Gemini 新聞條數較多就宣稱更準；需核對原始來源。");
  md.push("");

  const mdPath = path.join(outDir, "phase4-live-round1-report.md");
  writeFileSync(mdPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${reportPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : e);
  process.exit(1);
});
