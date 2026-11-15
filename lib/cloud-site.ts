/** 線上站台公開網址（非密鑰）。本機授權完成後導向此站查看 /sources。 */
export function publicAppUrl(): string {
  const raw =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_URL?.trim()) ||
    "https://alloyflux.vercel.app";
  return raw.replace(/\/$/, "");
}

export function goToSourcesAfterBind(routerPush: (href: string) => void): void {
  if (typeof window === "undefined") {
    routerPush("/sources");
    return;
  }
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) {
    window.location.href = `${publicAppUrl()}/sources`;
    return;
  }
  routerPush("/sources");
}
