# Research V2 Phase 4 — 第一輪 Live E2E 對照報告

> 受控 Live：1 題 × 3 模型 × 各 1 次完整回答。本機 sqlite OAuth + `SUPPLIER_NODE_MODE=1`，**未寫正式 DB、未部署、未重試**。

| 項目 | 值 |
|---|---|
| 開始 | 2026-11-15T16:09:38.190Z |
| 結束 | 2026-11-15T16:11:08.017Z |
| 問題 | 請整理 NVIDIA 最近 7 天最重要的 3 則新聞，附上發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。 |

## 總表

| 模型 | 路徑 | finish / completion | 延遲 | In / Out Token | 價目估算 USD | 來源數 | V2 重用 |
|---|---|---|---:|---|---:|---:|---|
| GPT-6 Astra | research_v2 | completed / truncated | 23111 ms | 1809 / 716 | 0.016167 | 12 | true |
| Claude Opus 5.5 · Medium | research_v2 | completed / truncated | 18942 ms | 2636 / 1676 | 0.033048 | 12 | true |
| Gemini 4 Argon · Medium | gemini_native_search | completed / truncated | 40672 ms | 1099 / 2591 | 0.042162 | 21 | n/a（原生搜尋） |

## Research V2（Astra／Claude 共用，僅 1 次 Flash）

- Flash 呼叫：**1**
- Gate：`partial` → completionStatus：`truncated`
- 原始來源 12／去重 12／抓頁 4
- 正文 provenance：**8**；有 publishedAt：**0**
- Collector 事件數：**8**
- 注入估算 tokens：**567**（指紋 `e1f819d2dda8bbda`）
- 研究耗時：7099 ms
- 費用：Flash／抓頁為訂閱配額消耗；無供應商帳單拆帳（`unavailableActualUsage`）

### 事件主題（殘餘問題）

多筆 NVIDIA Newsroom／CEO Transition 被標成 topic=`diplomacy`（規則誤判，**不是**川普選舉）。「未誤分為川普選舉」驗收通過。

- [body_missing_date] (diplomacy) NVIDIA Announces CEO Transition | NVIDIA Newsroom
- [body_missing_date] (other) nvda-20261111
- [body_missing_date] (diplomacy) Statement From NVIDIA Board of Directors | NVIDIA Newsroom
- [body_missing_date] (other) sec.gov
- [body_missing_date] (diplomacy) A Message to Our Company | NVIDIA Newsroom
- [body_missing_date] (diplomacy) nvidia.com
- [title_only] (other) theguardian.com
- [title_only] (other) maaal.com

### 來源樣本（證據層級）

