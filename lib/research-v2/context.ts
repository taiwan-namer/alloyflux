import { AsyncLocalStorage } from "node:async_hooks";
import type { ResearchSupplyPath, ResearchVerdict } from "./types";

type ResearchRequestContext = {
  verdict: ResearchVerdict;
  supplyPath: ResearchSupplyPath;
  /** 平台已跑過一次，provider 不得再搜 */
  platformResearchDone: boolean;
};

const storage = new AsyncLocalStorage<ResearchRequestContext>();

export function getResearchContext(): ResearchRequestContext | undefined {
  return storage.getStore();
}

export function getPreparedVerdict(): ResearchVerdict | undefined {
  return storage.getStore()?.verdict;
}

export function isPlatformResearchDone(): boolean {
  return Boolean(storage.getStore()?.platformResearchDone);
}

export function runWithResearchContext<T>(
  ctx: ResearchRequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export async function runWithResearchContextAsync<T>(
  ctx: ResearchRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}
