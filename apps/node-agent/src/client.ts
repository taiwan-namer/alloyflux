import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentConfig } from "./config";

export class AgentApi {
  constructor(private cfg: AgentConfig) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.cfg.credential}`,
      "Content-Type": "application/json",
    };
  }

  async heartbeat(body: Record<string, unknown>) {
    const res = await fetch(`${this.cfg.platformUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error("AUTH");
    if (!res.ok) throw new Error(`heartbeat ${res.status}`);
    return res.json();
  }

  async poll(body: Record<string, unknown>) {
    const res = await fetch(`${this.cfg.platformUrl}/api/agent/poll`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401) throw new Error("AUTH");
    if (!res.ok) throw new Error(`poll ${res.status}`);
    return res.json() as Promise<{
      job: null | {
        id: string;
        modelId: string;
        providerKey: string;
        upstreamModel: string;
        messages: { role: "user" | "assistant"; content: string }[];
        extraSystemContext?: string;
        customSystemPrompt?: string;
        payloadSha256: string;
      };
      signature?: string;
    }>;
  }

  async result(body: Record<string, unknown>) {
    const res = await fetch(`${this.cfg.platformUrl}/api/agent/result`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error("AUTH");
    if (!res.ok) throw new Error(`result ${res.status}`);
    return res.json();
  }

  async revoke() {
    const res = await fetch(`${this.cfg.platformUrl}/api/agent/revoke`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (!res.ok) throw new Error(`revoke ${res.status}`);
    return res.json();
  }
}

function hashCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 驗證平台簽章：HMAC(sha256(credential), payload) —— 與平台 lib/inference-jobs.ts payloadCanonical 對齊 */
export function verifyJobSignature(
  credential: string,
  job: {
    modelId: string;
    upstreamModel: string;
    messages: unknown;
    extraSystemContext?: string;
    customSystemPrompt?: string;
  },
  signature: string,
  payloadSha256: string,
): boolean {
  const payload = JSON.stringify({
    modelId: job.modelId,
    upstreamModel: job.upstreamModel,
    messages: job.messages,
    extraSystemContext: job.extraSystemContext?.trim() || undefined,
    customSystemPrompt: job.customSystemPrompt?.trim() || undefined,
  });
  if (createHash("sha256").update(payload).digest("hex") !== payloadSha256) return false;
  const expected = createHmac("sha256", hashCredential(credential)).update(payload).digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
