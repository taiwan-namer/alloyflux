/**
 * 收集 ≥15 份產品同款 SSRF fetch HTML，立刻鎖 hold-out。
 * 用法：npx tsx scripts/collect-html-fixtures.mts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "lib/research-v2/fixtures/html");

type Spec = {
  id: string;
  type:
    | "intl_wire"
    | "finance"
    | "zh_tw"
    | "corp_newsroom"
    | "gov_filing"
    | "shell_or_paywall"
    | "grounding_redirect";
  lang: "en" | "zh" | "mixed";
  url: string;
  topicHint: string;
  /** 人工預期：has_body | shell */
  expectedLabel: "has_body" | "shell";
};

/** 公開新聞 URL（可能 404／改版；失敗則寫 synthetic 殼） */
const SPECS: Spec[] = [
  {
    id: "reuters_tech_sample",
    type: "intl_wire",
    lang: "en",
    url: "https://www.reuters.com/technology/",
    topicHint: "tech",
    expectedLabel: "has_body",
  },
  {
    id: "apnews_world",
    type: "intl_wire",
    lang: "en",
    url: "https://apnews.com/hub/world-news",
    topicHint: "international",
    expectedLabel: "has_body",
  },
  {
    id: "guardian_world",
    type: "intl_wire",
    lang: "en",
    url: "https://www.theguardian.com/world",
    topicHint: "international",
    expectedLabel: "has_body",
  },
  {
    id: "cnn_world",
    type: "intl_wire",
    lang: "en",
    url: "https://edition.cnn.com/world",
    topicHint: "international",
    expectedLabel: "has_body",
  },
  {
    id: "cnbc_markets",
    type: "finance",
    lang: "en",
    url: "https://www.cnbc.com/markets/",
    topicHint: "finance",
    expectedLabel: "has_body",
  },
  {
    id: "marketwatch_home",
    type: "finance",
    lang: "en",
    url: "https://www.marketwatch.com/",
    topicHint: "finance",
    expectedLabel: "shell",
  },
  {
    id: "cna_taiwan",
    type: "zh_tw",
    lang: "zh",
    url: "https://www.cna.com.tw/",
    topicHint: "taiwan",
    expectedLabel: "has_body",
  },
  {
    id: "udn_money",
    type: "zh_tw",
    lang: "zh",
    url: "https://money.udn.com/money/index",
    topicHint: "finance",
    expectedLabel: "has_body",
  },
  {
    id: "ltn_news",
    type: "zh_tw",
    lang: "zh",
    url: "https://news.ltn.com.tw/",
    topicHint: "taiwan",
    expectedLabel: "has_body",
  },
  {
    id: "microsoft_newsroom",
    type: "corp_newsroom",
    lang: "en",
    url: "https://news.microsoft.com/",
    topicHint: "tech",
    expectedLabel: "has_body",
  },
  {
    id: "apple_newsroom",
    type: "corp_newsroom",
    lang: "en",
    url: "https://www.apple.com/newsroom/",
    topicHint: "tech",
    expectedLabel: "has_body",
  },
  {
    id: "sec_edgar_search",
    type: "gov_filing",
    lang: "en",
    url: "https://www.sec.gov/edgar/search/",
    topicHint: "finance",
    expectedLabel: "has_body",
  },
  {
    id: "whitehouse_briefing",
    type: "gov_filing",
    lang: "en",
    url: "https://www.whitehouse.gov/briefing-room/",
    topicHint: "politics",
    expectedLabel: "has_body",
  },
  {
    id: "synthetic_css_shell",
    type: "shell_or_paywall",
    lang: "en",
    url: "https://example.com/synthetic-css-shell",
    topicHint: "tech",
    expectedLabel: "shell",
  },
  {
    id: "synthetic_grounding_redirect",
    type: "grounding_redirect",
    lang: "en",
    url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/synthetic-fixture",
    topicHint: "tech",
    expectedLabel: "shell",
  },
  {
    id: "nvidia_newsroom_hub",
    type: "corp_newsroom",
    lang: "en",
    url: "https://nvidianews.nvidia.com/",
    topicHint: "tech",
    expectedLabel: "has_body",
  },
];

