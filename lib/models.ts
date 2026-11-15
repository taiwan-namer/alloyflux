export type Provider = "gemini" | "openai" | "anthropic" | "xai" | "node";

/** 聊天選單分類（Antigravity 底下的 Claude／GPT 仍走 Google 訂閱） */
export type ModelCategory =
  | "gemini"
  | "antigravity-claude"
  | "antigravity-gpt"
  | "chatgpt"
  | "grok"
  | "claude-api"
  | "node-agent";

/** 對應 Antigravity Models & Usage 的額度池 */
export type QuotaPool = "shared" | "argon" | "third_party" | "chatgpt" | "grok" | "other" | "node";

export interface ModelInfo {
  id: string;
  label: string;
  /** 買家選單右側用途備註（例：最強全能）；不影響系統內部名稱 */
  blurb?: string;
  provider: Provider;
  category: ModelCategory;
  quotaPool: QuotaPool;
  tier: "top" | "main" | "light";
  /** 未登入／未購買方案時可選用的各家低階入門模型 */
  freeTier?: boolean;
  /** USD per 1M tokens (used for equivalent value calculation & points) */
  price: { input: number; cachedInput: number; output: number };
  /** Upstream model ID on Gemini Antigravity Cloud Code */
  antigravityId?: string;
  /** Upstream model ID on ChatGPT Codex backend */
  codexId?: string;
  /** Upstream model ID on Grok CLI chat proxy */
  grokId?: string;
  /** OpenRouter fallback slug */
  openrouterId: string;
  /** Gemini API Key 路徑的正式 model 名 */
  geminiApiId?: string;
  /** 思考強度（Antigravity wire 後綴） */
  effort?: "high" | "medium" | "low";
  /** 走供給者 Node Agent 時的 providerKey／upstream model */
  nodeProviderKey?: string;
  nodeUpstreamModel?: string;
}

/** 買家端選單顯示用；扣池／Antigravity 等內部說明留在後台／註解，不露出給買家 */
export const CATEGORY_LABEL: Record<ModelCategory, string> = {
  gemini: "Google Gemini",
  "antigravity-claude": "Claude",
  "antigravity-gpt": "GPT-OSS",
  chatgpt: "ChatGPT／OpenAI",
  grok: "Grok",
  "claude-api": "Claude API",
  "node-agent": "Node Agent",
};

