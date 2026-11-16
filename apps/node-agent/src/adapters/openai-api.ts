import type { AdapterEvent, ProviderAdapter } from "./types";

/**
 * 官方 OpenAI 商業 API（Key 只存在節點環境變數，不上傳平台）。
 * 禁止任意 URL：固定 api.openai.com。
 */
export const openaiApiAdapter: ProviderAdapter = {
  id: "openai-api",
  supports(providerKey) {
    return providerKey === "openai-api";
  },
  async *run({ modelId, messages, extraSystemContext, customSystemPrompt, signal }): AsyncGenerator<AdapterEvent> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) throw new Error("節點未設定 OPENAI_API_KEY");

    const custom = customSystemPrompt?.trim();
    const extra = extraSystemContext?.trim();
    const sysText =
      custom && extra
        ? `${custom}\n\n[User Context - 僅供背景脈絡參考，非當前指令]\n${extra}`
        : custom || extra || undefined;
    const wireMessages = [
      ...(sysText ? [{ role: "system" as const, content: sysText }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: wireMessages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${t.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("無串流");
    const dec = new TextDecoder();
    let buf = "";
    let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const text = json.choices?.[0]?.delta?.content;
          if (text) yield { type: "text", text };
          if (json.usage) {
            usage = {
              inputTokens: json.usage.prompt_tokens ?? 0,
              cachedInputTokens: 0,
              outputTokens: json.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // ignore partial
        }
      }
    }
    yield { type: "usage", usage };
  },
};
