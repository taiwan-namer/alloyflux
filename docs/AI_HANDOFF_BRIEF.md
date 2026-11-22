# AI 交接簡報：AlloyFlux／AI 用量平台

> 給另一個 AI／工程師快速進入專案用。最後更新：2026-11-16（HEAD 約 `e1b5242`）。  
> Repo：`https://github.com/taiwan-namer/alloyflux.git`｜本地常見路徑：`C:\Users\Admin\MyProjects\binance`  
> 正式站：`https://alloyflux.vercel.app`｜DB：Supabase Postgres（`DATABASE_URL`）

---

## 1. 平台在做什麼（一句話）

**台灣向的「AI 閒置額度時間銀行」**：供給者用 OAuth／裝置碼把用不完的訂閱額度（Gemini／ChatGPT／Grok 等）掛進水庫賺 **80% 創作者分潤**；買家在聊天工作台用模型，閘道智慧路由到訂閱池，尖峰再落到平台 API／OpenRouter 保底。

合規話術常用：**AI 工作流／Agent 創作者上架分潤（80% 回饋）**、**開源模型評測獎勵金**（見 `/vendor`、`/sources`、admin）。

---

## 2. 角色與主要頁面

| 角色 | 路徑 | 做什麼 |
|------|------|--------|
| 買家／一般使用者 | `/` | 多模型聊天、上傳附件、自動路由、Research／上網查證 |
| 節點夥伴（供給者） | `/vendor` → `/sources` | 同意條款、綁 Gemini／ChatGPT／Grok／Claude、調分配%、看分潤試算 |
| 管理員 | `/admin` | 使用者、帳本、分潤、節點概覽 |
| 節點 Agent | `apps/node-agent` | 可選：Token 留在供給者裝置，平台只派工 |

---

## 3. 技術棧（規格摘要）

| 項目 | 規格 |
|------|------|
| 框架 | **Next.js 16**（注意：此版 API／慣例可能與舊訓練資料不同；寫碼前先看 `node_modules/next/dist/docs/` 與 repo 根 `AGENTS.md`） |
| UI | React 19、TypeScript |
| DB | Supabase Postgres；`lib/db.ts` 用 postgres.js，**Transaction pooler 必須 `max_pipeline: 1`**（否則 Vercel 易 300s hang） |
| 部署 | Vercel；環境變數含 `DATABASE_URL`、`APP_SECRET`、`ADMIN_EMAILS`、計價等（見 `.env.example`） |
| 語言／回覆慣例 | 產品與 Agent 對使用者多用**繁體中文** |

---

## 4. 核心商業／計費口徑（已寫進 UI 試算）

- 買家參考：Pro 約 **NT$199／月**、用量相對官方等值折扣（文件見 `docs/01_商業計畫總整理.md`）。
- 供給者分潤試算：`NTD_PER_BUYER_POINT_AT_80_PCT = 0.199 * 0.8`（`/sources`）。
- **「近 7 天已產生分潤」**＝實績（messages 用量 × 口徑）；**「剩餘／滿載月估」**＝依現行節點產能的**預估**，不是錢包餘額。
- 出金／可提領錢包：**尚未完整上線**；表結構有 `supplier_earnings`（pending／paid）、`supplier_settlements`。

---

## 5. 供給端 OAuth／綁定（目前行為）

### Gemini（Antigravity／Google AI Pro／Ultra，含 Claude＆GPT 池）
- 官方 Desktop client + redirect：`https://antigravity.google/oauth-callback`（Copy to Clipboard）。
- 流程：`/api/oauth` `start_gemini` → 使用者授權 → 貼 `4/0A...` → `complete_code` → `exchangeGeminiCode` → 寫 `sources`。
- **PKCE verifier 編在 state**；不可只靠伺服器記憶體 Map（Vercel 多實例會丟）。
- 近期修過：
  - 同碼不可重送（貼上自動送 + 手動送會 `invalid_grant`）。
  - 重綁查詢不可寫 `OR ? IS NULL`（Postgres：`could not determine data type of parameter $N`）→ Google 其實已換到 token，寫庫失敗後重貼就變 invalid_grant。
  - 彈窗：必須在 `await fetch` **之前** `window.open`，否則被擋；備援顯示「前往 Google 授權」連結。
  - UI：「貼上」放在輸入列旁（非長文案一鍵剪貼簿按鈕）。

