import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractArticleFromHtml,
  injectionHasTemplatePollution,
  isStructuredFilingUrl,
  looksLikeCssOrTemplatePollution,
} from "./article-extract";

describe("article-extract 品質閘門（通用）", () => {
  it("CNN 風格 @font-face CSS 不得標為正文", () => {
    const html = `<html><head><title>World News</title><style>@font-face{font-family:"CNN";src:url(/a.woff2)}</style></head>
<body><div>${"@font-face { font-family: X; src: url(a); } ".repeat(20)}</div></body></html>`;
    const r = extractArticleFromHtml(html, { url: "https://www.cnn.com/world/example" });
    assert.equal(r.isMainBody, false);
    assert.ok(r.degradeReason);
  });

  it("Guardian Skip to main content 短殼不得標為正文", () => {
    const html = `<html><title>Airport crash</title><body>Skip to main content Skip to navigation Sign in Subscribe Newsletter</body></html>`;
    const r = extractArticleFromHtml(html, { url: "https://www.theguardian.com/world/example" });
    assert.equal(r.isMainBody, false);
  });

  it("正常 article 主文可通過", () => {
    const paras = Array.from({ length: 6 }, (_, i) =>
      `<p>This is a substantial news paragraph number ${i} about an international event with clear reporting details and quotes from officials.</p>`,
    ).join("");
    const html = `<html><head><title>Real Story</title>
<meta property="article:published_time" content="2026-11-10T08:00:00Z"/>
</head><body><article>${paras}</article></body></html>`;
    const r = extractArticleFromHtml(html, { url: "https://www.reuters.com/world/example" });
    assert.equal(r.isMainBody, true);
    assert.ok(r.excerpt.length >= 120);
    assert.ok(r.publishedAt?.startsWith("2026-11-10"));
    assert.equal(injectionHasTemplatePollution(r.excerpt), false);
  });

  it("SEC EDGAR 以路徑判定文件類型，非公司名", () => {
    assert.equal(
      isStructuredFilingUrl(
        "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000082/nvda-20261111.htm",
      ),
      true,
    );
    assert.equal(isStructuredFilingUrl("https://www.reuters.com/technology/nvidia"), false);
  });

  it("looksLikeCssOrTemplatePollution 偵測樣板", () => {
    assert.equal(looksLikeCssOrTemplatePollution("@font-face { font-family: A; } body { color: red; } a { x:1; } b { y:2; } c { z:3; }"), true);
    assert.equal(looksLikeCssOrTemplatePollution("Skip to main content"), true);
  });

  it("高連結密度列表頁不得標正文", () => {
    const links = Array.from(
      { length: 20 },
      (_, i) => `<li><a href="/n/${i}">短標題新聞 ${i} 造勢晚會</a></li>`,
    ).join("");
    const html = `<html><body><main><ul>${links}</ul></main></body></html>`;
    const r = extractArticleFromHtml(html, { url: "https://example.com/list" });
    assert.equal(r.isMainBody, false);
    assert.match(r.degradeReason || "", /list_or_hub|not_usable|missing_article/);
  });

  it("含 Sign in／Advertisement 字樣的正常長文與 SaaS Pricing／BYOK 頁不得被誤殺", () => {
    const pricingHtml = `<html><head><title>OpenRouter Pricing</title></head><body>
      <main>
        <nav><a href="/docs">Docs</a> <a href="/models">Models</a> <a href="/login">Sign in</a></nav>
        <h1>OpenRouter Pricing &amp; Credits</h1>
        <div>Free Tier: $0 — 25+ free models, 20 req/min, 50 req/day.</div>
        <div>Standard Credit Purchase: 5.5% platform fee ($0.80 minimum fee) when purchasing credits.</div>
        <div>Business Plan: 8.0% platform fee with EU/US in-region routing and data policy controls.</div>
        <div>Bring Your Own Key (BYOK): First 1,000,000 BYOK requests per month are free, then 5% of upstream model cost.</div>
        <p>Sign in to your account to purchase credits or enter a promo code at checkout.</p>
      </main>
    </body></html>`;
    const rPricing = extractArticleFromHtml(pricingHtml, { url: "https://openrouter.ai/pricing" });
    assert.equal(rPricing.isMainBody, true, `Pricing 頁不應被誤殺，degradeReason=${rPricing.degradeReason}`);
    assert.match(rPricing.excerpt, /5\.5%/);
    assert.match(rPricing.excerpt, /BYOK/);

    const newsWithAd = `<html><head><title>Tech Ruling</title></head><body><article>
      <p>Federal prosecutors announced new enforcement actions on Tuesday following a lengthy investigation into cloud credential theft across multiple states.</p>
      <p>Advertisement</p>
      <p>Investigators noted that attackers harvested keys after developers accidentally committed configuration files when they log in to staging servers.</p>
      <p>Officials urged enterprises to rotate exposed tokens immediately and enforce strict network policies across all production deployments.</p>
    </article></body></html>`;
    const rNews = extractArticleFromHtml(newsWithAd, { url: "https://www.reuters.com/technology/ruling-2026" });
    assert.equal(rNews.isMainBody, true, "文中夾 Advertisement 或 log in 的長篇新聞不應被誤殺");
  });
});
