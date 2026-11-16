# 可獨立部署變更清單（不實際部署）

**約束**：本輪未部署；未改 Gateway／OAuth／計費。`search_synthesis` 預設關閉。

---

## A. 可先部署（建議）

### A1. 意圖剝離
| 項目 | 路徑／行為 |
|------|------------|
| 貼上內容剝離 | `lib/research-v2/instruction-text.ts` |
| Planner 綁定 | `lib/research-v2/planner.ts`（meta 僅在 `didStripRemovePastedContent===true`） |
| 回歸 | `lib/research-v2/intent-regression.test.ts`（40/40） |
| 理由 | 每輪白燒 Flash、無關新聞注入；ft12 類貼報告仍觸發檢索 |

### A2. 列表頁閘門
| 項目 | 路徑／行為 |
|------|------------|
| 通用判定 | `lib/research-v2/article-extract.ts`：`looksLikeListOrHubPage`／`looksLikeSectionHubUrl` |
| 規則 | 僅通用路徑 token（`world`／`news`／…）；**無站點特例**（`sec.gov` 僅用於申報文件型態，不在 list gate） |
| 理由 | 只讓系統更保守；誤收列表當正文風險下降 |

### A3. UI「部分查證」標籤
| 項目 | 路徑／行為 |
|------|------------|
| Gate → completion | `lib/research-v2/gate.ts`（partial→truncated） |
| UI 文案 | `app/page.tsx`（`部分查證`／`已上網查證`／`查證未完成`） |
| Gateway 附掛 | `lib/research-v2/gateway-contract.ts` |
| 理由 | 信任層 bug；成本近 0 |

---

## B. Feature flag 後置（預設關，先不開）

### B1. `search_synthesis`
| 項目 | 說明 |
|------|------|
| Flag | `RESEARCH_SEARCH_SYNTHESIS=1` 才啟用（`lib/research-v2/synthesis-flag.ts`） |
| 預設 | **關閉**；raw supports 仍可寫備查，但不注入 |
| Collector | `lib/research-v2/collector.ts`：衝突時 `article_body` 勝出並標記 |
| 開啟條件 | 凍結 injection A/B（含 Claude）證明效果；article_body 誤標可控 |
| 本輪 A/B | Astra 12/12 完成；Claude 因訂閱速率鎖定 0/12 → **效果仍未證明到可開 flag** |

---

## C. 本輪明確不做
- 不部署任何模組
- 不改 Gateway／OAuth／計費
- 不開 `RESEARCH_SEARCH_SYNTHESIS`
