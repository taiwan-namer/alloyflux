# 離線輪：synthesis A/B + 稽核 + Gate 不變性

**約束**：Flash 0；未部署；未改 Gateway／OAuth／計費。  
**回答**：規劃 24（6×Astra×Claude×2）；Astra 12/12 成功；Claude 12/12 訂閱速率鎖定失敗（Opus／Sonnet 皆鎖）。

---

## 1. synthesis A/B（凍結 injection）

產物：`docs/live-e2e/synth-ab/`（`injection-q*-{with,without}_synth.txt`、`answer-*.json`、`synth-ab-table.json`）

### Astra 逐題表

| Q | variant | 實體數 | body 匹配率 | **只**對 synth 匹配率 | synth 事實有標「未經原文核對」 | 「只有標題／無法確認」類句數 |
|---|--------|--------|-------------|----------------------|-------------------------------|------------------------------|
| 0 | with | 5 | 0.40 | **0.20** | true | 1 |
| 0 | without | 6 | 0.33 | 0 | n/a | 1 |
| 1 | with | 2 | 0 | 0 | n/a | 2 |
| 1 | without | 1 | 0 | 0 | n/a | 1 |
| 2 | with | 4 | 0.50 | 0 | n/a | 2 |
| 2 | without | 4 | 0.50 | 0 | n/a | 2 |
| 3 | with | 4 | 0.75 | 0 | n/a | 1 |
| 3 | without | 4 | 0.75 | 0 | n/a | 2 |
| 4 | with | 6 | 0.67 | 0 | n/a | 2 |
| 4 | without | 6 | 0.67 | 0 | n/a | 0 |
| 5 | with | 1 | 1.00 | 0 | n/a | 1 |
| 5 | without | 1 | 1.00 | 0 | n/a | 1 |

### Claude
全數失敗：`Claude Opus 5.5 · Medium`／`Sonnet 5.5 · Medium` 訂閱速率鎖定。無法完成雙模型 A/B。

### 判定
- **效果仍未證明可開 flag**：Q0 with_synth 出現 synth-only 實體（「川普」），雖有標「未經原文核對」，但多數題 with／without 幾乎無差。
- Q1～Q5 Astra：body 匹配率 with≈without；hedge 無一致改善。
- **結論**：`RESEARCH_SEARCH_SYNTHESIS` **維持預設關閉**。

---

## 2. article_body 抽樣稽核（seed=20261116，n=15）

產物：`article-body-audit-15.json`

| 指標 | 值 |
|------|-----|
| 誤標率 | **0.1333**（2/15） |
| single_article | 13 |
| list（獨立 list-gate） | 2 |
| in-sample（Live body ∩ html-v2） | **16/40 = 0.40** |

誤標 2 筆皆為 `taipeitimes.com` 單篇 URL，獨立 `looksLikeListOrHubPage` 判 `link_and_short_block`（連結比 0.43／0.60），但 Live 仍標 `article_body`。  
→ 「6.67 正文」含樂觀成分；in-sample 40% 進一步限制跨輪歸因。

---

## 3. Gate 不變性

產物：`gate-invariance-live6.json`；單元測試 `lib/research-v2/synthesis-gate.test.ts`（4/4 pass）

| Q | with synth | without synth | 一致 |
|---|------------|---------------|------|
| 0–5 | ok/partial 各題 | 同左 | **全 true** |

→ Q0／Q2 變 ok **不能**歸因 synthesis。

---

## 4. 指標拆分（html-v2）

產物：`html-v2-metrics-split.json`／更新 `html-v2-metrics.json`

| 集合 | n | 正文 recall | 殼誤標率 | publishedAt@body |
|------|---|-------------|---------|------------------|
| all | 25 | 1.000 | 0.000 | 見檔 |
| **dev** | 18 | 1.000 | 0.000 | |
| **hold-out** | 7 | 1.000 | 0.000 | |

Live article_body in-sample：**0.40**（16/40）。

---

## 5. 解釋與規則

### Q3 synth=0
- `flash-grounding-supports.jsonl` 該題 **supportCount=5**（Flash 有回傳）
- 離線重建：`rebuiltSynthClaims=4`，但 Live `searchSynthesisClaimCount=0`
- **原因**：synthesis 事件 relevance=0.45，在 `rankEventsWithDiversity`（maxEvents／主題多樣）後被截斷，**未進最終 injection**  
  → 非過濾、非去重吞掉、非 Flash 沒回傳

### 衝突規則（已實作＋測試）
- synthesis 與既有 `article_body` 重疊 → **以 article_body 為準**
- limitation：`synthesis_conflict_article_body_wins:{eventId}`
- 另附 claim 標記「衝突｜以正文為準｜搜尋摘要未採用」；不另建未標註 synth 事件

### Feature flag
- `RESEARCH_SEARCH_SYNTHESIS=1` 才注入；**預設關**
- Flag 關時：`search_synthesis_disabled_by_flag`

### 網域 grep（`looksLikeListOrHubPage`／`looksLikeSectionHubUrl`）
- 僅通用路徑 token：`world|news|newsroom|markets|…`
- **無** bbc／cnn／cna／guardian／nvidia 等站點路徑特例  
- （`sec.gov` 僅 `isStructuredFilingUrl`，不在 list gate）

---

## 6. 部署準備（未部署）

見 `deploy-ready-changelog.md`：

| 模組 | 建議 |
|------|------|
| 意圖剝離 | 可先部署 |
| 列表頁閘門 | 可先部署 |
| UI 部分查證 | 可先部署 |
| search_synthesis | **flag 後置，預設關**；Claude A/B 補齊且效果證明前不開 |

---

## 停止

本輪完成。Flash=0。不部署。
