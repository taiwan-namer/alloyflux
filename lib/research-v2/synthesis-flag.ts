/**
 * search_synthesis feature flag（預設關閉）。
 * 開啟：RESEARCH_SEARCH_SYNTHESIS=1
 */
export function isSearchSynthesisEnabled(): boolean {
  return process.env.RESEARCH_SEARCH_SYNTHESIS === "1";
}
