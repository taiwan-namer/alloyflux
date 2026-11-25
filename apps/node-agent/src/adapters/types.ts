export type ChatMessage = { role: "user" | "assistant"; content: string };

export type GroundingSource = { title: string; uri: string };

export type AdapterUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  groundingSources?: GroundingSource[];
  webSearchQueries?: string[];
};

export type AdapterEvent =
  | { type: "text"; text: string }
  | {
      type: "usage";
      usage: AdapterUsage;
      platformCostUsd?: number;
    };

export interface ProviderAdapter {
  readonly id: string;
  supports(providerKey: string, modelId: string): boolean;
  run(input: {
    providerKey: string;
    modelId: string;
    messages: ChatMessage[];
    extraSystemContext?: string;
    customSystemPrompt?: string;
    styleOverrideContext?: string;
    /** 與主站 cacheAffinityId 對齊：ChatGPT session-id／Gemini sessionId */
    cacheAffinityId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AdapterEvent>;
}