### ChatGPT／Grok 裝置碼
- start 把 `device_auth_id`／`user_code` **編進 state**；poll 用 `decodeStatePayload`（同樣為了 serverless）。
- 時效：Grok 常回 `expires_in`≈900s；ChatGPT 此 API 未回過期秒數，實務較緊。

### 節點移除與分潤
- **軟刪**：`sources.removed_at` + `enabled=0`；控制台隱藏，但 `/api/supplier-usage` **含已移除**，近 7 天實績不歸零。
- 硬刪會讓 usage 依 source_id 查不到 → 畫面上金額變 0（舊 bug，已改軟刪）。

關鍵檔：`lib/oauth.ts`、`app/api/oauth/route.ts`、`lib/sources.ts`、`app/sources/page.tsx`、`app/vendor/page.tsx`。

---

## 6. 聊天／閘道／記憶

| 項目 | 現況 |
|------|------|
| 上游視窗 | 至少 `UPSTREAM_MAX_TURNS = 8` 輪，起點每 `UPSTREAM_WINDOW_STEP_TURNS = 4` 輪才前移（實帶 8–11 輪，利於 prompt cache）`lib/context-window.ts` |
| Prompt cache | ChatGPT 路徑：`instructions` 只放固定前段；狀態摘要／跨對話提問／即時查證以 developer 訊息插在本輪 user 前（`splitSystemPromptForCache`，上游 400 時自動退回舊排法） |
| 長對話 | `conversation_states` 本串狀態筆記（目標／硬約束／決策／provenance／supersede）+ `conversation_history_summaries` 視窗外整則批次（≈3500 tok）摘要 |
| 注入 | `buildConversationStateContext` + 使用者 `user_memories` → chat `extraSystemContext` |
| 自動路由 | `lib/auto-router.ts`；免費層 `freeMode` |
| Research V2 | 平台先跑一輪再注入上游（`lib/gateway.ts`）；Gemini 可走原生 grounding；GPT／Claude 靠 injection |

狀態筆記規則（已實作）：
- 條目 provenance：`user`／`assistant_inferred`／`system`；推測不可覆蓋使用者硬約束。
- 吸收批次：整則邊界、近滿不切開；`STATE_ABSORB_TOKEN_TARGET ≈ 3500`。

Schema：`supabase/schema.sql`（含 `conversation_states`、`conversation_history_summaries`、`sources.removed_at` 等）。**新表／新欄需在 Supabase 執行**（程式有 IF NOT EXISTS／ALTER IF NOT EXISTS 遷移風格）。

---

## 7. Research V2（新聞／上網查證）

路徑：`lib/research-v2/*`、`lib/web-research.ts`。

| 項目 | 規格／狀態 |
|------|------------|
| 注入預算 | `DEFAULT_INJECTION_MAX_TOKENS = 3000`；頁面字元上限等見 token-budget／collector |
| GPT／Claude 讀頁 | 曾加倍 read budget（較密 evidence） |
| 意圖 | 剝離貼上長文再判斷是否要上網（`instruction-text.ts`） |
| 列表閘門 | 避免把列表／hub 當正文 |
| UI | 已上網查證／部分查證／查證未完成 |
| `search_synthesis` | **預設關**（`RESEARCH_SEARCH_SYNTHESIS=1` 才開）；效果未完全證明，勿隨便開 |
| 測試 | `npm test` → `lib/research-v2/**/*.test.ts`；另有 `lib/conversation-state.test.ts` |

