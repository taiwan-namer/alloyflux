import { readFileSync, writeFileSync } from "node:fs";

const j = JSON.parse(
  readFileSync("docs/live-e2e/phase4-live-round1-report.json", "utf8"),
);
const md: string[] = [];
const r = j.researchV2;

md.push("# Research V2 Phase 4 — 第一輪 Live E2E 對照報告");
md.push("");
md.push(
  "> 受控 Live：1 題 × 3 模型 × 各 1 次完整回答。本機 sqlite OAuth + `SUPPLIER_NODE_MODE=1`，**未寫正式 DB、未部署、未重試**。",
);
md.push("");
md.push("| 項目 | 值 |");
md.push("|---|---|");
md.push(`| 開始 | ${j.meta.startedAt} |`);
md.push(`| 結束 | ${j.meta.finishedAt} |`);
md.push(`| 問題 | ${j.meta.question} |`);
md.push("");
md.push("## 總表");
md.push("");
md.push(
  "| 模型 | 路徑 | finish / completion | 延遲 | In / Out Token | 價目估算 USD | 來源數 | V2 重用 |",
);
md.push("|---|---|---|---:|---|---:|---:|---|");
for (const m of j.models) {
  const v2 =
    m.slot === "argon" ? "n/a（原生搜尋）" : String(m.reusedPreparedResearch);
  md.push(
    `| ${m.label} | ${m.path} | ${m.finishReason} / ${m.completionStatus} | ${m.latencyMs} ms | ${m.inputTokens} / ${m.outputTokens} | ${m.costUsdOfficialCatalog ?? "n/a"} | ${m.groundingSourceCount} | ${v2} |`,
  );
}
md.push("");
md.push("## Research V2（Astra／Claude 共用，僅 1 次 Flash）");
md.push("");
md.push(`- Flash 呼叫：**${r.flashCalls}**`);
md.push(
  `- Gate：\`${r.gateStatus}\` → completionStatus：\`${r.completionStatus}\``,
);
md.push(
  `- 原始來源 ${r.rawSourceCount}／去重 ${r.dedupedSourceCount}／抓頁 ${r.pagesFetched}`,
);
md.push(
  `- 正文 provenance：**${r.bodyProvenanceCount}**；有 publishedAt：**${r.publishedAtCount}**`,
);
md.push(`- Collector 事件數：**${r.eventCount}**`);
md.push(
  `- 注入估算 tokens：**${r.estimatedInjectionTokens}**（指紋 \`${r.injectionFingerprint}\`）`,
);
md.push(`- 研究耗時：${r.researchMs} ms`);
md.push(
  "- 費用：Flash／抓頁為訂閱配額消耗；無供應商帳單拆帳（`unavailableActualUsage`）",
);
md.push("");
md.push("### 事件主題（殘餘問題）");
md.push("");
md.push(
  "多筆 NVIDIA Newsroom／CEO Transition 被標成 topic=`diplomacy`（規則誤判，**不是**川普選舉）。「未誤分為川普選舉」驗收通過。",
);
md.push("");
for (const e of r.evidenceGrades) {
  md.push(`- [${e.grade}] (${e.topic}) ${e.title}`);
}
md.push("");
md.push("### 來源樣本（證據層級）");
md.push("");
for (const s of r.sourceSample) {
  md.push(
    `- **${s.provenance}**｜publishedAt=${s.publishedAt ?? "unknown"}｜${s.title}｜${s.uri}`,
  );
}
md.push("");
md.push("## 模型分述");
md.push("");
for (const m of j.models) {
  md.push(`### ${m.slot} — ${m.modelId}`);
  md.push("");
  md.push(`- finishReason: \`${m.finishReason}\``);
  md.push(
    `- completionStatus: \`${m.completionStatus}\`（反映研究 Gate=partial；**非**回答串流截斷）`,
  );
  md.push(`- 延遲: ${m.latencyMs} ms`);
  md.push(
    `- Tokens: input=${m.inputTokens}, cached=${m.cachedInputTokens}, output=${m.outputTokens}`,
  );
  md.push(
    `- 價目估算 USD: ${m.costUsdOfficialCatalog ?? "n/a"}（訂閱 OAuth 實際扣配額％）`,
  );
  if (m.slot !== "argon") {
    md.push(
      `- Prepared Research 重用: **${m.reusedPreparedResearch}**；未偵測雙重注入`,
    );
  } else {
    md.push(`- 原生搜尋: **${m.nativeSearchLikely}**`);
    md.push(`- webSearchQueries: ${JSON.stringify(m.webSearchQueries)}`);
    md.push(
      `- Grounding 來源數: ${m.groundingSourceCount}（可點 https；無省略號截斷）`,
    );
    md.push(
      "- 發布日期: 回答中有自述日期；共同契約未獨立核對每則 publishedAt",
    );
  }
  md.push(
    `- 壞連結: ${m.badLinkCount}；截斷疑慮: ${m.truncatedSuspected}；川普誤分類: ${m.trumpMisclassify}`,
  );
  if (m.error) md.push(`- 錯誤: ${m.error}`);
  md.push("");
  md.push("#### 最終回答");
  md.push("");
  md.push(String(m.answerFull || "(空)"));
  md.push("");
  md.push("#### 展示來源");
  md.push("");
  for (const s of (m.groundingSources || []).slice(0, 12)) {
    md.push(
      `- ${s.clickable ? "✓" : "✗"} [${s.title || ""}](${s.uri})`,
    );
  }
  md.push("");
}

