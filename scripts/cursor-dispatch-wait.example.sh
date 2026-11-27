#!/usr/bin/env bash
# 簡易長輪詢（開發用）。付費用戶請改用：
#   ALLOYFLUX_API_KEY=sk_live_… npm run cursor-connector
set -uo pipefail
BASE="${ALLOYFLUX_URL:-https://alloyflux.vercel.app}"
KEY="${ALLOYFLUX_API_KEY:?set ALLOYFLUX_API_KEY}"
WAIT_MS="${DISPATCH_WAIT_MS:-25000}"
BACKOFF=1

echo "listening for dispatched instructions (waitMs=${WAIT_MS})…"
while true; do
  if ! RESP="$(curl -fsS -H "Authorization: Bearer ${KEY}" \
    "${BASE%/}/api/strategy/dispatch?status=dispatched&waitMs=${WAIT_MS}" 2>/tmp/af-dispatch-err)"; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) wait failed: $(cat /tmp/af-dispatch-err 2>/dev/null); retry ${BACKOFF}s"
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF < 30 ? BACKOFF * 2 : 30 ))
    continue
  fi
  BACKOFF=1
  COUNT="$(printf '%s' "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items') or []))" 2>/dev/null || echo 0)"
  if [[ "$COUNT" -gt 0 ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) got ${COUNT} item(s)"
    printf '%s\n' "$RESP"
  fi
done
