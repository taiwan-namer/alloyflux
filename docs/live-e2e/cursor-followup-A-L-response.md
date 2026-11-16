# 補件回覆：A–L 未完成項（離線，未再打 Flash／主模型）

**約束遵守**：僅用既有 fixture、`quality-live-report.json`、`flash-grounding-supports.jsonl`。未部署；未改 Gateway／OAuth／計費。  
**機器可讀產物**：`docs/live-e2e/supplement-A-L-followup.json`

---

## 1. 抽取指標重算

### 1.1 Fixture 盤點（真實 vs 合成）

| 類別 | 數量 | 說明 |
|------|------|------|
| 真實 SSRF 抓取成功 | 11 | 含列表／hub／SEC 搜尋頁 |
| 真實嘗試失敗占位殼 | 3 | reuters／apnews／marketwatch（401／403）→ 磁碟上是短失敗 HTML，**不是**原站正文 |
| 合成 | 4 | css 殼、grounding redirect、中／英單篇 |

**reuters_tech_sample**：對 `https://www.reuters.com/technology/` 發過產品同款 SSRF，回 `http_401`；檔案 130B 失敗占位殼。**不是** Reuters 真實頁面 HTML。

### 1.2 為何 before 在 dev 上 F1=1.000

舊標註把多數**列表／入口**標成 `has_body`，而 before（裸 strip）只要字元 ≥120 就算「正文」。dev 裡標成 `shell` 的幾乎都是 fetch 失敗短殼（before=false 正確）；真正難的 CSS 殼 `synthetic_css_shell` 在 **hold-out**。  
→ before「完美」是因為**標註標準≈有沒有足夠文字**，不是正文辨識真的對。

### 1.3 標註修正（hold-out 只改錯標，不改規則）

| id | 頁面類型 | 來源 | 舊標 | 新標 | 理由 |
|----|----------|------|------|------|------|
| guardian_world（hold-out） | list_hub | 真實抓取 | has_body | **shell** | `/world` 列表，非單篇 |
| cnn_world / cnbc_markets / cna_taiwan / udn_money / ltn_news / microsoft_newsroom / apple_newsroom / nvidia_newsroom_hub / whitehouse_briefing | list_hub | 真實 | has_body | shell | 入口／列表／redirect 到列表 |
| sec_edgar_search | sec_search | 真實 | has_body | shell | 搜尋 UI，非 filing 正文 |
| synthetic_good_article_{en,zh} | single_article | 合成 | has_body | has_body | 唯一明確單篇正文集 |
| reuters／apnews／marketwatch／synthetic 殼與 redirect | shell／interstitial | 失敗占位或合成 | shell | shell | 不變 |

逐份 before／after 判定見 `supplement-A-L-followup.json` → `perFixture`。

### 1.4 重算後：正文辨識率 ∩ 殼頁誤標率（並列）

**修正標註後**（`has_body`＝單篇正文）：

| 集合 | | precision | **正文辨識率 (recall)** | **殼頁誤標率** | F1 |
|------|--|-----------|-------------------------|----------------|-----|
| all | before | 0.143 | **1.000** | **0.750** | 0.250 |
| all | after | 0.286 | **1.000** | **0.313** | 0.444 |
| hold-out | before | 0 | 1.000* | **0.800** | 0 |
| hold-out | after | 0 | 1.000* | **0.400** | 0 |
| dev | before | 0.200 | 1.000 | **0.727** | 0.333 |
| dev | after | 0.400 | 1.000 | **0.273** | 0.571 |

\*hold-out 無單篇正樣（兩篇合成正文在 dev）→ recall 分母為 0 時分數上記 1；重點看**殼頁誤標率**。

**結論（對紅燈 1）**：

- 舊報告 after F1 下降，主因是**列表被錯標 has_body**，不是「全面降級過關」。
- 修正後：兩篇真單篇 **after 皆認出（正文辨識率=1）**；殼頁誤標率 all **0.75→0.31**（仍有 5 個 hub 被 after 誤收：含 hold-out 的 cna／whitehouse）。
- precision 仍低，因為集合幾乎沒有真實單篇 URL——這是 fixture 組成問題，下一輪應補單篇真實頁，而不是再放寬閘門。

---

## 2. 修正前／後 injection 原文對照（≥3）

同源 HTML → before＝裸 strip 片段；after＝`extractArticleFromHtml`（會進 injection 的正文候選）。

### 2.1 中文列表（cna_taiwan）— after 仍誤收

**before（會當正文注入）**：  
`中央社 CNA 立刻加入 本網站使用相關技術提供更好的閱讀體驗… Focus Taiwan …`

**after（仍 isMainBody=true，問題未解）**：  
`本網站使用相關技術提供更好的閱讀體驗… Focus Taiwan… 九合一 王美惠造勢晚會　蕭副總統：嘉義縣市合作…`

### 2.2 殼頁（synthetic_css_shell）— after 正確降級

**before**：  
`CNN Style Shell @font-face { font-family: X; src: url(a); } body { margin:0; } …`（重複 CSS）

**after**：`(降級：template_or_css_pollution)` → **不會**當 article_body 注入

### 2.3 中文單篇（synthetic_good_article_zh）— after 保留正文、去掉導覽

**before**：  
`台股收盤整理：科技股領漲 訂閱 · 下載 App · 熱門新聞 今日台股收盤上漲…`

**after**：  
`今日台股收盤上漲，科技權值股帶動指數走高。分析師指出…`（導覽列剝除，段落保留）

---

## 3. 缺漏範圍逐項