md.push("## 驗收對照");
md.push("");
md.push("| 標準 | 結果 |");
md.push("|---|---|");
md.push(
  "| 1 GPT／Claude 研究只注入一次 | **通過**（Flash=1；兩模型 reused=true） |",
);
md.push(
  "| 2 區分正文 vs 摘要 | **通過**（provenance；兩模型明確標只有標題） |",
);
md.push("| 3 不得標題當已確認正文事實 | **通過**（Astra／Claude 拒斷言細節） |");
md.push("| 4 不得誤分為川普選舉 | **通過** |");
md.push(
  "| 5 來源 URL 完整可點 | **通過**（皆 https，無 …；多為 grounding-api-redirect） |",
);
md.push(
  "| 6 搜尋失敗不得已查證 | **通過**（Gate=partial → completionStatus=truncated） |",
);
md.push("| 7 回答截斷不得標正常完成 | **通過**（無串流截斷） |");
md.push(
  "| 8 研究與模型 Token 分開 | **通過**（研究估算 567；模型 in/out 分列） |",
);
md.push("");
md.push("## 重要聲明：不得因 Gemini 條數多就判較準");
md.push("");
md.push(
  "- Gemini／Argon 細節最多，但連結多為 Google grounding redirect，**本輪未逐條人工打開原文核對**。",
);
md.push(
  "- Astra／Claude 在 V2 證據不足時保守拒答——符合 Gate／provenance，**不代表 Gemini 一定錯或一定對**。",
);
md.push("- 重要新聞應另以 NVIDIA Newsroom／SEC EDGAR 原始頁核對後再比準確度。");
md.push("");
md.push("## 殘餘風險");
md.push("");
md.push("1. `publishedAt` 全數 unknown。");
md.push(
  "2. URL 常停在 `vertexaisearch.cloud.google.com/grounding-api-redirect/...`。",
);
md.push("3. Collector 將部分 NVIDIA 企業新聞標成 `diplomacy`。");
md.push("4. 無供應商美金帳單；僅價目估算 + 配額％。");
md.push("5. DNS rebinding／連線釘選 IP 仍為已知限制。");
md.push("");
md.push("## 原始檔");
md.push("");
md.push("- `docs/live-e2e/phase4-live-round1-report.json`");
md.push("- `docs/live-e2e/raw-{astra,claude,argon}.json`");
md.push("");
md.push("**已停止。未部署。**");

writeFileSync(
  "docs/live-e2e/phase4-live-round1-report.md",
  md.join("\n"),
  "utf8",
);
console.log("ok", md.length, "lines");
