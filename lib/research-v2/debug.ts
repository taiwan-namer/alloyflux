import type { ResearchDebugSnapshot, ResearchVerdict } from "./types";

export function isResearchDebugEnabled(): boolean {
  const v = process.env.RESEARCH_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function logResearchDebug(snapshot: ResearchDebugSnapshot): void {
  if (!isResearchDebugEnabled()) return;
  // 結構化一行 JSON，不含 token／cookie／全文
  console.info("[research-debug]", JSON.stringify(snapshot));
}

export function attachDebugIfEnabled(verdict: ResearchVerdict, snapshot: ResearchDebugSnapshot): ResearchVerdict {
  if (!isResearchDebugEnabled()) return verdict;
  logResearchDebug(snapshot);
  return { ...verdict, debug: snapshot };
}
