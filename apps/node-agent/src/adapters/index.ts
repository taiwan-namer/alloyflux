import { antigravityAdapter, chatgptCodexAdapter } from "./local-oauth";
import { mockAdapter } from "./mock";
import { openaiApiAdapter } from "./openai-api";
import type { ProviderAdapter } from "./types";

export const adapters: ProviderAdapter[] = [
  mockAdapter,
  openaiApiAdapter,
  antigravityAdapter,
  chatgptCodexAdapter,
];

export function resolveAdapter(providerKey: string, modelId: string): ProviderAdapter {
  const a = adapters.find((x) => x.supports(providerKey, modelId));
  if (!a) throw new Error(`此節點不支援 ${providerKey}:${modelId}`);
  return a;
}

export type { AdapterEvent, ChatMessage, ProviderAdapter } from "./types";
