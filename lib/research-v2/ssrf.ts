/**
 * SSRF 防護：每次 Redirect 都驗證目的地；無法安全展開時標記 unresolved／blocked_ssrf。
 * 注意：Node fetch 無法鎖定「解析 IP＝連線 IP」，DNS rebinding 為殘餘風險——
 * 因此預設僅允許 HTTPS 公開主機，並在每次 hop 重新解析檢查。
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { FetchStatus } from "./types";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;

/** 明確封鎖的主機／後綴 */
const BLOCKED_HOST_RE =
  /^(localhost|metadata\.google\.internal|metadata\.goog|.*\.internal|.*\.local|.*\.localhost)$/i;

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200", // 阿里雲等
]);

export type SafeUrlCheck =
  | { ok: true; url: URL; resolvedIps: string[] }
  | { ok: false; reason: string; fetchStatus: FetchStatus };

export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (!v) return true;

  if (v === 4) {
    const parts = ip.split(".").map((x) => Number(x));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped
  const mapped = lower.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  const mappedHex = lower.match(/^:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const a = (hi >> 8) & 255;
    const b = hi & 255;
    const c = (lo >> 8) & 255;
    const d = lo & 255;
    return isBlockedIp(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

export async function validatePublicHttpsUrl(raw: string): Promise<SafeUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url", fetchStatus: "failed" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "non_https", fetchStatus: "blocked_ssrf" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "userinfo_forbidden", fetchStatus: "blocked_ssrf" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_HOST_RE.test(host) || METADATA_HOSTS.has(host.toLowerCase())) {
    return { ok: false, reason: "blocked_hostname", fetchStatus: "blocked_ssrf" };
  }

  // 字面 IP
  if (net.isIP(host)) {
    if (isBlockedIp(host) || METADATA_HOSTS.has(host)) {
      return { ok: false, reason: "blocked_literal_ip", fetchStatus: "blocked_ssrf" };
    }
    return { ok: true, url, resolvedIps: [host] };
  }

  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length) {
      return { ok: false, reason: "dns_empty", fetchStatus: "unresolved" };
    }
    const ips = records.map((r) => r.address);
    if (ips.some((ip) => isBlockedIp(ip) || METADATA_HOSTS.has(ip))) {
      return { ok: false, reason: "dns_resolves_private", fetchStatus: "blocked_ssrf" };
    }
    return { ok: true, url, resolvedIps: ips };
  } catch {
    return { ok: false, reason: "dns_lookup_failed", fetchStatus: "unresolved" };
  }
}

export type SafeFetchResult = {
  ok: boolean;
  originalUrl: string;
  resolvedUrl?: string;
  status?: number;
  contentType?: string;
  body?: string;
  fetchStatus: FetchStatus;
  redirectHops: number;
  reason?: string;
};

/**
 * 手動跟隨 Redirect；每一 hop 重新做 HTTPS＋DNS＋私有 IP 檢查。
 * 不做不安全的 redirect:'follow'。
 */
export async function safeFetchText(
  originalUrl: string,
  opts?: { signal?: AbortSignal; maxBytes?: number },
): Promise<SafeFetchResult> {
  const maxBytes = opts?.maxBytes ?? 500_000;
  let current = originalUrl;
  let hops = 0;

  for (;;) {
    const check = await validatePublicHttpsUrl(current);
    if (!check.ok) {
      return {
        ok: false,
        originalUrl,
        fetchStatus: check.fetchStatus,
        redirectHops: hops,
        reason: check.reason,
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    opts?.signal?.addEventListener("abort", onAbort);

    try {
      const res = await fetch(check.url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AIResearchBot/1.0; +https://localhost) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc || hops >= MAX_REDIRECTS) {
          return {
            ok: false,
            originalUrl,
            resolvedUrl: current,
            status: res.status,
            fetchStatus: hops >= MAX_REDIRECTS ? "failed" : "unresolved",
            redirectHops: hops,
            reason: hops >= MAX_REDIRECTS ? "too_many_redirects" : "missing_location",
          };
        }
        hops += 1;
        current = new URL(loc, check.url).toString();
        continue;
      }

      if (!res.ok) {
        return {
          ok: false,
          originalUrl,
          resolvedUrl: res.url || current,
          status: res.status,
          fetchStatus: "failed",
          redirectHops: hops,
          reason: `http_${res.status}`,
        };
      }

      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      if (ctype && !/text\/html|text\/plain|application\/xhtml/i.test(ctype)) {
        return {
          ok: false,
          originalUrl,
          resolvedUrl: res.url || current,
          status: res.status,
          contentType: ctype,
          fetchStatus: "failed",
          redirectHops: hops,
          reason: "unsupported_content_type",
        };
      }

      const raw = await res.text();
      const body = raw.slice(0, maxBytes);
      return {
        ok: true,
        originalUrl,
        resolvedUrl: res.url || current,
        status: res.status,
        contentType: ctype,
        body,
        fetchStatus: "ok",
        redirectHops: hops,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        originalUrl,
        resolvedUrl: current,
        fetchStatus: /abort/i.test(msg) ? "failed" : "unresolved",
        redirectHops: hops,
        reason: msg.slice(0, 120),
      };
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
}