- **article_body**｜publishedAt=unknown｜nvidia.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEVzncYsVjoiHRQWd3XttRS2ACmMvgyEzAfr1EfuCRICXfU5piKpzORn0Jcq-ipqmwyA-exe-KXjYkLcRqQv0II-AM55WGDwTBoFdPAqOzCarMTN5dz67OH66VdDu8SdZW9cr8Y9AGDtEV02gz2yUMiG_9XoXSS91E=
- **article_body**｜publishedAt=unknown｜sec.gov｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGULH8AExNArfZJuKG_eVtUDF0UrKMETjM85YvlyQepSX25c60G3CMDL35M-nt_2kMDMI3M8I5KVI0lQZgSalW_8CtwzkTDHWgRmMjQ7a7F1DFq2LD8Vbkv6OB_8qUUZyHN1vn0TBPW0-yAOifM0LURo2dxMTPDjX7-wEH0-vwEzhBFub-6UvYHDLw=
- **article_body**｜publishedAt=unknown｜nvidia.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHX0ZaQ9Jr2wv0wEIL66sRXGw6M5orCN075ibbqTqeT-Y5hhcuO8_9QyTujpLXgjpai0gJziwyINb3Uwf_Eo0cx3K1BEjWGE-GeHmeUczYFTmgj7gA3ZTUG6EIY03QUnJ97h5V4XU0hL2IGQVpKiUv0UBpsbGWNCiAwiw7u6WE2vyk=
- **article_body**｜publishedAt=unknown｜nvidia.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEZyH-JMrI3cM8falx-bF8kSgT1XloRfgpWKgWwyoTTqD8g34EhFSwdDfC-R63ypKCgv57-tlbSgNXpF4LlDstH1AVh4RiCgP4FfpcMVrYZ-ODBA5eeOafWHHUeo-KHX-mJfHj2lD-9A-mRXCB0Rc4yNA==
- **title_only**｜publishedAt=unknown｜theguardian.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGjvjWYy77AZ-sC7gN9MY_ZlTiNCGUKsCpyE0EkhT18IanORPyfXn7rbIYjjmjEE7N6aSZduhmhWSTSwiardibUi_BhT2tGUswz5ezCSgrN-Yo6iYV5wxdgRlDC2x4L4f3fJGkms-VD4mJRJyWfwsDRlI7dAS3C09j3JxaeMDHh3jYQezMT
- **title_only**｜publishedAt=unknown｜maaal.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG7CQQe8SWrg542qPEBqosnHn6QzlG7K1OH0Nlpy_ovWWa7lTh9qwjH79IIxROOPT3jqunQMSlyU2t-DNDPxHmhOA1UKIz78LXk_pLKutewKFVe_VmyKg10xlkmtFqTPLgNr13rpNqm9xyvA3jrW8b4dBs=
- **title_only**｜publishedAt=unknown｜tradingkey.com｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHl4sJqY2WJxfhWr2g0c6XWnR6c6sHtZ85X2u5bkS0XOaEVlAU-Zz5iMMBHSutMJ86dVaVzwS5waunKJPXNi7rBI3CaWHb2uZAAqdO97wwA2TEFiwVMghk2Jw-4_DkrXLtKp43hOwPtC1HvNHZt03co1Ozod-pLf19S2gxZ8N76L2umEo-LO23CYPyAGgcnscRtoSwvIfpkaFtZRlfB_VftG8ptjtu2rlAe9PzSu_ZaKBKVS5CxQVxtH3KhVR3W4Z34he8=
- **title_only**｜publishedAt=unknown｜wealthprofessional.ca｜https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHvlByBpu1X4dmNM1b9zKYQ9Vrk44ZXRccrwzmZtN6EcXUWveLTVpYUCtKUrgKBadkJymBlX1zdSC2fGqPPEtmM2sBz3cc6hV6AlFOn2_xwp0KB51YgY5-4WlttNF_v4d2fmhN9whkE-0BnDSDGcJbc2zDgCnA4m2G5MMEi0S2xh8ZHD-axsoVgxbTPWf2T2TTffVhCv6zvGReV-3xoQWZKXXvGpORySWgiw-ahXGDCI0yjoQeM

## 模型分述

### astra — gpt-6-astra

- finishReason: `completed`
- completionStatus: `truncated`（反映研究 Gate=partial；**非**回答串流截斷）
- 延遲: 23111 ms
- Tokens: input=1809, cached=0, output=716
- 價目估算 USD: 0.016167（訂閱 OAuth 實際扣配額％）
- Prepared Research 重用: **true**；未偵測雙重注入
- 壞連結: 0；截斷疑慮: false；川普誤分類: false

#### 最終回答

**目前提供的檢索資料不足以可靠列出 NVIDIA「最近 7 天最重要的 3 則新聞」。**資料僅包含兩個官方新聞頁面的標題，以及一份 SEC 文件的表頭片段；缺少可確認的發布日期與新聞正文。以下列出 **3 筆待核對資料**，不將它們冒充已完整查證的三則獨立新聞。

本輪檢索標示的時間窗為 **2026/11/09–2026/11/16（台北時間）**；這是搜尋範圍，**不代表以下來源均已確認在該期間發布**。

