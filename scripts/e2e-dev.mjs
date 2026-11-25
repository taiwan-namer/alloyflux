#!/usr/bin/env node
/**
 * E2E 隔離啟動閘門（Gate1 fix2）。
 *
 * - 根目錄名稱含 .git → 拒；任何以 .env 開頭檔名 → 拒
 * - 遞迴 lstat：symbolic link／junction → 拒（不跟隨、不讀內容）
 * - 禁鍵只要 Object.keys 出現（Windows 不分大小寫；空／空白也拒）
 * - child env：空物件＋系統必要鍵＋固定 E2E 鍵；禁止 ...process.env
 * - nextBin：lstatSync 必須 isFile 且非 symlink
 * - 本輪禁止真正啟動 Next 做驗收
 */

import { spawn } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "SUPABASE_DB_URL",
  "OAUTH_CLOUD_API_BASE",
];

const SYSTEM_ENV_KEYS = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function reject(reason) {
  console.error(`[e2e-dev] REJECT: ${reason}`);
  process.exit(1);
}

function envKeyMap(envObj) {
  const map = new Map();
  for (const key of Object.keys(envObj)) {
    map.set(key.toLowerCase(), key);
  }
  return map;
}

function readSystemEnv(name, envObj = process.env) {
  const map = envKeyMap(envObj);
  const actual = map.get(name.toLowerCase());
  if (!actual) return undefined;
  const val = envObj[actual];
  return typeof val === "string" ? val : undefined;
}

function isLinkStat(st) {
  try {
    if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  // Windows junction／reparse：部分 Node 版本以 isSymbolicLink 回報；保守再看 mode 無法可靠時仍依 isSymbolicLink
  return false;
}

/** 遞迴巡覽；遇 symlink／junction／lstat 失敗即拒。不跟隨連結、不讀檔內容。 */
export function assertNoLinksInTree(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      reject("unable to read directory listing in isolation tree");
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        reject("unable to lstat path in isolation tree");
        return;
      }
      if (isLinkStat(st)) {
        reject("symlink or junction is not allowed in isolation tree");
        return;
      }
      if (st.isDirectory()) stack.push(full);
    }
  }
}

export function assertIsolationGate(cwd, envObj = process.env) {
  if (envObj.E2E_ISOLATION !== "1") {
    reject("E2E_ISOLATION must be exactly 1");
  }

  let rootNames;
  try {
    rootNames = readdirSync(cwd);
  } catch {
    reject("unable to read cwd directory listing");
    return;
  }

  if (rootNames.some((n) => n.toLowerCase() === ".git")) {
    reject("cwd contains .git; use a temp copy without git metadata");
  }

  for (const name of rootNames) {
    if (name.toLowerCase().startsWith(".env")) {
      reject(`forbidden env file present: ${name}`);
    }
  }

  const present = envKeyMap(envObj);
  for (const key of FORBIDDEN_ENV_KEYS) {
    if (present.has(key.toLowerCase())) {
      reject(`forbidden env key is set: ${key}`);
    }
  }

  assertNoLinksInTree(cwd);
}

export function resolveBindHost(envObj = process.env) {
  const raw = envObj.E2E_BIND_HOST;
  const host = (raw === undefined || raw === null ? "127.0.0.1" : String(raw)).trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    reject("bind host must be loopback");
  }
  if (host === "localhost") return "127.0.0.1";
  return host;
}

export function resolvePort(envObj = process.env) {
  const raw = envObj.E2E_PORT;
  if (raw === undefined || raw === null) return "3456";
  const text = String(raw);
  if (text.trim() === "") {
    reject("E2E_PORT must be a decimal integer 1..65535");
  }
  if (!/^\d+$/.test(text.trim())) {
    reject("E2E_PORT must be a decimal integer 1..65535");
  }
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    reject("E2E_PORT must be a decimal integer 1..65535");
  }
  return String(n);
}

/**
 * 從空物件建立子行程 env；輸出鍵名標準化為 SYSTEM_ENV_KEYS 寫法。
 */
export function buildChildEnv(host, envObj = process.env) {
  const child = Object.create(null);
  for (const name of SYSTEM_ENV_KEYS) {
    const val = readSystemEnv(name, envObj);
    if (val !== undefined) child[name] = val;
  }
  child.E2E_ISOLATION = "1";
  child.HOSTNAME = host;
  child.NODE_ENV = "development";
  child.NEXT_TELEMETRY_DISABLED = "1";
  return child;
}

function assertNextBinaryFile(nextBin) {
  let st;
  try {
    st = lstatSync(nextBin);
  } catch {
    reject("next binary missing or unreadable at node_modules/next/dist/bin/next");
    return;
  }
  if (isLinkStat(st) || !st.isFile()) {
    reject("next binary must be a regular file (not a directory or symlink)");
  }
}

export function runCli(argv = process.argv, envObj = process.env, spawnImpl = spawn) {
  const cwd = process.cwd();
  assertIsolationGate(cwd, envObj);

  const host = resolveBindHost(envObj);
  const port = resolvePort(envObj);
  const childEnv = buildChildEnv(host, envObj);

  const checkOnly = argv.includes("--check-only");
  if (checkOnly) {
    console.log("[e2e-dev] OK: isolation gate passed (--check-only)");
    return { checkOnly: true, host, port, childEnv };
  }

  const nextBin = resolve(cwd, "node_modules", "next", "dist", "bin", "next");
  assertNextBinaryFile(nextBin);

  console.log(`[e2e-dev] starting next on loopback port ${port} (E2E_ISOLATION=1)`);
  let child;
  try {
    child = spawnImpl(process.execPath, [nextBin, "dev", "-H", host, "-p", port], {
      cwd,
      stdio: "inherit",
      env: childEnv,
    });
  } catch {
    console.error("[e2e-dev] REJECT: failed to spawn next");
    process.exit(1);
  }

  child.on("error", () => {
    console.error("[e2e-dev] REJECT: next process error");
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 1);
  });
  return { checkOnly: false, host, port, childEnv, child, nextBin };
}

const isDirectRun = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    return Boolean(entry) && self.toLowerCase() === entry.toLowerCase();
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runCli();
}