| 項 | 狀態 | 證據 |
|----|------|------|
| **publishedAt** | **完成（程式）／Live 快照不可還原計數** | fixture 抽取率 **5／18＝27.8%**（多為列表／殼）。`quality-live-report` **未存** per-source `publishedAt`；warnings 可見 Q0／Q2 `some_events_body_missing_date`。對照 Phase4 round1 先前 Live 常近 **0／N**——本輪無法用快照重算精確 N，屬快照欄位缺口。 |
| **redirect** | **完成** | `safeFetchText` 記 `redirectHops`＋`resolvedUrl`。fixture：`microsoft_newsroom` 1 hop→`/source/`；`whitehouse_briefing` 1 hop→`/news/`。grounding redirect 中間頁仍常無法升格正文（合成 interstitial＝shell）。 |
| **canonical 去重** | **完成（程式）／Live 未記前後數** | `collector`：`cleanSourceUrl`＋`seenUri`；離線演示 raw 3→deduped 2。Live 快照無 dedup 前後欄。 |
| **topic 規則** | **完成＋測試** | `guessTopic`：**CEO／執行長／resign → corporate** 優先於 diplomacy。`topic-rules.test.ts`：NVIDIA CEO resign → `corporate` ✅；峰會 → `diplomacy` ✅。 |

---

## 4. Live 品質離線分析（既有 18 回答＋6 研究快照）

**硬限制**：`quality-live-report.json` 未存 `injectionText`／`corpus.sources[].provenance`／`publishedAt` → **無法**給出 article_body 數、日期數、實體對 injection 對應比例。下列為可還原項；hedge／實體僅來自 `contentPreview`（截斷至 ~360 字）。

### 4.1 groundingSupports（6 次 Live）

| | |
|--|--|
| Live 6 次回傳 supports>0 | **6／6** |
| supportCount | 10, 8, 5, 10, 5, 4 |
| 另：探測 1 筆 | supportCount=5（不計入 Live 6） |

### 4.2 每題摘要

| Q | Gate | 來源數 | 快照可還原警告 | 三模 hedge 命中合計* | 實體命中合計*（人名／數字／日期） |
|---|------|--------|----------------|----------------------|----------------------------------|
| 0 川普 | partial | 10 | body_missing_date；truncated_events:2 | 4 | 26 |
| 1 股市 | ok | 12 | unconfirmed；truncated:5 | 7 | 17 |
| 2 NVIDIA | partial | 12 | body_missing_date；truncated:4 | 1 | 27 |
| 3 台灣科技 | ok | 10 | truncated:2 | 0 | 9 |
| 4 台積電 | ok | 11 | unconfirmed；truncated:3 | 0 | 17 |
| 5 英國 | ok | 7 | unconfirmed | 1 | 10 |

\*hedge 例：只有標題／無法確認／部分完成／不確定／請點來源…  
\*實體對應 injection：**不可算**（無 injection 全文）。

**article_body／publishedAt 每題**：快照缺失 → 記 `null`；僅知 Gate 在 Q0／Q2 明確抱怨缺日期／截斷事件。

**品質結論（對紅燈 2）**：現有產物只能證明「跑完＋有實體詞出現＋partial 時模型會寫對沖語」，**不能**證明「答得比較好」。要證品質需下一輪把 `injectionText`＋provenance 計數寫進 Live 報告（仍可不重打 Flash，若保留完整快照）。

---

## 5. 意圖規則透明化

### 5.1 `isMetaNewsSystemsTalk`（非「架構／程式」黑名單）

**實際 regex**（需先 `!hasExplicitLiveDemand`）：

```
新聞\s*(回答|品質|系統|抽取|管線|證據|來源)
| news\s*answer
| research\s*(?:v\s*2|pipeline)
| provenance | collector | injectionText | groundingSupports
| fixture | hold-out
| 對齊架構 | 分析以下文件 | 討論指令與架構
```

**為何不算護欄禁止的黑名單**：護欄禁止的是用「架構／指令／程式」等詞**一律跳過**來擋誤觸。此函式只在**無明確即時需求**時，辨識「在討論新聞系統本體／交付產物」的**正例模式**（含系統內部識別名與「對齊架構＋分析文件」這類 meta 請求）。有「請查最新」仍走 news（即時需求優先）。

### 5.2 `hasOptOutOfLiveResearch`

```
不要上網|別上網|勿上網|不用上網|不需上網|不要聯網
|並沒有要查|沒有要查任何
|不要搜尋|不要搜索|別搜尋
|請只回答流程
```

這是使用者**明確拒絕聯網**的肯定句式，不是主題黑名單。

### 5.3 「長篇貼上」剝離門檻（逐行）

| 規則 | 門檻 |
|------|------|
| 單列捨棄 | `length > 160` |
| 單列捨棄 | `length > 100` 且句號類 ≥2 |
| 單列捨棄 | `length > 80` 且含新聞體詞（路透／美聯社／報導指出…） |
| 另 | fenced code、`<style/script/html>`、markdown `>` 引用、CSS 規則列 |
| 保底 | 若全剝光 → 取首行 ≤280 或 raw 前 160 字 |

使用者自己打的**單行長問題**若 >160 會被當成貼上剝掉——已知風險；多行短句指令不受影響。

### 5.4 新增回歸

`ft12_paste_report_only`：只貼交付報告、無指令 → **skip** ✅（意圖集現 12＋11，測試通過）。

---

## 停止

補件完成。未部署、未再呼叫 Flash／主模型。  
建議下一輪（若要證 Live 品質）：擴充 Live 快照欄位（injection／provenance／publishedAt 計數）＋補真實單篇 fixture；不必為補欄位重跑 18 回答若已另存完整 verdict。