| 資料／來源網址 | 發布日期 | 目前可核對的內容 | 證據限制 |
|---|---|---|---|
| **NVIDIA Announces CEO Transition** — [NVIDIA Newsroom](https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition) | **未提供，無法確認** | 回傳頁面標題為「NVIDIA Announces CEO Transition」（NVIDIA 宣布執行長交接）。 | **只有標題與網站導覽片段，沒有可用的新聞正文。**無法核對交接人選、原因、生效日或其他安排；不能僅憑標題斷言相關細節。 |
| **Form 8-K：nvda-20261111** — [SEC 文件](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000082/nvda-20261111.htm) | **未確認**；表頭出現 `2026-11-11`，但不足以認定為發布日期 | 可見片段包含 `FORM 8-K`、公司識別碼 `0001045810` 與日期字串 `2026-11-11`。 | **有文件表頭片段，但沒有實質申報內容。**無法確認申報事項，也不能推定它與執行長交接有關。 |
| **Statement From NVIDIA Board of Directors** — [NVIDIA Newsroom](https://nvidianews.nvidia.com/news/statement-from-nvidia-board-of-directors) | **未提供，無法確認** | 回傳頁面標題為「Statement From NVIDIA Board of Directors」（NVIDIA 董事會聲明）。 | **只有標題與網站導覽片段，沒有可用的聲明正文。**無法核對聲明主題、董事會立場，或它是否與上述交接消息屬於同一事件。 |

### 查證結論
- **無法可靠排名「最重要」**：缺少內容，無從比較影響程度。
- **無法確認是三則獨立新聞**：新聞稿、董事會聲明與 8-K 可能涉及同一事件，但目前證據不能證實。
- **沒有足夠證據支持人事異動細節**：目前不能據此聲稱誰離任、誰接任，或何時生效。

因此，這份清單應視為**三筆來源線索，而非已完成核實的近七日新聞摘要**。

#### 展示來源

- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEVzncYsVjoiHRQWd3XttRS2ACmMvgyEzAfr1EfuCRICXfU5piKpzORn0Jcq-ipqmwyA-exe-KXjYkLcRqQv0II-AM55WGDwTBoFdPAqOzCarMTN5dz67OH66VdDu8SdZW9cr8Y9AGDtEV02gz2yUMiG_9XoXSS91E=)
- ✓ [sec.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGULH8AExNArfZJuKG_eVtUDF0UrKMETjM85YvlyQepSX25c60G3CMDL35M-nt_2kMDMI3M8I5KVI0lQZgSalW_8CtwzkTDHWgRmMjQ7a7F1DFq2LD8Vbkv6OB_8qUUZyHN1vn0TBPW0-yAOifM0LURo2dxMTPDjX7-wEH0-vwEzhBFub-6UvYHDLw=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHX0ZaQ9Jr2wv0wEIL66sRXGw6M5orCN075ibbqTqeT-Y5hhcuO8_9QyTujpLXgjpai0gJziwyINb3Uwf_Eo0cx3K1BEjWGE-GeHmeUczYFTmgj7gA3ZTUG6EIY03QUnJ97h5V4XU0hL2IGQVpKiUv0UBpsbGWNCiAwiw7u6WE2vyk=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEZyH-JMrI3cM8falx-bF8kSgT1XloRfgpWKgWwyoTTqD8g34EhFSwdDfC-R63ypKCgv57-tlbSgNXpF4LlDstH1AVh4RiCgP4FfpcMVrYZ-ODBA5eeOafWHHUeo-KHX-mJfHj2lD-9A-mRXCB0Rc4yNA==)
- ✓ [theguardian.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGjvjWYy77AZ-sC7gN9MY_ZlTiNCGUKsCpyE0EkhT18IanORPyfXn7rbIYjjmjEE7N6aSZduhmhWSTSwiardibUi_BhT2tGUswz5ezCSgrN-Yo6iYV5wxdgRlDC2x4L4f3fJGkms-VD4mJRJyWfwsDRlI7dAS3C09j3JxaeMDHh3jYQezMT)
- ✓ [maaal.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG7CQQe8SWrg542qPEBqosnHn6QzlG7K1OH0Nlpy_ovWWa7lTh9qwjH79IIxROOPT3jqunQMSlyU2t-DNDPxHmhOA1UKIz78LXk_pLKutewKFVe_VmyKg10xlkmtFqTPLgNr13rpNqm9xyvA3jrW8b4dBs=)
- ✓ [tradingkey.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHl4sJqY2WJxfhWr2g0c6XWnR6c6sHtZ85X2u5bkS0XOaEVlAU-Zz5iMMBHSutMJ86dVaVzwS5waunKJPXNi7rBI3CaWHb2uZAAqdO97wwA2TEFiwVMghk2Jw-4_DkrXLtKp43hOwPtC1HvNHZt03co1Ozod-pLf19S2gxZ8N76L2umEo-LO23CYPyAGgcnscRtoSwvIfpkaFtZRlfB_VftG8ptjtu2rlAe9PzSu_ZaKBKVS5CxQVxtH3KhVR3W4Z34he8=)
- ✓ [wealthprofessional.ca](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHvlByBpu1X4dmNM1b9zKYQ9Vrk44ZXRccrwzmZtN6EcXUWveLTVpYUCtKUrgKBadkJymBlX1zdSC2fGqPPEtmM2sBz3cc6hV6AlFOn2_xwp0KB51YgY5-4WlttNF_v4d2fmhN9whkE-0BnDSDGcJbc2zDgCnA4m2G5MMEi0S2xh8ZHD-axsoVgxbTPWf2T2TTffVhCv6zvGReV-3xoQWZKXXvGpORySWgiw-ahXGDCI0yjoQeM)
- ✓ [NVIDIA Announces CEO Transition | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition)
- ✓ [nvda-20261111](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000082/nvda-20261111.htm)
- ✓ [Statement From NVIDIA Board of Directors | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/statement-from-nvidia-board-of-directors)
- ✓ [A Message to Our Company | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/a-message-to-our-company)

### claude — agy-claude-opus-5-5-medium

