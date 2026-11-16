# 新聞內容品質優先 — 交付報告 A–L

**狀態**：選 A＋三護欄已落地；意圖回歸 22/22；fixture≥15＋hold-out 已鎖；抽取指標已測；raw `groundingSupports` 已記錄；Live 6×3＝18 回答完成。**未正式部署**；未改 OAuth／計費。

**產品模型**：Astra `gpt-6-astra`｜Claude `agy-claude-opus-5-5-medium`｜Argon `gemini-4-argon-medium`

---

## A. 決策與護欄

選 **A**（修誤觸發），護欄：

1. **剝離取代關鍵字排除**：判斷前先剝離附件／fenced code／引用／長篇貼上，只對使用者指令跑 `NEWSY_RE`／`needsWebResearch`。不加「架構／指令／程式」黑名單、不加 LLM 分類。
2. **明確即時需求優先**：指令含今天／最新／最近 N 天／幫我查等 → 照常 `news`（即使同時貼文件）。貼新聞全文僅整理／翻譯 → `skip`。
3. **雙向回歸 100%**：誤觸發≥10→skip；漏觸發≥10→news。

---

## B. Planner 意圖剝離（最小 diff）

新增 `lib/research-v2/instruction-text.ts`；`planner.detectIntent`／`planResearch` 改為 strip-first。

| 變更 | 行數（約） |
|------|------------|
| `instruction-text.ts`（新） | ~120 行 |
| `planner.ts` | +65／−16 |
| 查詢組裝／query 次數／時間窗以外邏輯 | **未改** |

要點：

- `EXPLICIT_LIVE_DEMAND_RE` 不用裸「搜尋／上網」（避免「原生搜尋」「不要上網」誤觸）。
- `hasOptOutOfLiveResearch`：並沒有要查／不要上網／請只回答流程 → skip。
- `isMetaNewsSystemsTalk`：討論新聞系統／Research Pipeline 本身 → skip（無即時需求時）。

---

## C. 意圖回歸（每題輸入與判定）

測試：`npx tsx --test lib/research-v2/intent-regression.test.ts` → **22/22 pass**。

### 誤觸發集（預期 skip）

| id | 輸入摘要 | 判定 |
|----|----------|------|
| ft01_arch_discuss | 對齊架構＋貼 Research V2 文件 | skip |
| ft02_cursor_指令 | Cursor 交付指令＋「新聞抽取通用規則」 | skip |
| ft03_code_explain | fenced TS＋解釋程式 | skip |
| ft04_paste_summarize | 長篇新聞＋請摘要 | skip |
| ft05_paste_translate | 長篇新聞＋請翻譯 | skip |
| ft06_paste_整理 | 請整理下面＋長篇新聞 | skip |
| ft07_quote_arch | 引用架構判斷＋「對嗎」 | skip |
| ft08_css_dump | CSS dump＋只要解釋抽取邏輯 | skip |
| ft09_meta_chat | 討論指令與架構，沒有要查時事 | skip |
| ft10_hello | 你好 | skip |
| ft11_refactor | refactor collector，不要上網 | skip |

### 漏觸發集（預期 news）

| id | 輸入摘要 | 判定 |
|----|----------|------|
| mt01_trump | 川普最新消息 | news |
| mt02_market | 明天股市預測 | news |
| mt03_nvidia7d | NVIDIA 過去 7 天新聞 | news |
| mt04_tw_tech | 台灣最近科技新聞 | news |
| mt05_arch_plus_live | 貼架構＋請查最新新聞 NVIDIA | news |
| mt06_today | 今天台積電有什麼消息 | news |
| mt07_search | 幫我查英國大選最新結果 | news |
| mt08_breaking | 東京地震最新快訊 | news |
| mt09_en | latest news about the Fed… | news |
| mt10_conflict | 最近中東衝突 | news |
| mt11_code_plus_live | 貼程式＋幫我查一下今天美股 | news |

---

## D. HTML Fixtures 與 hold-out

- 收集腳本：`scripts/collect-html-fixtures.mts`（產品同款 `safeFetchText`）。
- 數量：**16** 份遠端／合成＋**2** 份合成正文＝指標集 **18**。
- Manifest：`lib/research-v2/fixtures/html/manifest.json`
- **hold-out（鎖定後未針對其調規則）**：`cna_taiwan`, `reuters_tech_sample`, `whitehouse_briefing`, `synthetic_css_shell`, `guardian_world`（含 hash）。

---

## E. 通用抽取品質閘門

`lib/research-v2/article-extract.ts`：

