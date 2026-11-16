import type { ModelInfo } from "../models";
import type { ResearchVerdict } from "./types";

/** 與 providers 查證掛點對齊：僅這些路徑需要平台 Research */
export function modelNeedsPlatformResearch(model: ModelInfo): boolean {
  if (model.codexId) return true;
  if (model.grokId) return true;
  if (model.provider === "anthropic" || model.provider === "openai" || model.provider === "xai") return true;
  if (model.category === "antigravity-claude" || model.category === "antigravity-gpt") return true;
  if (model.antigravityId && /claude|gpt-oss/i.test(model.antigravityId)) return true;
  return false;
}

export type DoneLike = {
  type: "done";
  groundingSources?: { title: string; uri: string }[];
  webSearchQueries?: string[];
  [key: string]: unknown;
};

/** failed／skipped 不得把研究來源掛成「已查證」清單 */
export function attachResearchToDone<T extends { type: string }>(
  ev: T,
  verdict: ResearchVerdict | null,
): T {
  if (!verdict || ev.type !== "done") return ev;
  const done = ev as T & DoneLike;
  const completionStatus = verdict.completionStatus ??
    (verdict.status === "ok"
      ? "complete"
      : verdict.status === "partial"
        ? "truncated"
        : verdict.status === "failed"
          ? "failed"
          : "unknown");
  // failed／skipped：不得顯示「已查證」來源清單
  if (!verdict.showVerifiedBadge || verdict.status === "failed" || verdict.status === "skipped") {
    return {
      ...done,
      groundingSources: verdict.status === "failed" || verdict.status === "skipped"
        ? undefined
        : done.groundingSources,
      webSearchQueries: done.webSearchQueries,
      completionStatus,
      researchGateStatus: verdict.status,
      showVerifiedBadge: false,
    } as T;
  }
  const merged = new Map<string, { title: string; uri: string }>();
  for (const s of done.groundingSources ?? []) {
    // 拒絕含省略號的壞連結
    if (!s.uri || s.uri.includes("…")) continue;
    merged.set(s.uri, s);
  }
  for (const s of verdict.sources) {
    const uri = s.resolvedUrl || s.uri;
    if (!uri || uri.includes("…")) continue;
    merged.set(uri, { title: s.title, uri });
  }
  return {
    ...done,
    groundingSources: [...merged.values()],
    webSearchQueries: verdict.webSearchQueries.length
      ? verdict.webSearchQueries
      : done.webSearchQueries,
    completionStatus,
    researchGateStatus: verdict.status,
  } as T;
}

/**
 * 模擬 Gateway：平台研究一次 → Node 嘗試 → failover local，驗證不重跑研究。
 * 純 Mock，不碰真實 Node／OAuth／計費。
 */
export async function* mockGatewayWithResearch(opts: {
  verdict: ResearchVerdict | null;
  nodeFail?: boolean;
  localReply: string;
  researchRunCount: { n: number };
}): AsyncGenerator<
  | { type: "failover"; from: string; reason: string }
  | { type: "text"; text: string }
  | {
      type: "done";
      content: string;
      path: "node" | "local";
      groundingSources?: { title: string; uri: string }[];
      webSearchQueries?: string[];
      showVerifiedBadge: boolean;
    }
> {
  const { verdict, nodeFail, localReply, researchRunCount } = opts;
  // 研究應在進入此 generator 前已完成；此處只消費 prepared
  void researchRunCount;

  if (nodeFail) {
    yield { type: "failover", from: "Node Agent", reason: "503" };
  } else {
    yield { type: "text", text: localReply };
    yield attachResearchToDone(
      {
        type: "done" as const,
        content: localReply,
        path: "node" as const,
        groundingSources: [] as { title: string; uri: string }[],
        webSearchQueries: [] as string[],
        showVerifiedBadge: Boolean(verdict?.showVerifiedBadge),
      },
      verdict,
    );
    return;
  }

  yield { type: "text", text: localReply };
  yield attachResearchToDone(
    {
      type: "done" as const,
      content: localReply,
      path: "local" as const,
      groundingSources: [] as { title: string; uri: string }[],
      webSearchQueries: [] as string[],
      showVerifiedBadge: Boolean(verdict?.showVerifiedBadge),
    },
    verdict,
  );
}