- finishReason: `completed`
- completionStatus: `truncated`（反映研究 Gate=partial；**非**回答串流截斷）
- 延遲: 18942 ms
- Tokens: input=2636, cached=0, output=1676
- 價目估算 USD: 0.033048（訂閱 OAuth 實際扣配額％）
- Prepared Research 重用: **true**；未偵測雙重注入
- 壞連結: 0；截斷疑慮: false；川普誤分類: false

#### 最終回答

## 結論

這輪檢索**只找到 3 筆來源**，而且很可能都屬於**同一件事（CEO 交接）**，不是 3 則獨立新聞。三筆都**沒有讀到正文**，所以無法告訴你新任 CEO 是誰、何時生效或交接原因。

## 檢索到的 3 筆來源

| # | 標題 | 來源 | 發布日期 | 證據狀態 |
|---|---|---|---|---|
| 1 | NVIDIA Announces CEO Transition | [NVIDIA Newsroom](https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition) | **未提供** | ⚠️ **只有標題**，擷取內容只是網站導覽列文字 |
| 2 | Statement From NVIDIA Board of Directors | [NVIDIA Newsroom](https://nvidianews.nvidia.com/news/statement-from-nvidia-board-of-directors) | **未提供** | ⚠️ **只有標題**，同上 |
| 3 | Form 8-K（nvda-20261111） | [SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000082/nvda-20261111.htm) | 文件標頭顯示 **2026-11-11** | ⚠️ **只有表頭**，沒有讀到申報項目內文 |

## 目前可以核對的事實

- NVIDIA 官方新聞室有一篇標題為「**NVIDIA Announces CEO Transition**」的公告。
- NVIDIA 官方新聞室另有一篇「**Statement From NVIDIA Board of Directors**」。
- NVIDIA（CIK 0001045810）向 SEC 提交了一份 **8-K**，文件標頭日期為 **2026-11-11**。

## 目前無法確認的事

- **誰接任 CEO**、黃仁勳的新角色、生效日期與交接原因，來源正文都沒有讀到。
- 兩篇新聞室文章的**實際發布日**。所以也無法確認它們是否落在你要的 7 天內。
- **8-K 的申報項目**。高層異動通常會用 Item 5.02 申報，但我沒有讀到內文，所以不能斷定這份 8-K 就是在申報 CEO 交接。
- 8-K 標頭的 2026-11-11 可能是「最早事件發生日」，不一定等於送件日。
- 這 7 天內其他 NVIDIA 新聞，例如財報、產品或出口管制，**本輪沒有檢索結果**。我不會自行補上。

## 建議你自行核對

1. 打開 **8-K 連結**，查看 Item 編號，以及 5.02 段落有沒有寫姓名和生效日。這是法律效力最高的來源。
2. 查看兩篇新聞室文章頂部的**發布日期**和第一段內文。
3. 如果需要「3 則獨立新聞」，可以再問我一次，例如指定「財報」或「產品」等主題，讓系統重新檢索。

#### 展示來源

- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEVzncYsVjoiHRQWd3XttRS2ACmMvgyEzAfr1EfuCRICXfU5piKpzORn0Jcq-ipqmwyA-exe-KXjYkLcRqQv0II-AM55WGDwTBoFdPAqOzCarMTN5dz67OH66VdDu8SdZW9cr8Y9AGDtEV02gz2yUMiG_9XoXSS91E=)
- ✓ [sec.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGULH8AExNArfZJuKG_eVtUDF0UrKMETjM85YvlyQepSX25c60G3CMDL35M-nt_2kMDMI3M8I5KVI0lQZgSalW_8CtwzkTDHWgRmMjQ7a7F1DFq2LD8Vbkv6OB_8qUUZyHN1vn0TBPW0-yAOifM0LURo2dxMTPDjX7-wEH0-vwEzhBFub-6UvYHDLw=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHX0ZaQ9Jr2wv0wEIL66sRXGw6M5orCN075ibbqTqeT-Y5hhcuO8_9QyTujpLXgjpai0gJziwyINb3Uwf_Eo0cx3K1BEjWGE-GeHmeUczYFTmgj7gA3ZTUG6EIY03QUnJ97h5V4XU0hL2IGQVpKiUv0UBpsbGWNCiAwiw7u6WE2vyk=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEZyH-JMrI3cM8falx-bF8kSgT1XloRfgpWKgWwyoTTqD8g34EhFSwdDfC-R63ypKCgv57-tlbSgNXpF4LlDstH1AVh4RiCgP4FfpcMVrYZ-ODBA5eeOafWHHUeo-KHX-mJfHj2lD-9A-mRXCB0Rc4yNA==)
- ✓ [theguardian.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGjvjWYy77AZ-sC7gN9MY_ZlTiNCGUKsCpyE0EkhT18IanORPyfXn7rbIYjjmjEE7N6aSZduhmhWSTSwiardibUi_BhT2tGUswz5ezCSgrN-Yo6iYV5wxdgRlDC2x4L4f3fJGkms-VD4mJRJyWfwsDRlI7dAS3C09j3JxaeMDHh3jYQezMT)
- ✓ [maaal.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG7CQQe8SWrg542qPEBqosnHn6QzlG7K1OH0Nlpy_ovWWa7lTh9qwjH79IIxROOPT3jqunQMSlyU2t-DNDPxHmhOA1UKIz78LXk_pLKutewKFVe_VmyKg10xlkmtFqTPLgNr13rpNqm9xyvA3jrW8b4dBs=)
- ✓ [tradingkey.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHl4sJqY2WJxfhWr2g0c6XWnR6c6sHtZ85X2u5bkS0XOaEVlAU-Zz5iMMBHSutMJ86dVaVzwS5waunKJPXNi7rBI3CaWHb2uZAAqdO97wwA2TEFiwVMghk2Jw-4_DkrXLtKp43hOwPtC1HvNHZt03co1Ozod-pLf19S2gxZ8N76L2umEo-LO23CYPyAGgcnscRtoSwvIfpkaFtZRlfB_VftG8ptjtu2rlAe9PzSu_ZaKBKVS5CxQVxtH3KhVR3W4Z34he8=)
- ✓ [wealthprofessional.ca](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHvlByBpu1X4dmNM1b9zKYQ9Vrk44ZXRccrwzmZtN6EcXUWveLTVpYUCtKUrgKBadkJymBlX1zdSC2fGqPPEtmM2sBz3cc6hV6AlFOn2_xwp0KB51YgY5-4WlttNF_v4d2fmhN9whkE-0BnDSDGcJbc2zDgCnA4m2G5MMEi0S2xh8ZHD-axsoVgxbTPWf2T2TTffVhCv6zvGReV-3xoQWZKXXvGpORySWgiw-ahXGDCI0yjoQeM)
- ✓ [NVIDIA Announces CEO Transition | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition)
- ✓ [nvda-20261111](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000082/nvda-20261111.htm)
- ✓ [Statement From NVIDIA Board of Directors | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/statement-from-nvidia-board-of-directors)
- ✓ [A Message to Our Company | NVIDIA Newsroom](https://nvidianews.nvidia.com/news/a-message-to-our-company)

### argon — gemini-4-argon-medium

- finishReason: `completed`
- completionStatus: `truncated`（反映研究 Gate=partial；**非**回答串流截斷）
- 延遲: 40672 ms
- Tokens: input=1099, cached=0, output=2591
- 價目估算 USD: 0.042162（訂閱 OAuth 實際扣配額％）
- 原生搜尋: **true**
- webSearchQueries: ["NVIDIA stock earnings November 2026","NVIDIA news November 2026","NVIDIA press release November 2026"]
- Grounding 來源數: 21（可點 https；無省略號截斷）
- 發布日期: 回答中有自述日期；共同契約未獨立核對每則 publishedAt
- 壞連結: 0；截斷疑慮: false；川普誤分類: false

#### 最終回答

NVIDIA 近期爆發了公司成立以來最劇烈的高層人事地震。過去 7 天（2026 年 11 月 8 日至 11 月 15 日）最關鍵的 3 則重大新聞如下（以下引用的來源皆包含完整正文與官方公告內容，無僅有標題之情況）：

---

### 1. 黃仁勳辭去執行長與董事職務，財務長 Colette Kress 接任代理執行長
* **發布日期**：2026 年 11 月 12 日（SEC Form 8-K 生效紀錄為 11 月 11 日）
* **來源網址**：[NVIDIA 官方新聞稿](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEpXInF9D4kHanN_8vMWlmnrjgOy_8Gt_zmSM28RyYIQWGfAmF1H6pUns7QSah92G2J3vJ2iebSCw9micc2X_vUUyHp7RXt57T4lrCKrUJndkA0OQcnJDdChkSAWSh4xH_slT0PAuUCIajQh4xH_slT0PAuUCIajQh6Lp_yWkdR2B6pMg9J8=) ｜ [美國證管會 SEC 8-K 文件](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEghxHyMqubRnYw6e1UP9FMlEOaPZMuuz0hTYai23w6XGtexTkCjNwLtQtlvn27kHJshEetNxhxmxNlRO3Ua4z3LkH0Lnv2VwUFb8_fcBLbCvZjIFJ_dXRYrX6iHRPW425OGeCT5H6Ev58Gm6n7MyJeJoyOgva4t58eXEHaP2VdHkTbo6VGHYcDhx4=)
* **可核對事實**：
  - **人事異動**：NVIDIA 董事會宣布創辦人黃仁勳（Jensen Huang）辭去總裁、執行長（CEO）及董事會成員職務，即刻生效。
  - **代理與接班安排**：現年 59 歲、自 2013 年 9 月起擔任執行副總裁暨財務長（CFO）的 Colette Kress 被任命為臨時執行長（同時保留 CFO 職務），直到董事會尋獲正式繼任者為止。
  - **新任董事長**：自 1993 年起擔任董事的 Harvey C. Jones（73 歲）被任命為公司史上首任董事會主席（Chair of the Board）。
  - **財報時程不變**：公司確認 2027 財年第三季（Q3 FY27）財報將按原定計畫於美西時間 11 月 17 日下午 1:20 公布，並於下午 2:00 舉行電話會議。

### 2. 董事會針對黃仁勳遭外國情報鎖定與私領域爭議啟動獨立調查
* **發布日期**：2026 年 11 月 8 日（11 月 10 日更新調查律師團隊）
* **來源網址**：[NVIDIA 董事會聲明 (11/8)](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEiEV_Az8naFuR4H2-IJVmVcw9juBHIiVMB6gABvMvee1yBtb6unSN931AGmssbxUkcxmjFGCtR6_GWu30tniWIw8smA7QEMVXn_SQInHXZyQSpA59jVvjN8QaI1JawRBgam-nXwQLSPbB9lYnFbdU11eMOtPX93djrm-Upitru_CY=) ｜ [NVIDIA 獨立董事聲明 (11/10)](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEE8zL1D5RC_6Fn-APsBDjoIzrSA2B9BXIH9X59YKfh5PxvLREjXXA8Ixv0i_6XFq6yRSSNfnHfMdXmQ7lKpI3HYNIpAbO_wyJgIKo3I08u1Cvdex4Zs8wqWJ-s7Pw7xUmfUM48MdhCUSpRdreuo3A0K3TWRoM9Df5GKW9YUDEoO-87VbhwfA4KXmPs7XcQImEmZw0=)
* **可核對事實**：
  - **調查起因**：針對媒體報導黃仁勳成為外國情報行動的鎖定目標（涉及其與一名被美方懷疑為中國間諜的女子 Alice Huang 之婚外情），NVIDIA 董事會於 11 月 8 日宣布由獨立董事組成委員會展開獨立調查；黃仁勳同日亦發出內部信向員工與家人致歉。
  - **保密評估**：董事會於聲明中強調，目前沒有理由相信美國國家安全或 NVIDIA 的商業機密遭到洩露。
  - **外部法律顧問**：11 月 10 日，獨立董事宣布聘請前美國紐約南區代理聯邦檢察官 Joon H. Kim 及其任職的 Wachtell, Lipton, Rosen & Katz 律師事務所主導這項獨立調查。

### 3. 重量級機構股東聯名致信董事會，呼籲考慮讓黃仁勳回歸並備戰 Q3 財報
* **發布日期**：2026 年 11 月 15 日
* **來源網址**：[Maaal 財經新聞 (引述 CNBC 報導)](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFcnRD-HIi4FK3jiEEfQKyewDdptqV7PndtXF380GThIygAVhKZH0mM39sJ25mI5jRkBReBEmhmopm0zvoYZR8sUr8w2JH7eS_Dour1ZjgF2sjmxlutMtUNunHqimQfQAlsLbfxcCVMXv_M8DXHQIy2MvM=) ｜ [MarketWatch 財報前瞻報導](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHiASXm6B1OIpmLSzEzQD3Se84wOzHxByNrXXyguaYBU9oAwmWLZ7CyiyI-hk7OCshmoJkT7OX5iJhVn0E59UmAYhIzVl-6H15eUM6yYZJeANS8rhuQbAL_sWcINmtOgvxqYV2oZa2LiaQyXgzG9w-T2pyEpAU0wPqLT53MSBu5UbqP4HPaBW7MvnRKYyGt1-bFapLLj3-6gjNPDG3FnzS73SKTUB189Z940uu841eBjeiP6So8u6kL8Kc7se-K_WASir7M)
* **可核對事實**：
  - **大股東聯名信**：兩大機構投資人——Altimeter Capital 執行長 Brad Gerstner 與 Atreides Management 的 Gavin Baker 在社群平台 X 發布致 NVIDIA 董事會的公開信，呼籲董事會在真相全盤水落石出前不要倉促替換領導人，應審慎評估包含「讓黃仁勳回歸（potential return of Jensen Huang）」在內的所有選項。
  - **持股規模**：根據截至 6 月 30 日的 SEC 申報資料，Altimeter 持有 940 萬股 NVIDIA 股票（價值約 19 億美元），Atreides 則持有 120 萬股（價值約 2.5 億美元）。
  - **市場與財報預期**：受高層危機影響，NVDA 股價於週五（11/13）收在 162.85 美元（單週下跌 12.75%）。華爾街正高度聚焦 11 月 17 日將公布的 Q3 財報，市場共識預期單季營收約為 108.8 億至 109 億美元（官方財測為 108 億美元 ±2%），調整後每股盈餘（EPS）預估約 2.47 至 2.48 美元。

*(註：若您還關注業務面的技術進展，NVIDIA 亦於 **11 月 9 日** 發布了與韓國 **SK Telecom 及 AI 晶片新創 Rebellions 合作** 的[官方新聞稿](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFvcO4LCXunIH5pU3sNQl3eZtysVab6MaRUM-3FsROf8NbPP2_8n4bf2cVJyhHky01jyz2uh4omP0bNMSWkwiZwQt3kDxMc1laaG147k2rTG5dwgw91pYs7Y7yP8wJecmq4Yi8iZTAM0lfgSN5ssFklWy_93eDmdi9TMDwZ8MY9LnRr5O3qIQ4QbHxO9lb47RnJTZCYjKdFFprd1LS67nsDnkAY_wyL5MPY6XCCYzjwAE0aiHlQCjOGzzE9GZ32TWejMoukzfXV2ZtroNbvhK6VmDeiRiDFME8ke9JMIHJ_KB6ADM1Q4ShXc16KOVQ2EiTNPS803AuayA==)，宣布採用 NVIDIA NVLink Fusion 將 Rebellions 的 R200 NPU 連接至 NVIDIA MGX 基礎設施，推進韓國主權 AI 建設。)*

#### 展示來源

- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEpXInF9D4kHanN_8vMWlmnrjgOy_8Gt_zmSM28RyYIQWGfAmF1H6pUns7QSah92G2J3vJ2iebSCw9micc2X_vUUyHp7RXt57T4lrCKrUJndkA0OQcnJDdChkSAWSh4xH_slT0PAuUCIajQh6Lp_yWkdR2B6pMg9J8=)
- ✓ [sec.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEghxHyMqubRnYw6e1UP9FMlEOaPZMuuz0hTYai23w6XGtexTkCjNwLtQtlvn27kHJshEetNxhxmxNlRO3Ua4z3LkH0Lnv2VwUFb8_fcBLbCvZjIFJ_dXRYrX6iHRPW425OGeCT5H6Ev58Gm6n7MyJeJoyOgva4t58eXEHaP2VdHkTbo6VGHYcDhx4=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEiEV_Az8naFuR4H2-IJVmVcw9juBHIiVMB6gABvMvee1yBtb6unSN931AGmssbxUkcxmjFGCtR6_GWu30tniWIw8smA7QEMVXn_SQInHXZyQSpA59jVvjN8QaI1JawRBgam-nXwQLSPbB9lYnFbdU11eMOtPX93djrm-Upitru_CY=)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEE8zL1D5RC_6Fn-APsBDjoIzrSA2B9BXIH9X59YKfh5PxvLREjXXA8Ixv0i_6XFq6yRSSNfnHfMdXmQ7lKpI3HYNIpAbO_wyJgIKo3I08u1Cvdex4Zs8wqWJ-s7Pw7xUmfUM48MdhCUSpRdreuo3A0K3TWRoM9Df5GKW9YUDEoO-87VbhwfA4KXmPs7XcQImEmZw0=)
- ✓ [theguardian.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFENiJbTIv3SJIl2hL86nAUB0z9aoxD8kyHKr90r6GgKwbG4WELgqBPNbxaNMu1oCfUvhI4KluXYEnVw0G_GWqq8wc_zDYy77kUjUbYS0hPeVlKY1T1rfWrpEXmxIx4xNBZfOqiSEz8UutxuHd7JF2H4yWpiBRO8D-KHK17Dvb4WxIVPGcf)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFWsdqv-F8ni7fd0ujzoDgeT00aJch6EQRZ5ssscqKkb7u8HevupKoblUD5XmJ-dS44BrnlcfPlFq7VD6DwQ2LbhJKNGj3Zcmq7htyEEsAwg1_cPLzbYLuHtAucoZyxH5wd)
- ✓ [nvidia.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHA4xO_LvHSmNbBA1aTgFW61vSuS3uIkD0PFj-LFrICoQC-F0Y9eiyFc4mGt_bghVPbg0kvuj-fdaRV2ZKD0Wo4oU0HBsKw_kUgJnDfdwANio83GQTUzbYQ)
- ✓ [maaal.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFcnRD-HIi4FK3jiEEfQKyewDdptqV7PndtXF380GThIygAVhKZH0mM39sJ25mI5jRkBReBEmhmopm0zvoYZR8sUr8w2JH7eS_Dour1ZjgF2sjmxlutMtUNunHqimQfQAlsLbfxcCVMXv_M8DXHQIy2MvM=)
- ✓ [morningstar.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHiASXm6B1OIpmLSzEzQD3Se84wOzHxByNrXXyguaYBU9oAwmWLZ7CyiyI-hk7OCshmoJkT7OX5iJhVn0E59UmAYhIzVl-6H15eUM6yYZJeANS8rhuQbAL_sWcINmtOgvxqYV2oZa2LiaQyXgzG9w-T2pyEpAU0wPqLT53MSBu5UbqP4HPaBW7MvnRKYyGt1-bFapLLj3-6gjNPDG3FnzS73SKTUB189Z940uu841eBjeiP6So8u6kL8Kc7se-K_WASir7M)
- ✓ [admiralmarkets.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH8Y5-XBsUPrz8WvVrnsKBH7r_0cWSO6FrlDa-rBMK0HcOVbdwER1OOrKBZ2bWfuSb2spt3hN7g84qOW_U0qPmlh43G0WAVxnxYdJRm9b6vc_ij9ygPzSmTKNJHtFb8tlIGikZU9ozZFNiZmoG0GxSpm0XbcqYgVqq20Pju-lJe1CWvQ6kgjZXdZog4JTFrfKrAGkxn)
- ✓ [stonex.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEzZoxGozDfOyEe0g2Zy1jpe-BclWJlcENWQ1d4XS2tnCc5rya7SYf5O_zYmAHQtiR9xh5jumxC3qeHZt0swWFe7iZLC1Rxt40PQ8dgjAtHtcIq9pz1jx5EWg1azA3RJmZnbfosdtGlqIxZcx5pDs5jTBHlda-OjI_YE_-N8OMGcGPnm6Uo0GzBcKiblwREejLXXZm485-Phh0I45GIKtLwlIxhCU2Wt5qQuq7n)
- ✓ [openingbelldailynews.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHWF7zMaD2x65hFzxd8lnVNO1S15Xey5J6W3Z7-SRP9PPShfEf80YDUEKKGQ19exqGWhDKiLjZ10hfneRJrgPj-T1eP8gmUIekpWeU_w_bj27XszpwiGTyNS_jffOlqT92291m1frUw8-TXxkh4NzYKinS0vhoqRCN2aVgWC6YI66Qd7YKhN21NxFTSTtmq7873sqE=)

