# 供給者 Node Agent

主動 HTTPS Long Poll 連到平台，在本機執行已獲准模型。  
**不需**公開住宅 IP、Port Forward、住宅代理；**不做**指紋／UA／TLS 偽裝；**不是**任意流量 Proxy。

## 快速開始

```bash
# 終端 1：平台
npm run dev

# 終端 2：節點
npm run node-agent -- register
npm run node-agent -- start
```

聊天選 **Node Agent · Mock** 送測試訊息。

## 指令

| 指令 | 說明 |
|---|---|
| `register` | 向平台註冊，credential 寫入 `data/node-agent/config.json` |
| `start` | 心跳 15s + long poll 接單 |
| `pause` / `resume` | 停止／恢復接單 |
| `revoke` | 撤銷節點 |

選用能力：`--with-antigravity`、`--with-codex`、`--with-openai-api`

## 本機憑證（不上傳平台）

- Antigravity：`data/node-local-creds/antigravity.json` 或 `ANTIGRAVITY_CREDS_FILE`
- ChatGPT Codex：`data/node-local-creds/chatgpt.json` 或 `CHATGPT_CREDS_FILE`
- OpenAI API：環境變數 `OPENAI_API_KEY`
