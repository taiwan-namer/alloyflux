import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AgentConfig = {
  platformUrl: string;
  nodeId: string;
  credential: string;
  maxConcurrency: number;
  dailyJobLimit: number;
  acceptingJobs: boolean;
};

const dir = path.join(process.cwd(), "data", "node-agent");
const file = path.join(dir, "config.json");

export function loadConfig(): AgentConfig | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: AgentConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`已寫入 ${file}（不含模型 API Key／OAuth Token）`);
}

export function configPath(): string {
  return file;
}
