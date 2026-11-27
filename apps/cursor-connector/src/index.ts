/**
 * AlloyFlux Cursor Connector
 *
 * 給付費用戶的常駐連線（不是手動五分鐘盲爬）：
 * - GET /api/strategy/dispatch?status=dispatched&waitMs=25000
 * - 有指令立刻印出並寫入信箱檔
 * - HTTP／網路錯誤只退避重試，永不因「會議室紅字」或空列表退出
 *
 * 環境變數：
 *   ALLOYFLUX_URL       預設 https://alloyflux.vercel.app
 *   ALLOYFLUX_API_KEY   sk_live_…（必填）
 *   DISPATCH_WAIT_MS    預設 25000
 *   DISPATCH_MAILBOX    預設 ./alloyflux-dispatch-mailbox.jsonl
 */

const BASE = (process.env.ALLOYFLUX_URL || "https://alloyflux.vercel.app").replace(/\/$/, "");
const KEY = process.env.ALLOYFLUX_API_KEY?.trim() || "";
const WAIT_MS = Math.min(Math.max(Number(process.env.DISPATCH_WAIT_MS || 25_000) || 25_000, 1_000), 55_000);
const MAILBOX = process.env.DISPATCH_MAILBOX || "alloyflux-dispatch-mailbox.jsonl";

type DispatchItem = {
  id: string;
  sessionId?: string;
  sessionName?: string;
  instruction?: unknown;
  status?: string;
  createdAt?: number;
};

function log(msg: string) {
  console.log(`[connector ${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function appendMailbox(items: DispatchItem[]) {
  const { appendFile } = await import("node:fs/promises");
  const lines = items.map((it) =>
    JSON.stringify({
      receivedAt: Date.now(),
      id: it.id,
      sessionId: it.sessionId,
      sessionName: it.sessionName,
      instruction: it.instruction,
    }),
  );
  await appendFile(MAILBOX, `${lines.join("\n")}\n`, "utf8");
}

async function waitOnce(): Promise<DispatchItem[]> {
  const url = `${BASE}/api/strategy/dispatch?status=dispatched&waitMs=${WAIT_MS}&limit=50`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WAIT_MS + 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
      },
      signal: ac.signal,
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      items?: DispatchItem[];
    };
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return Array.isArray(data.items) ? data.items : [];
  } finally {
    clearTimeout(timer);
  }
}

async function listenLoop() {
  if (!KEY.startsWith("sk_")) {
    console.error("請設定 ALLOYFLUX_API_KEY=sk_live_…（帳號頁 API Key）");
    process.exit(1);
  }
  log(`listening ${BASE} waitMs=${WAIT_MS} mailbox=${MAILBOX}`);
  let backoff = 1_000;
  for (;;) {
    try {
      const items = await waitOnce();
      backoff = 1_000;
      if (!items.length) {
        // 空列表＝正常超時，立刻再連（長輪詢本體）
        continue;
      }
      log(`got ${items.length} instruction(s)`);
      for (const it of items) {
        const preview =
          typeof it.instruction === "string"
            ? it.instruction.slice(0, 120)
            : JSON.stringify(it.instruction ?? null).slice(0, 120);
        log(`- ${it.id} @${it.sessionName || it.sessionId || "?"} ${preview}`);
      }
      await appendMailbox(items);
      log(`appended to ${MAILBOX}（請在 Cursor 依信箱執行後呼叫 POST /api/strategy/dispatch/:id/done）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 紅字／網路／401：只重試，不退出（避免「一次失敗就停住五分鐘排程」）
      log(`wait failed: ${msg}; retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

const cmd = process.argv[2] || "listen";
if (cmd === "listen" || cmd === "start") {
  void listenLoop();
} else {
  console.error(`未知指令：${cmd}（可用 listen）`);
  process.exit(1);
}