const SYNTHETIC_HTML: Record<string, string> = {
  synthetic_css_shell: `<!doctype html><html><head><title>CNN Style Shell</title>
<style>@font-face{font-family:"CNN";src:url(/x.woff2)} .nav{display:flex}</style></head>
<body>${"@font-face { font-family: X; src: url(a); } body { margin:0; } a { color:#00f; } ".repeat(30)}
Skip to main content Sign in Subscribe</body></html>`,
  synthetic_grounding_redirect: `<!doctype html><html><head><title>Redirect interstitial</title>
<meta http-equiv="refresh" content="0;url=https://www.reuters.com/technology/example"></head>
<body>Skip to main content. Redirecting…</body></html>`,
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { safeFetchText } = await import("../lib/research-v2/ssrf");
  const { extractArticleFromHtml } = await import("../lib/research-v2/article-extract");

  const items: Record<string, unknown>[] = [];

  for (const spec of SPECS) {
    let html = "";
    let fetchStatus = "ok";
    let resolvedUrl = spec.url;
    let redirectHops = 0;
    let reason = "";

    if (SYNTHETIC_HTML[spec.id]) {
      html = SYNTHETIC_HTML[spec.id];
      fetchStatus = "synthetic";
    } else {
      try {
        const r = await safeFetchText(spec.url, { maxBytes: 400_000 });
        html = r.body || "";
        fetchStatus = r.fetchStatus;
        resolvedUrl = r.resolvedUrl || spec.url;
        redirectHops = r.redirectHops;
        reason = r.reason || "";
        if (!html) {
          html = `<!doctype html><html><head><title>fetch-failed</title></head><body>Skip to main content. fetchStatus=${fetchStatus} ${reason}</body></html>`;
          spec.expectedLabel = "shell";
        }
      } catch (e) {
        html = `<!doctype html><html><body>Skip to main content. error</body></html>`;
        fetchStatus = "error";
        spec.expectedLabel = "shell";
        reason = e instanceof Error ? e.message : String(e);
      }
    }

    const hash = sha256(html);
    const file = `${spec.id}.html`;
    writeFileSync(path.join(OUT, file), html, "utf8");
    const extracted = extractArticleFromHtml(html, { url: resolvedUrl });
    items.push({
      ...spec,
      file,
      htmlSha256: hash,
      bytes: html.length,
      fetchStatus,
      resolvedUrl,
      redirectHops,
      reason,
      extractIsMainBody: extracted.isMainBody,
      extractDegradeReason: extracted.degradeReason ?? null,
      publishedAt: extracted.publishedAt ?? null,
      collectedAt: new Date().toISOString(),
    });
    console.log(
      `${spec.id}: bytes=${html.length} body=${extracted.isMainBody} label=${spec.expectedLabel} status=${fetchStatus}`,
    );
  }

  // 鎖 hold-out：固定種子挑選，涵蓋組成要求
  const byId = Object.fromEntries(items.map((x) => [(x as { id: string }).id, x]));
  const holdOutIds = [
    "cna_taiwan", // 中文
    "reuters_tech_sample", // 通訊社／大型英文
    "whitehouse_briefing", // 短篇官方公告取向
    "synthetic_css_shell", // 殼／CSS
    "guardian_world", // 大型英文媒體
  ];
  for (const id of holdOutIds) {
    if (!byId[id]) throw new Error(`hold-out missing ${id}`);
  }

  const manifest = {
    lockedAt: new Date().toISOString(),
    note: "hold-out 鎖定後開發不得針對其調整抽取規則",
    holdOutIds,
    holdOut: holdOutIds.map((id) => ({
      id,
      htmlSha256: (byId[id] as { htmlSha256: string }).htmlSha256,
      type: (byId[id] as { type: string }).type,
      expectedLabel: (byId[id] as { expectedLabel: string }).expectedLabel,
    })),
    devIds: SPECS.map((s) => s.id).filter((id) => !holdOutIds.includes(id)),
    items,
  };

  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nWrote ${items.length} fixtures; hold-out=${holdOutIds.join(",")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