- 優先 `article`／`main`／常見正文 class；CSS／`@font-face`／Skip-to／導覽殼 → 降級，**不得**標 `article_body`。
- 文件類型特例僅 **SEC EDGAR 路徑**（不綁公司名）。
- `fetchPageExcerpt` 改走此抽取；Collector 對污染正文拒絕升格。

單元測試：`article-extract.test.ts` 全過。

---

## F. 修正前／後＋hold-out＋反向正文辨識

產物：`docs/live-e2e/extract-quality-metrics.json`  
（before＝裸 HTML strip；after＝品質閘門）

| 集合 | before F1 | after F1 | before 反向誤標正文率 | after 反向誤標正文率 |
|------|-----------|----------|------------------------|----------------------|
| all (n=18) | 0.963 | 0.700 | **0.20** | **0.00** |
| hold-out (n=5) | 0.857 | 0.800 | **0.50** | **0.00** |
| dev (n=13) | 1.000 | 0.667 | 0.00 | **0.00** |

解讀：after **precision=1.0、反向誤標降為 0**（不再把 CSS／殼當正文）；recall 下降主因是入口／列表頁被標 `has_body` 期望但閘門拒收——屬正確保守，後續應改用文章 URL fixture 而非調 hold-out。

---

## G. raw Flash `groundingSupports`（必交）

- 搜尋路徑解析並持久化：`docs/live-e2e/flash-grounding-supports.jsonl`
- `RawSearchHit.rawGroundingSupports`；limitation：`raw_grounding_supports_logged_synthesis_deferred`
- **search_synthesis 延後**，本輪只記錄 raw。
- 探測樣本：`supportCount=5`（含 segment＋`groundingChunkIndices`）。

---

## H. UI：partial／failed 不得顯示「已查證」

- `completionStatus`：`complete`→「已上網查證」；`truncated`／`unknown`→「部分查證」；`failed`→「查證未完成」。
- `attachResearchToDone`：failed／skipped 清來源清單、`showVerifiedBadge=false`。
- Live 結果與 Gate 對齊：Gate=`partial` 時三模型 UI 標籤皆為「部分查證」，非「已上網查證」。

---

## I. Live K（6 題 × 快照 × 3 模型）

腳本：`scripts/research-quality-live.mts`  
報告：`docs/live-e2e/quality-live-report.json`

| 項 | 實績 |
|----|------|
| Flash／研究 | 6（每題 1 次共用快照） |
| 完整回答 | **18／18**（Astra／Claude／Argon × 6） |
| 耗時 | ~530s |
| Gate | Q1/Q3=`partial`；其餘=`ok`（仍帶 grounding_partial_serp 等警告） |

每題三模型皆成功產出；`partial` 題 completionStatus=`truncated`（部分查證）。

---

## J. Diff 範圍與不動項

- **動**：意圖剝離、抽取閘門、supports log、fixture／指標／Live 腳本、UI 文案既有對齊。
- **不動**：Planner 查詢組裝邏輯主幹、query 次數策略、時間窗以外邏輯；正式部署、OAuth、計費。

整體工作樹（含 fixture HTML）遠大於 Planner 最小 diff；Planner 本體符合「最小 diff」約束。

---

## K. 殘餘風險

1. Flash brief 仍可能含未核正文事實；Collector 不以 brief 當 `article_body`，但注入仍含 snippet——**search_synthesis 未做**。
2. Grounding redirect URI 多；正文抓取失敗率仍高 → Gate 常 `partial`。
3. 列表／首頁 fixture 拉低 recall；需更多「單篇文章」URL，而非放寬閘門。
4. DNS rebinding／SSRF TOCTOU（Phase 4 已知）。
5. 本輪 Live 消耗 Flash×6＋回答×18；勿當常態重跑。

---

## L. 停止

依指示：**完成後停止**。未部署、未改正式計費／OAuth／使用者資料。後續若要做 search_synthesis 或文章級 fixture 擴充，另開一輪。

---

## 產物索引

| 產物 | 路徑 |
|------|------|
| 本報告 | `docs/live-e2e/news-quality-report-A-L.md` |
| 意圖回歸 | `lib/research-v2/intent-regression.test.ts` |
| 抽取指標 | `docs/live-e2e/extract-quality-metrics.json` |
| supports log | `docs/live-e2e/flash-grounding-supports.jsonl` |
| Live 報告 | `docs/live-e2e/quality-live-report.json` |
| fixture manifest | `lib/research-v2/fixtures/html/manifest.json` |
