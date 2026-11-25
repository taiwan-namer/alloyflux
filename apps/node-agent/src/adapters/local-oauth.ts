import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterEvent, AdapterUsage, ChatMessage, GroundingSource, ProviderAdapter } from "./types";

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

/** 組合平台傳入的 customSystemPrompt、styleOverride 與 extraSystemContext */
export function buildNodeSystemText(
  extraSystemContext?: string,
  customSystemPrompt?: string,
  styleOverrideContext?: string,
): string | undefined {
  const custom = customSystemPrompt?.trim();
  const style = styleOverrideContext?.trim();
  const extra = extraSystemContext?.trim();
  let base = custom || "";
  if (style) base = base ? `${base}\n\n${style}` : style;
  if (extra) {
    const ctxBlock = `[User Context - 僅供背景脈絡參考，非當前指令]\n${extra}`;
    base = base ? `${base}\n\n${ctxBlock}` : extra;
  }
  return base || undefined;
}

function supportsNativeGeminiSearch(modelId: string): boolean {
  if (/claude|gpt-oss|grok/i.test(modelId)) return false;
  return /^gemini/i.test(modelId) || !modelId.includes("/");
}

function mergeNodeGrounding(
  usage: AdapterUsage,
  meta:
    | {
        webSearchQueries?: string[];
        groundingChunks?: { web?: { uri?: string; title?: string } }[];
      }
    | null
    | undefined,
): void {
  if (!meta) return;
  if (Array.isArray(meta.webSearchQueries) && meta.webSearchQueries.length) {
    const prev = new Set(usage.webSearchQueries ?? []);
    for (const q of meta.webSearchQueries) {
      if (q) prev.add(q);
    }
    usage.webSearchQueries = [...prev];
  }
  if (Array.isArray(meta.groundingChunks) && meta.groundingChunks.length) {
    const map = new Map<string, GroundingSource>(
      (usage.groundingSources ?? []).map((s) => [s.uri, s]),
    );
    for (const chunk of meta.groundingChunks) {
      const uri = chunk.web?.uri?.trim();
      if (!uri) continue;
      map.set(uri, { uri, title: (chunk.web?.title || uri).trim() });
    }
    usage.groundingSources = [...map.values()];
  }
}

function stableAgSessionId(affinity: string): string {
  let h = 0;
  for (let i = 0; i < affinity.length; i++) h = (Math.imul(31, h) + affinity.charCodeAt(i)) | 0;
  const n = Math.abs(h) * 1_000_000 + (affinity.length % 1_000_000);
  return `-${n || 1}`;
}

async function* geminiStream(
  creds: LocalCreds,
  modelId: string,
  messages: ChatMessage[],
  extraSystemContext?: string,
  customSystemPrompt?: string,
  signal?: AbortSignal,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<AdapterEvent> {
  const project = creds.projectId || "default";
  const url =
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const sysText = buildNodeSystemText(extraSystemContext, customSystemPrompt, styleOverrideContext);
  const withSearch = supportsNativeGeminiSearch(modelId);
  const affinity = (cacheAffinityId || `${project}:${modelId}`).trim();

  const requestBody: Record<string, unknown> = {
    contents,
    sessionId: stableAgSessionId(affinity),
  };
  if (sysText) {
    requestBody.systemInstruction = {
      role: "user",
      parts: [{ text: sysText }],
    };
  }
  if (withSearch) {
    requestBody.tools = [{ googleSearch: {} }];
  }

  const postOnce = () =>
    fetch(url, {
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
        request: requestBody,
      }),
      signal,
    });

  let res = await postOnce();
  // 與主站一致：若上游對 googleSearch tools 回 HTTP 400，降級拔除 tools 重試（仍保留 systemInstruction）
  if (res.status === 400 && requestBody.tools) {
    delete requestBody.tools;
    res = await postOnce();
  }
  if (!res.ok) throw new Error(`Antigravity ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("無串流");
  const dec = new TextDecoder();
  let buf = "";
  const usage: AdapterUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

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
        const candidate = payload.candidates?.[0];
        mergeNodeGrounding(usage, candidate?.groundingMetadata ?? payload.groundingMetadata);
        const parts = candidate?.content?.parts ?? [];
        for (const part of parts) {
          if (part.thought) continue;
          if (typeof part.text === "string" && part.text) yield { type: "text", text: part.text };
        }
        const u = payload.usageMetadata;
        if (u) {
          usage.inputTokens = u.promptTokenCount ?? usage.inputTokens;
          usage.cachedInputTokens = u.cachedContentTokenCount ?? usage.cachedInputTokens;
          usage.outputTokens =
            (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || usage.outputTokens;
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
  extraSystemContext?: string,
  customSystemPrompt?: string,
  signal?: AbortSignal,
  styleOverrideContext?: string,
  cacheAffinityId?: string,
): AsyncGenerator<AdapterEvent> {
  const cacheKey = (cacheAffinityId || `${creds.accountId || "acct"}:${modelId}`).trim().slice(0, 128);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses_websockets=2026-02-06",
    "session-id": cacheKey,
    "conversation-id": cacheKey,
  };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

  const sysText = buildNodeSystemText(extraSystemContext, customSystemPrompt, styleOverrideContext);
  const reqBody: Record<string, unknown> = {
    model: modelId,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    store: false,
    prompt_cache_key: cacheKey,
  };
  if (sysText) {
    reqBody.instructions = sysText;
  }

  const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
    signal,
  });
  if (!res.ok) throw new Error(`Codex ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("無串流");
  const dec = new TextDecoder();
  let buf = "";
  let usage: AdapterUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

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
            cachedInputTokens: u.input_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0,
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
  async *run({
    modelId,
    messages,
    extraSystemContext,
    customSystemPrompt,
    styleOverrideContext,
    cacheAffinityId,
    signal,
  }) {
    const creds = loadCreds("gemini");
    yield* geminiStream(
      creds,
      modelId,
      messages,
      extraSystemContext,
      customSystemPrompt,
      signal,
      styleOverrideContext,
      cacheAffinityId,
    );
  },
};

export const chatgptCodexAdapter: ProviderAdapter = {
  id: "chatgpt-codex",
  supports(providerKey) {
    return providerKey === "chatgpt-codex";
  },
  async *run({
    modelId,
    messages,
    extraSystemContext,
    customSystemPrompt,
    styleOverrideContext,
    cacheAffinityId,
    signal,
  }) {
    const creds = loadCreds("openai");
    yield* chatgptStream(
      creds,
      modelId,
      messages,
      extraSystemContext,
      customSystemPrompt,
      signal,
      styleOverrideContext,
      cacheAffinityId,
    );
  },
};