## 驗收對照

| 標準 | 結果 |
|---|---|
| 1 GPT／Claude 研究只注入一次 | **通過**（Flash=1；兩模型 reused=true） |
| 2 區分正文 vs 摘要 | **通過**（provenance；兩模型明確標只有標題） |
| 3 不得標題當已確認正文事實 | **通過**（Astra／Claude 拒斷言細節） |
| 4 不得誤分為川普選舉 | **通過** |
| 5 來源 URL 完整可點 | **通過**（皆 https，無 …；多為 grounding-api-redirect） |
| 6 搜尋失敗不得已查證 | **通過**（Gate=partial → completionStatus=truncated） |
| 7 回答截斷不得標正常完成 | **通過**（無串流截斷） |
| 8 研究與模型 Token 分開 | **通過**（研究估算 567；模型 in/out 分列） |

## 重要聲明：不得因 Gemini 條數多就判較準

- Gemini／Argon 細節最多，但連結多為 Google grounding redirect，**本輪未逐條人工打開原文核對**。
- Astra／Claude 在 V2 證據不足時保守拒答——符合 Gate／provenance，**不代表 Gemini 一定錯或一定對**。
- 重要新聞應另以 NVIDIA Newsroom／SEC EDGAR 原始頁核對後再比準確度。

## 殘餘風險

1. `publishedAt` 全數 unknown。
2. URL 常停在 `vertexaisearch.cloud.google.com/grounding-api-redirect/...`。
3. Collector 將部分 NVIDIA 企業新聞標成 `diplomacy`。
4. 無供應商美金帳單；僅價目估算 + 配額％。
5. DNS rebinding／連線釘選 IP 仍為已知限制。

## 原始檔

- `docs/live-e2e/phase4-live-round1-report.json`
- `docs/live-e2e/raw-{astra,claude,argon}.json`

**已停止。未部署。**