#!/usr/bin/env node
/**
 * AlloyFlux Cursor 連線器（付費用戶版｜不必 clone 任何 repo）
 *
 * 安裝／啟動（在「要改的專案」資料夾開終端機也可以，或任意資料夾）：
 *
 *   curl -fsSL https://alloyflux.vercel.app/cursor-connector.mjs -o alloyflux-connect.mjs
 *   ALLOYFLUX_API_KEY='sk_live_你的金鑰' node alloyflux-connect.mjs
 *
 * 只負責向網站領「已派送」指令並寫入信箱；真正改檔請用 Cursor 開啟你的專案資料夾（如 automax）。
 */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE = (process.env.ALLOYFLUX_URL || "https://alloyflux.vercel.app").replace(/\/$/, "");
const KEY = process.env.ALLOYFLUX_API_KEY?.trim() || "";
const WAIT_MS = Math.min(Math.max(Number(process.env.DISPATCH_WAIT_MS || 25_000) || 25_000, 1_000), 55_000);
const MAILBOX = resolve(process.env.DISPATCH_MAILBOX || "alloyflux-dispatch-mailbox.jsonl");

function log(msg) {
  console.log(`[alloyflux-connect ${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitOnce() {
  const url = `${BASE}/api/strategy/dispatch?status=dispatched&waitMs=${WAIT_MS}&limit=50`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WAIT_MS + 15_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      signal: ac.signal,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return Array.isArray(data.items) ? data.items : [];
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!KEY.startsWith("sk_")) {
    console.error(`用法：
  curl -fsSL ${BASE}/cursor-connector.mjs -o alloyflux-connect.mjs
  ALLOYFLUX_API_KEY='sk_live_…' node alloyflux-connect.mjs

請先到 ${BASE} 帳號頁「Cursor / 第三方工具 API Key」新增金鑰。`);
    process.exit(1);
  }

  log(`listening ${BASE} waitMs=${WAIT_MS}`);
  log(`mailbox ${MAILBOX}`);
  log(`改檔請用 Cursor 開啟「你的專案資料夾」（連線器不綁定特定 repo）`);
  let backoff = 1_000;

  for (;;) {
    try {
      const items = await waitOnce();
      backoff = 1_000;
      if (!items.length) continue;
      log(`got ${items.length} instruction(s)`);
      for (const it of items) {
        const preview =
          typeof it.instruction === "string"
            ? it.instruction.slice(0, 120)
            : JSON.stringify(it.instruction ?? null).slice(0, 120);
        log(`- ${it.id} @${it.sessionName || it.sessionId || "?"} ${preview}`);
      }
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
      log(`written → ${MAILBOX}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`wait failed: ${msg}; retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

await main();