export const MODELS: ModelInfo[] = [
  // === Node Agent 驗收／本機執行 ===
  {
    id: "node-mock",
    label: "Node Agent · Mock（端到端測試）",
    provider: "node",
    category: "node-agent",
    quotaPool: "node",
    tier: "light",
    price: { input: 0.05, cachedInput: 0.01, output: 0.05 },
    openrouterId: "unused/node-mock",
    nodeProviderKey: "mock",
    nodeUpstreamModel: "node-mock",
  },
  // === Google Gemini ===
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    blurb: "免費日常",
    provider: "gemini",
    category: "gemini",
    quotaPool: "shared",
    tier: "light",
    freeTier: true,
    price: { input: 0.15, cachedInput: 0.02, output: 0.6 },
    antigravityId: "gemini-3.5-flash-lite",
    geminiApiId: "gemini-3.5-flash-lite",
    openrouterId: "google/gemini-2.5-flash-lite",
  },
  {
    id: "gemini-3.8-flash-low",
    label: "Gemini 3.8 Flash · Low",
    blurb: "高速日常",
    provider: "gemini",
    category: "gemini",
    quotaPool: "shared",
    tier: "main",
    effort: "low",
    price: { input: 0.3, cachedInput: 0.03, output: 1.5 },
    antigravityId: "gemini-3.8-flash-low",
    geminiApiId: "gemini-3.8-flash",
    openrouterId: "google/gemini-2.5-flash",
  },
  {
    id: "gemini-3.8-flash-medium",
    label: "Gemini 3.8 Flash · Medium",
    blurb: "高速日常",
    provider: "gemini",
    category: "gemini",
    quotaPool: "shared",
    tier: "main",
    effort: "medium",
    price: { input: 0.3, cachedInput: 0.03, output: 1.5 },
    antigravityId: "gemini-3.8-flash-medium",
    geminiApiId: "gemini-3.8-flash",
    openrouterId: "google/gemini-2.5-flash",
  },
  {
    id: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash · High",
    blurb: "高速日常",
    provider: "gemini",
    category: "gemini",
    quotaPool: "shared",
    tier: "main",
    effort: "high",
    price: { input: 0.3, cachedInput: 0.03, output: 1.5 },
    antigravityId: "gemini-3.8-flash-high",
    geminiApiId: "gemini-3.8-flash",
    openrouterId: "google/gemini-2.5-flash",
  },
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    blurb: "高階推理",
    provider: "gemini",
    category: "gemini",
    quotaPool: "shared",
    tier: "top",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    antigravityId: "gemini-3.1-pro-high",
    geminiApiId: "gemini-3.1-pro-preview",
    openrouterId: "google/gemini-2.5-pro",
  },
  {
    id: "gemini-4-argon-low",
    label: "Gemini 4 Argon · Low",
    blurb: "頂規推理",
    provider: "gemini",
    category: "gemini",
    quotaPool: "argon",
    tier: "top",
    effort: "low",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "gemini-4-argon-low",
    geminiApiId: "gemini-4-argon",
    openrouterId: "google/gemini-2.5-pro",
  },
  {
    id: "gemini-4-argon-medium",
    label: "Gemini 4 Argon · Medium",
    blurb: "頂規推理",
    provider: "gemini",
    category: "gemini",
    quotaPool: "argon",
    tier: "top",
    effort: "medium",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "gemini-4-argon-medium",
    geminiApiId: "gemini-4-argon",
    openrouterId: "google/gemini-2.5-pro",
  },
  {
    id: "gemini-4-argon-high",
    label: "Gemini 4 Argon · High",
    blurb: "頂規推理",
    provider: "gemini",
    category: "gemini",
    quotaPool: "argon",
    tier: "top",
    effort: "high",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "gemini-4-argon-high",
    geminiApiId: "gemini-4-argon",
    openrouterId: "google/gemini-2.5-pro",
  },

  // === Claude via Antigravity（內部：扣 Google「Claude and GPT models」池；買家端不顯示）===
  {
    id: "agy-claude-sonnet-5-5-low",
    label: "Claude Sonnet 5.5 · Low",
    blurb: "免費入門",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "main",
    freeTier: true,
    effort: "low",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    antigravityId: "claude-sonnet-5-5-low",
    openrouterId: "anthropic/claude-sonnet-5.5",
  },
  {
    id: "agy-claude-sonnet-5-5-medium",
    label: "Claude Sonnet 5.5 · Medium",
    blurb: "均衡寫程式",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "main",
    effort: "medium",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    antigravityId: "claude-sonnet-5-5-medium",
    openrouterId: "anthropic/claude-sonnet-5.5",
  },
  {
    id: "agy-claude-sonnet-5-5-high",
    label: "Claude Sonnet 5.5 · High",
    blurb: "均衡寫程式",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "main",
    effort: "high",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    antigravityId: "claude-sonnet-5-5-high",
    openrouterId: "anthropic/claude-sonnet-5.5",
  },
  {
    id: "agy-claude-opus-5-5-low",
    label: "Claude Opus 5.5 · Low",
    blurb: "最強推理",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "top",
    effort: "low",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "claude-opus-5-5-low",
    openrouterId: "anthropic/claude-opus-5.5",
  },
  {
    id: "agy-claude-opus-5-5-medium",
    label: "Claude Opus 5.5 · Medium",
    blurb: "最強推理",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "top",
    effort: "medium",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "claude-opus-5-5-medium",
    openrouterId: "anthropic/claude-opus-5.5",
  },
  {
    id: "agy-claude-opus-5-5-high",
    label: "Claude Opus 5.5 · High",
    blurb: "最強推理",
    provider: "anthropic",
    category: "antigravity-claude",
    quotaPool: "third_party",
    tier: "top",
    effort: "high",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    antigravityId: "claude-opus-5-5-high",
    openrouterId: "anthropic/claude-opus-5.5",
  },

  // === GPT-OSS via Antigravity ===
  {
    id: "agy-gpt-oss-120b-medium",
    label: "GPT-OSS 120B · Medium",
    blurb: "免費開源",
    provider: "openai",
    category: "antigravity-gpt",
    quotaPool: "third_party",
    tier: "main",
    freeTier: true,
    effort: "medium",
    price: { input: 0.3, cachedInput: 0.03, output: 1.2 },
    antigravityId: "gpt-oss-120b-medium",
    openrouterId: "openai/gpt-oss-120b",
  },

  // === ChatGPT 訂閱／OpenAI（Codex /codex/models，client_version≥0.159）===
  // gpt-5.5 已於 ChatGPT 登入路徑下架；改以 6.x 目錄為準
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    blurb: "最強全能",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "top",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    codexId: "gpt-6-astra",
    openrouterId: "openai/gpt-5.4",
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    blurb: "近 Astra、較省",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "top",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    codexId: "gpt-6.1-sol",
    openrouterId: "openai/gpt-5.4",
  },
  {
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    blurb: "寫作／視覺",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "main",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    codexId: "gpt-6.1-terra",
    openrouterId: "openai/gpt-5.4-mini",
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    blurb: "全能主力",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "top",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    codexId: "gpt-6-sol",
    openrouterId: "openai/gpt-5.4",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    blurb: "免費輕量",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "light",
    freeTier: true,
    price: { input: 0.15, cachedInput: 0.02, output: 0.6 },
    codexId: "gpt-6-luna",
    openrouterId: "openai/gpt-5.4-mini",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    blurb: "上代全能",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "main",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    codexId: "gpt-5.6-sol",
    openrouterId: "openai/gpt-5.4",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    blurb: "上代寫作／視覺",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "main",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    codexId: "gpt-5.6-terra",
    openrouterId: "openai/gpt-5.4-mini",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    blurb: "免費輕量",
    provider: "openai",
    category: "chatgpt",
    quotaPool: "chatgpt",
    tier: "light",
    freeTier: true,
    price: { input: 0.15, cachedInput: 0.02, output: 0.6 },
    codexId: "gpt-5.6-luna",
    openrouterId: "openai/gpt-5.4-mini",
  },

  // === Grok／SuperGrok 訂閱（cli-chat-proxy.grok.com）===
  {
    id: "grok-4.7",
    label: "Grok 4.7",
    blurb: "最強",
    provider: "xai",
    category: "grok",
    quotaPool: "grok",
    tier: "top",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    grokId: "grok-4.7",
    openrouterId: "x-ai/grok-4",
  },
  {
    id: "grok-4.7-build-fast",
    label: "Grok 4.7 Build Fast",
    blurb: "高速構建",
    provider: "xai",
    category: "grok",
    quotaPool: "grok",
    tier: "main",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    grokId: "grok-4.7-build-fast",
    openrouterId: "x-ai/grok-4",
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    blurb: "均衡主力",
    provider: "xai",
    category: "grok",
    quotaPool: "grok",
    tier: "top",
    price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
    grokId: "grok-4.6",
    openrouterId: "x-ai/grok-4",
  },
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    blurb: "免費入門",
    provider: "xai",
    category: "grok",
    quotaPool: "grok",
    tier: "main",
    freeTier: true,
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    grokId: "grok-4.5",
    openrouterId: "x-ai/grok-4",
  },

  // === Claude API Key（真 Anthropic，不是 Antigravity）===
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5 API",
    blurb: "API 直連",
    provider: "anthropic",
    category: "claude-api",
    quotaPool: "other",
    tier: "main",
    price: { input: 2.0, cachedInput: 0.2, output: 10.0 },
    openrouterId: "anthropic/claude-sonnet-5.5",
  },
];

