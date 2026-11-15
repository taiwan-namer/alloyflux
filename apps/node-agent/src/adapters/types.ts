export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AdapterEvent =
  | { type: "text"; text: string }
  | {
      type: "usage";
      usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
      platformCostUsd?: number;
    };

export interface ProviderAdapter {
  readonly id: string;
  supports(providerKey: string, modelId: string): boolean;
  run(input: {
    providerKey: string;
    modelId: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): AsyncGenerator<AdapterEvent>;
}
