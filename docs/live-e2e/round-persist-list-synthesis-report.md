# 下一輪交付：證據持久化 + 列表頁偵測 + search_synthesis

**約束**：未部署；未改 Gateway／OAuth／計費。Live：Flash 6、回答 18。  
**硬規則**：未持久化不得宣稱品質結論——本輪已持久化。

---

## 0. 前置：持久化（完成）

每題必存（`docs/live-e2e/research-q{N}.json` + `answer-q{N}-{slot}.json` + `quality-live-report-v2.json`）：

| 欄位 | 狀態 |
|------|------|
| `injectionText` 全文 | ✅ |
| `corpusSources[]`（url／resolvedUrl／provenance／publishedAt／htmlPath） | ✅ |
| HTML 快照 | ✅ `html-snapshots/q{N}/` |
| dedup 前後 | ✅ `rawSourceCount`／`dedupedSourceCount` |
| 回答全文 | ✅（非僅 360 字 preview） |

---

## 1. P0 列表頁誤收（完成）

通用判定（`looksLikeListOrHubPage`）：連結文字佔比、短塊重複、heading／anchor 密度、入口 URL 形狀；**禁止網域特例**。

驗收（現有樣本，`scripts/check-list-gate.mts`）：

```
cna_taiwan / whitehouse_briefing / ltn / guardian / cnn / sec_edgar / nvidia hub / css shell
→ body=false；合成單篇中英 → body=true
ALL_PASS；殼／列表誤標率 = 0
```

---

## 2. Fixture 重建（完成）

- 來源：Live grounding `resolvedUrl` → 產品同款 SSRF
- 目錄：`lib/research-v2/fixtures/html-v2/`（**舊 hold-out 作廢**）
- 結果：候選 35 URL，寫入 24+1；**正文單篇 13**（目標 ≥15 差 2，受限部分站 SSRF／paywall）
- **新 hold-out**（先鎖 id+hash）：5 單篇 + 2 殼／列表  
  `live_article_03,04,05,07,10` + `shell_css` + `live_article_01`

### 指標（html-v2，含 hold-out）

| 指標 | 值 |
|------|-----|
| 正文辨識率 (recall) | **1.000**（13/13） |
| 殼頁誤標率 | **0.000**（0/12） |
| publishedAt 抽取率（expected body） | **0.846** |

產物：`docs/live-e2e/html-v2-metrics.json`

---

## 3. 意圖修正（完成）

- `isMetaNewsSystemsTalk`：**僅** `didStripRemovePastedContent===true` 時啟用；去掉裸 `fixture`／裸「新聞來源」誤殺
- 含即時需求的長提問列不因 >160／雙句號被剝
- 回歸新增：歷史 6 題、新聞來源 2 題 → news；`英超 fixture` → **general（非 skip）**；`ft12` 只貼報告 → skip  
- 測試：**40/40 pass**

---

## 4. search_synthesis（完成；Gate 未放寬）

- 由 `groundingSupports.segment` 產生 claim，provenance=`search_synthesis`
- 注入標示「【搜尋摘要，未經原文核對】」
- **不得**升格 `article_body`；`onlyTitleOrSnippetClaims` 含 synthesis → Gate 仍可 partial

### Live 實績（有料）

| Q | Gate | article_body | publishedAt | synth claims | sources |
|---|------|--------------|-------------|--------------|---------|
| 0 川普 | ok | **6** | 6 | 3 | 8 |
| 1 股市 | ok | **6** | 4 | 4 | 10 |
| 2 NVIDIA | ok | **4** | 4 | 2 | 9 |
| 3 台灣 | partial | **8** | 6 | 0 | 9 |
| 4 台積電 | ok | **8** | 6 | 1 | 11 |
| 5 英國 | ok | **8** | 8 | 2 | 10 |
| **均值** | | **6.67** | **5.67** | **2.0** | |

對照上一輪快照無法計數（當時近 0 正文／日期）：本輪可宣稱「有料」因為有持久化數字。

### 回答品質（injection 對應，離線）

產物：`live-v2-quality-analysis.json`  
Astra／Claude 實體對 injection 匹配率多數題 ≥50%；仍有 hedge（部分查證語氣）。Argon 實體多但匹配率低（原生搜尋另開路徑）。  
injection 去掉 synthesis 行後字元減少（before／after 載體對照可在各 `research-q*.json` 重現）。

---

## 5. 殘餘

1. 真實單篇 fixture 13＜15（部分 forbes／明報失敗）；hold-out 已鎖可用集。
2. 部分 publisher 頁仍抽不到正文（body=false）→ title_only／synthesis 補位，Gate 不放寬。
3. 未部署；意圖剝離需部署後才能消掉「貼報告仍觸發檢索」。

---

## 停止

本輪完成。主要產物：

- `quality-live-report-v2.json` / `research-q*.json` / `answer-q*.json`
- `html-snapshots/`
- `lib/research-v2/fixtures/html-v2/manifest.json`
- `html-v2-metrics.json` / `live-v2-quality-analysis.json`
- 本報告
