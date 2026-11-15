import type { AdapterEvent, ProviderAdapter } from "./types";

/** 端到端測試用：不呼叫外部 API */
export const mockAdapter: ProviderAdapter = {
  id: "mock",
  supports(providerKey) {
    return providerKey === "mock";
  },
  async *run({ messages }): AsyncGenerator<AdapterEvent> {
    const last = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const reply = `【Node Agent Mock】已在供給者本機執行。你說：${last.slice(0, 500)}`;
    for (const chunk of reply.match(/.{1,24}/g) ?? [reply]) {
      yield { type: "text", text: chunk };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield {
      type: "usage",
      usage: {
        inputTokens: Math.max(1, Math.ceil(last.length / 4)),
        cachedInputTokens: 0,
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
      },
      platformCostUsd: 0.0001,
    };
  },
};
