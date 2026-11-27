#!/usr/bin/env bash
# Cursor 常駐取指令（長輪詢）：有新 dispatched 立刻拿到，取代每五分鐘盲爬。
# 用法：
#   export ALLOYFLUX_URL=https://alloyflux.vercel.app
#   export ALLOYFLUX_API_KEY=sk_live_...
#   ./scripts/cursor-dispatch-wait.example.sh
set -euo pipefail
BASE="${ALLOYFLUX_URL:?set ALLOYFLUX_URL}"
KEY="${ALLOYFLUX_API_KEY:?set ALLOYFLUX_API_KEY}"
WAIT_MS="${DISPATCH_WAIT_MS:-25000}"

echo "listening for dispatched instructions (waitMs=${WAIT_MS})…"
while true; do
  RESP="$(curl -fsS -H "Authorization: Bearer ${KEY}" \
    "${BASE}/api/strategy/dispatch?status=dispatched&waitMs=${WAIT_MS}")"
  COUNT="$(printf '%s' "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items') or []))")"
  if [[ "$COUNT" -gt 0 ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) got ${COUNT} item(s)"
    printf '%s\n' "$RESP"
    # 在此交給 Cursor／本地 agent 執行，完成後呼叫：
    # POST /api/strategy/dispatch/:id/done
  fi
done
