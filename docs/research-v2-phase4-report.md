# Research V2 Phase 4 報告（A–H）

**狀態**：實作完成；Mock／整合測試通過（62/62）。**未正式部署**。Live E2E 未執行（需 `RESEARCH_LIVE_E2E=1`＋已授權憑證／預算批准）。

**產品模型鎖定**

| 槽位 | Model ID | 搜尋路徑 |
|------|----------|----------|
| Astra | `gpt-6-astra` | Research V2（平台一次） |
| Claude | `agy-claude-opus-5-5-medium` | Research V2（ALS 重用） |
| Argon | `gemini-4-argon-medium` | Gemini 原生 Google Search |

---

## A. 路由與雙重注入（P0-1）

**修復**

- Gateway：Node 路徑才把 `injectionText` 併入 `extraSystemContext`；Local 路徑只傳原始 context，由 `withResearchSystem`＋`reusePreparedResearch` 注入。
- Provider：`withResearchSystem` 若偵測 base 已含查證標記或同一段 `injectionText`，不再附加。
- `researchForMessages`：ALS 有 prepared 時直接重用，不重跑 pipeline。

**證據**：`phase4-p0.test.ts` P0-1（計數器=1、failover 不重跑、字串不雙疊）。

**各模型實際收到的研究資料（Mock／契約）**

| 模型 | 資料來源 | 搜尋呼叫 |
|------|----------|----------|
| GPT／Astra | 同一份 V2 `injectionText`＋sources | 平台 1 次 Flash／search |
| Claude | 同上（ALS reuse） | 0 次額外 |
| Gemini／Argon | 原生 Grounding → `geminiGroundingToResearchResult`（允許 unknown） | 原生 grounding（非 V2） |

---

## B. URL／SSRF（P0-2）

**修復**

- 廢除「`redirect: follow`＝已防護」假設。
- `lib/research-v2/ssrf.ts`：每次 hop 驗證 HTTPS、封鎖私有／loopback／link-local／metadata、DNS 解析後再檢查 IP。
- `fetchPageExcerpt` 改走 `safeFetchText`（`redirect: manual`）。
- `cleanSourceUrl` **不再**插入 `…`（避免破壞 href）；顯示用 `displaySourceUrl`。
- 無法安全展開 → 保留 originalUrl，`fetchStatus: unresolved|blocked_ssrf`。

**殘餘風險**：Node `fetch` 無法鎖定「解析 IP＝連線 IP」，DNS rebinding TOCTOU 仍在；報告中標為未完全消除。

---

## C. 證據層級（P0-3）

**新增 `EvidenceProvenance`**：`article_body`｜`official_document`｜`structured_metadata`｜`search_snippet`｜`title_only`｜`unknown`

**規則**

- 僅標題 → `title_only`，claim 不得升為可核對 `reported_fact`。
- Flash brief → 僅可產生 `search_snippet` claim，不可冒充正文。
- `publishedAt`／`eventAt`／搜尋取得時間語意分離；`eventAt` 缺則不填造。
- Gate：**不得**僅憑 `sourceIds.length > 0` 認定充分；缺日期 → `partial`／`body_missing_date`，非整段 `failed`。

---

## D. 共同契約允許 unknown（P0-4）

- `ResearchResult`／`ResearchSource`／`ResearchClaim` 缺欄為 `undefined`，Gemini adapter **不填造** `publishedAt`、`resolvedUrl`、`excerpt`、`claimType`。
- `verdictToResearchResult`／`geminiGroundingToResearchResult` 於 `lib/research-v2/contract.ts`。

---

## E. Live 成本（P0-5）

| 模式 | 完整回答上限 | 說明 |
|------|--------------|------|
| 測試 A 產品路徑 | 9 | 3 模型 × 3 題 |
| 測試 B 固定證據 | 9 | 同上，搜尋呼叫=0 |
| **合計** | **18** | 分開計數，互不挪用 |

另計：`searchCalls`／`flashCalls`／`extraModelCalls`／`estimatedTokens`。超限設 `stoppedReason`；retry／failover 不可繞過。

**實際金額**：`researchCost.unavailableActualUsage=true`——目前保障的是次數與估算 Token，**不是**帳單金額上限。

Live runner：**僅** `RESEARCH_LIVE_E2E=1`；本環境未開 → 測試標記跳過。

---

## F. UI／完成狀態

- `done.completionStatus`：`complete`｜`truncated`｜`failed`｜`unknown`
- SourceChip：拒絕含 `…` 的假連結；完整 `https` href
- 前端：部分查證／查證未完成文案

---

## G. 測試結果

```
npm test → 62 passed, 0 failed
```

涵蓋：P0-1…P0-5、Collector／Gate、Fixture A/B/C、Test B 固定證據 harness、SSRF 單元、ALS 隔離。

**正文／日期／來源抽取比例**：Live 未跑 → 無實測比例。Mock 上：有 pages 且 excerpt≥120 → `article_body`；無 pages → `title_only`；缺 meta → `publishedAt` 省略。

**修正前後新聞召回（Mock Fixture B）**：多主題（diplomacy／economy／election）可並存；缺日期不再整段 failed。

**Token／費用／延遲**：離線可比較估算 injection tokens；真實費用／延遲待授權 Live。

---

## H. 殘餘風險與未驗證項

1. DNS rebinding（fetch 連線層未釘選 IP）。
2. Gemini 原生 Grounding → 共同契約仍大量 `unknown`；未驗證與 V2 事件召回對齊的 Live 差異。
3. 實際美元／點數成本帽未接通帳單 API。
4. 一 URL 多獨立事件仍以 URL 種子為主（Phase 3 已知限制）。
5. 供應商可能把整段 system（含注入）原樣上傳——提示詞注入殘餘風險。
6. **禁止正式部署**；未改正式計費、OAuth、使用者資料。

---

## 主要變更檔

- `lib/research-v2/types.ts` — 契約／provenance／completionStatus
- `lib/research-v2/ssrf.ts` — SSRF 安全抓取
- `lib/research-v2/collector.ts` / `gate.ts` / `inject.ts` / `contract.ts` / `live-budget.ts`
- `lib/web-research.ts` — cleanSourceUrl／safe fetch／publishedAt 抽取
- `lib/gateway.ts` / `lib/providers.ts` — 消除雙重注入
- `lib/research-v2/gateway-contract.ts` — done.completionStatus
- `app/page.tsx` — SourceChip／完成狀態顯示
- `lib/research-v2/phase4-p0.test.ts` / `phase4-test-b.test.ts`