export function findModel(id: string): ModelInfo | undefined {
  return (
    MODELS.find((m) => m.id === id) ??
    MODELS.find((m) => m.antigravityId === id) ??
    (id === "gemini-4-argon" ? MODELS.find((m) => m.id === "gemini-4-argon-low") : undefined) ??
    (id === "gemini-3.8-flash" ? MODELS.find((m) => m.id === "gemini-3.8-flash-low") : undefined)
  );
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  upstreamModelVersion?: string;
  upstreamModelId?: string;
  /** @deprecated 已取消 daily 備援；僅舊訊息可能仍有此欄 */
  viaDailyBypass?: boolean;
  quotaLabel?: string;
  quotaRemainingBeforePct?: number;
  quotaRemainingAfterPct?: number;
  quotaUsedPct?: number;
  /** Google Search grounding 引用 */
  groundingSources?: GroundingSource[];
  webSearchQueries?: string[];
}

export function officialCostUsd(model: ModelInfo, u: Usage): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens);
  return (
    (uncached * model.price.input +
      u.cachedInputTokens * model.price.cachedInput +
      u.outputTokens * model.price.output) /
    1_000_000
  );
}

/**
 * 計費口徑（封測硬鎖）：
 * - 1 點對應上游成本 $0.003 → 1,000 點 ≈ $3.00 USD 成本池
 * - 買家實扣 = 成本點 × PRICE_MARKUP（預設 1.05）作為安全緩衝
 */
export const USD_PER_POINT = Number(process.env.USD_PER_POINT ?? 0.003);

export function usdToPoints(usd: number): number {
  const per = USD_PER_POINT > 0 ? USD_PER_POINT : 0.003;
  return usd / per;
}

export function markup(): number {
  return Number(process.env.PRICE_MARKUP ?? 1.05);
}

function roundPoints(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 買家單次實扣保護上限（依模型 tier；official 成本點不套用）。
 * top 模型開「深度思考」（effort medium／high）時放寬為 45，避免平台倒貼。
 */
export function perTurnChargedPointsCap(tier: ModelInfo["tier"], effort?: ModelInfo["effort"]): number {
  if (tier === "light") return 5;
  if (tier === "main") return 15;
  if (effort === "medium" || effort === "high") return 45;
  return 25; // top
}

/**
 * 上游成本 USD → 官方成本點 + 買家扣點（含 markup）。
 * 傳入 tier 時對 chargedPoints 做單次封頂；officialCostPoints 永不封頂。
 */
export function chargePointsFromUsd(
  usd: number,
  tier?: ModelInfo["tier"],
  effort?: ModelInfo["effort"],
): { officialCostPoints: number; chargedPoints: number } {
  const official = usdToPoints(usd);
  const rawCharged = roundPoints(official * markup());
  const charged =
    tier != null ? roundPoints(Math.min(rawCharged, perTurnChargedPointsCap(tier, effort))) : rawCharged;
  return {
    officialCostPoints: roundPoints(official),
    chargedPoints: charged,
  };
}
