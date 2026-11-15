#!/usr/bin/env node
/**
 * 供給者 Node Agent（主動 HTTPS Long Poll）
 *
 * 用法：
 *   npm run node-agent -- register [--platform http://127.0.0.1:3000]
 *   npm run node-agent -- start
 *   npm run node-agent -- pause | resume
 *   npm run node-agent -- revoke
 *
 * 憑證／API Key 只存在節點本機；不做住宅代理／指紋偽裝／任意 URL 轉發。
 */

import { resolveAdapter } from "./adapters";
import { AgentApi, verifyJobSignature } from "./client";
import { configPath, loadConfig, saveConfig, type AgentConfig } from "./config";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[`NODE_AGENT_${name.toUpperCase().replace(/-/g, "_")}`] || fallback;
}

function cmd(): string {
  return process.argv[2] || "start";
}

async function register() {
  const platform = arg("platform", "http://127.0.0.1:3000").replace(/\/$/, "");
  const label = arg("label", `本機節點 ${new Date().toISOString().slice(0, 10)}`);
  const maxConcurrency = Number(arg("max-concurrency", "2"));
  const dailyJobLimit = Number(arg("daily-limit", "500"));

  // 預設註冊 mock；可加 --with-antigravity / --with-codex / --with-openai-api
  const capabilities: { authSourceType: string; providerKey: string; modelId: string }[] = [
    { authSourceType: "mock", providerKey: "mock", modelId: "node-mock" },
  ];
  if (process.argv.includes("--with-antigravity")) {
    capabilities.push({
      authSourceType: "local_model",
      providerKey: "antigravity",
      modelId: "*",
    });
  }
  if (process.argv.includes("--with-codex")) {
    capabilities.push({
      authSourceType: "local_model",
      providerKey: "chatgpt-codex",
      modelId: "*",
    });
  }
  if (process.argv.includes("--with-openai-api")) {
    capabilities.push({
      authSourceType: "official_api",
      providerKey: "openai-api",
      modelId: "*",
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const regToken = process.env.AGENT_REGISTER_TOKEN?.trim();
  if (regToken) headers.Authorization = `Bearer ${regToken}`;

  const res = await fetch(`${platform}/api/agent/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      label,
      maxConcurrency,
      dailyJobLimit,
      capabilities,
    }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    nodeId?: string;
    credential?: string;
    error?: string;
  };
  if (!res.ok || !data.nodeId || !data.credential) {
    console.error("註冊失敗：", data.error || res.status);
    process.exit(1);
  }

  const cfg: AgentConfig = {
    platformUrl: platform,
    nodeId: data.nodeId,
    credential: data.credential,
    maxConcurrency,
    dailyJobLimit,
    acceptingJobs: true,
  };
  saveConfig(cfg);
  console.log("註冊成功");
  console.log(`  nodeId     : ${cfg.nodeId}`);
  console.log(`  credential : ${cfg.credential.slice(0, 8)}…（已存 ${configPath()}）`);
  console.log("接著執行：npm run node-agent -- start");
}

async function start() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(`尚未註冊。先執行：npm run node-agent -- register`);
    process.exit(1);
  }

  const api = new AgentApi(cfg);
  let active = 0;
  let backoff = 1000;
  let accepting = cfg.acceptingJobs;

  console.log("Node Agent 啟動");
  console.log(`  platform : ${cfg.platformUrl}`);
  console.log(`  nodeId   : ${cfg.nodeId}`);
  console.log(`  accepting: ${accepting}`);
  console.log("  ※ 不做住宅 IP／指紋偽裝；非任意流量 Proxy");

  const heartbeatLoop = async () => {
    while (true) {
      try {
        await api.heartbeat({ activeJobs: active, acceptingJobs: accepting });
        backoff = 1000;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "AUTH") {
          console.error("憑證無效，請重新 register");
          process.exit(1);
        }
        console.warn(`[heartbeat] ${msg}；${backoff}ms 後重試`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  };

  const runJob = async (job: NonNullable<Awaited<ReturnType<AgentApi["poll"]>>["job"]>, signature: string) => {
    if (!verifyJobSignature(cfg.credential, job, signature, job.payloadSha256)) {
      console.error(`[job ${job.id.slice(0, 8)}] 簽章驗證失敗，拒絕執行`);
      await api.result({ action: "fail", jobId: job.id, error: "invalid signature", status: 403 });
      return;
    }
    if (active >= cfg.maxConcurrency) {
      await api.result({ action: "fail", jobId: job.id, error: "local concurrency full", status: 429 });
      return;
    }

    active++;
    console.log(`[job ${job.id.slice(0, 8)}] ${job.providerKey}:${job.upstreamModel}`);
    try {
      await api.result({ action: "running", jobId: job.id });
      const adapter = resolveAdapter(job.providerKey, job.upstreamModel);
      let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      let platformCostUsd: number | undefined;
      for await (const ev of adapter.run({
        providerKey: job.providerKey,
        modelId: job.upstreamModel,
        messages: job.messages,
      })) {
        if (ev.type === "text") {
          await api.result({ action: "event", jobId: job.id, event: { type: "text", text: ev.text } });
        } else {
          usage = ev.usage;
          platformCostUsd = ev.platformCostUsd;
        }
      }
      await api.result({
        action: "complete",
        jobId: job.id,
        usage,
        platformCostUsd,
      });
      console.log(`[job ${job.id.slice(0, 8)}] done`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[job ${job.id.slice(0, 8)}] fail:`, message);
      await api.result({ action: "fail", jobId: job.id, error: message, status: 500 });
    } finally {
      active--;
    }
  };

  void heartbeatLoop();

  while (true) {
    try {
      const data = await api.poll({
        acceptingJobs: accepting,
        activeJobs: active,
        waitMs: 25_000,
      });
      backoff = 1000;
      if (data.job && data.signature) {
        // 並行上限內可同時跑
        void runJob(data.job, data.signature);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "AUTH") {
        console.error("憑證無效");
        process.exit(1);
      }
      console.warn(`[poll] ${msg}；${backoff}ms 後重連`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

function setAccepting(v: boolean) {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("尚未註冊");
    process.exit(1);
  }
  cfg.acceptingJobs = v;
  saveConfig(cfg);
  console.log(v ? "已恢復接單（下次 heartbeat／poll 生效）" : "已停止接單");
}

async function revoke() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("尚未註冊");
    process.exit(1);
  }
  const api = new AgentApi(cfg);
  await api.revoke();
  console.log("節點已撤銷");
}

async function main() {
  switch (cmd()) {
    case "register":
      await register();
      break;
    case "start":
    case "run":
      await start();
      break;
    case "pause":
      setAccepting(false);
      break;
    case "resume":
      setAccepting(true);
      break;
    case "revoke":
      await revoke();
      break;
    default:
      console.log(`未知指令：${cmd()}
用法：
  register | start | pause | resume | revoke`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