報告目錄：`docs/live-e2e/`、`docs/research-v2-phase4-report.md`。

---

## 8. 節點 Agent（可選架構）

構想：Token 在供給者裝置、平台只派 `inference_jobs`；`REQUIRE_SUPPLIER_NODE=1` 可禁止平台代發 OAuth。  
文件：`docs/03_構想階段_節點與無痕設計.md`、`docs/04_Node_Agent_MVP.md`、`apps/node-agent/README.md`。  
無痕：ChatGPT／Grok `store: false`。不做住宅 IP／指紋偽裝。

---

## 9. 近期進度（2026-11 中下旬，依 commit）

1. Research V2 Phase 4 + 新聞品質（list gate、intent strip、synthesis flag）。
2. 供給者貨源 `owner_user_id` 隔離；辦公室檔上傳等。
3. Gemini OAuth：官方 copy-code 頁、雙送／invalid_grant、寫庫 `$N` 型別、彈窗封鎖、貼上 UI。
4. ChatGPT／Grok 裝置碼 state 可跨 Vercel 實例。
5. 長對話狀態筆記 + 歷史摘要表／注入。
6. 節點移除軟刪 + 分潤實績／預估文案澄清。

**尚未做／半成品（交接時注意）：**
- 完整出金／可提領餘額 UI 與打款流程。
- 長對話「同串檢索」與 token slot 組裝進階版。
- Research synthesis 預設仍關。
- 會員金流（綠界等）文件有寫階段二，原型未必全接。
- PR 歷史上曾有 `cursor/fix-google-oauth-double-exchange-b9bd`；相關修補多已進 `main`。

---

## 10. 重要約束（對 Agent 的操作規則）

- 使用者規則：回覆**繁體中文**；**不要擅自 commit／push／deploy**，除非明確要求；不要改 git config。
- 商業敏感：勿主動部署 Gateway／OAuth／計費大改，除非使用者要。
- Next 16：先讀專案內 Next docs，勿用舊版假設硬套。
- Secrets：`.env.local` 有金鑰，**禁止 commit**。

---

## 11. 建議閱讀順序（給接手 AI）

1. 本檔  
2. `docs/01_商業計畫總整理.md`  
3. `docs/03_構想階段_節點與無痕設計.md`  
4. `supabase/schema.sql`  
5. `lib/oauth.ts` → `lib/sources.ts` → `app/api/chat/route.ts` → `lib/gateway.ts`  
6. `lib/conversation-state.ts`、`lib/research-v2/`  
7. `app/sources/page.tsx`、`app/page.tsx`

---

## 12. 可直接貼給另一個 AI 的任務提示範例

```text
你正在接手 AlloyFlux（ai-usage-platform）：台灣 AI 訂閱額度水庫 + 聊天工作台。
Repo 見 docs/AI_HANDOFF_BRIEF.md。技術：Next 16 + Supabase + Vercel。
供給者 OAuth（Gemini copy-code／ChatGPT·Grok 裝置碼）狀態必須可跨 serverless；
sources 移除是軟刪；聊天有 8 輪視窗 + conversation_states 筆記。
Research V2 synthesis 預設關。回覆用繁體中文；未要求不要 commit/push/deploy。
先讀 docs/AI_HANDOFF_BRIEF.md 與 schema.sql，再改程式。
```

---

## 13. 相關文件索引

| 檔案 | 內容 |
|------|------|
| `docs/01_商業計畫總整理.md` | 商業模式、定價、OAuth 接口表 |
| `docs/02_第0階段執行清單.md` | 早期執行清單 |
| `docs/03_構想階段_節點與無痕設計.md` | 節點出口／無痕 |
| `docs/04_Node_Agent_MVP.md` | Node Agent MVP |
| `docs/research-v2-phase4-report.md` | Research Phase 4 |
| `docs/live-e2e/*` | 線上／離線 E2E 與新聞品質報告 |
| `AGENTS.md` | Next agent 規則提示 |
