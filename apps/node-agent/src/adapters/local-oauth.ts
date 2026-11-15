import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterEvent, ChatMessage, ProviderAdapter } from "./types";

/**
 * 本機個人訂閱 OAuth（Antigravity／Codex）——憑證只讀本機檔，不上傳平台。
 * 不做指紋／UA／TLS 偽裝；固定官方端點。
 *
 * 憑證檔格式（JSON）：
 * {
 *   "provider": "gemini" | "openai",
 *   "accessToken": "...",
 *   "refreshToken": "...",
 *   "expiresAt": 0,
 *   "projectId": "...",   // gemini
 *   "accountId": "..."    // chatgpt
 * }
 */

type LocalCreds = {
  provider: "gemini" | "openai";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
  accountId?: string;
};

function loadCreds(provider: "gemini" | "openai"): LocalCreds {
  const envPath =
    provider === "gemini"
      ? process.env.ANTIGRAVITY_CREDS_FILE
      : process.env.CHATGPT_CREDS_FILE;
  const fallback = path.join(
    process.cwd(),
    "data",
    "node-local-creds",
    provider === "gemini" ? "antigravity.json" : "chatgpt.json",
  );
  const p = envPath || fallback;
  if (!existsSync(p)) {
    throw new Error(`找不到本機憑證檔：${p}（請在節點本機放置，勿上傳平台）`);
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as LocalCreds;
  if (!raw.accessToken) throw new Error("憑證檔缺少 accessToken");
  // 絕不 log token
  return raw;
}

async function* geminiStream(
  creds: LocalCreds,
  modelId: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<AdapterEvent> {
  const project = creds.projectId || "default";
  const url =
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project,
      model: modelId,
      userAgent: "antigravity",
      requestType: "agent",
      request: { contents },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Antigravity ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("無串流");
  const dec = new TextDecoder();
  let buf = "";
  let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n");
    buf = chunks.pop() ?? "";
    for (const line of chunks) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const payload = json.response ?? json;
        const parts = payload.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought) continue;
          if (typeof part.text === "string" && part.text) yield { type: "text", text: part.text };
        }
        const u = payload.usageMetadata;
        if (u) {
          usage = {
            inputTokens: u.promptTokenCount ?? usage.inputTokens,
            cachedInputTokens: u.cachedContentTokenCount ?? 0,
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          };
        }
      } catch {
        // ignore
      }
    }
  }
  yield { type: "usage", usage };
}

async function* chatgptStream(
  creds: LocalCreds,
  modelId: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<AdapterEvent> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses_websockets=2026-02-06",
  };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

  const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Codex ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("無串流");
  const dec = new TextDecoder();
  let buf = "";
  let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n");
    buf = chunks.pop() ?? "";
    for (const line of chunks) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (json.type === "response.output_text.delta" && json.delta) {
          yield { type: "text", text: json.delta };
        } else if (json.type === "response.completed" && json.response?.usage) {
          const u = json.response.usage;
          usage = {
            inputTokens: u.input_tokens ?? 0,
            cachedInputTokens: u.cached_tokens ?? 0,
            outputTokens: (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0),
          };
        }
      } catch {
        // ignore
      }
    }
  }
  yield { type: "usage", usage };
}

export const antigravityAdapter: ProviderAdapter = {
  id: "antigravity",
  supports(providerKey) {
    return providerKey === "antigravity";
  },
  async *run({ modelId, messages, signal }) {
    const creds = loadCreds("gemini");
    yield* geminiStream(creds, modelId, messages, signal);
  },
};

export const chatgptCodexAdapter: ProviderAdapter = {
  id: "chatgpt-codex",
  supports(providerKey) {
    return providerKey === "chatgpt-codex";
  },
  async *run({ modelId, messages, signal }) {
    const creds = loadCreds("openai");
    yield* chatgptStream(creds, modelId, messages, signal);
  },
};
