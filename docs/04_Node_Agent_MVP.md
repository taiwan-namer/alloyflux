# Node Agent MVP

## 最小修改清單（Phase 1）

| 項目 | 作法 |
|---|---|
| 舊 `supplier-node` OAuth claim | 退役；改 `apps/node-agent` |
| DB | schema v7：accounts／nodes／capabilities／heartbeats／jobs／attempts／earnings／settlements |
| Gateway | 買家任務優先 enqueue → Agent；`oauth_sub` 不進正式路徑 |
| Ledger | 買家扣點與供給者收益分開、冪等（settlement_key／job_id UNIQUE） |
| UI | `/nodes` 狀態頁；`/sources` 僅訂閱研究 |

## 端到端

1. `npm run dev`
2. `npm run node-agent -- register && npm run node-agent -- start`
3. `/nodes` 顯示 Online
4. 聊天選 **Node Agent · Mock**
5. 平台派工 → Agent mock 執行 → 回傳 → Usage + 收益

## 安全邊界

- 平台不存供給者模型 API Key／OAuth
- 任務不可執行 Shell、不可任意 URL／SSRF
- 請求大小／逾時／並行限制
- 不做指紋、IP 輪換、UA／TLS 偽裝
- 非住宅 Proxy
