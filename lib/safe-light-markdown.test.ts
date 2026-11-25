import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** 與 SafeLightMarkdown 相同的剝離規則（純函式測，不掛 React） */
function stripRawHtml(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function cleanHref(raw: string): string {
  const t = raw.replace(/[),.;:!?，。；：！？]+$/g, "").trim();
  if (!t || t.includes("…") || t.includes("...")) return "";
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

describe("safe markdown helpers", () => {
  it("strips raw HTML tags", () => {
    assert.equal(stripRawHtml('hello <script>alert(1)</script> world'), "hello alert(1) world");
    assert.equal(stripRawHtml("<img src=x onerror=alert(1)>"), "");
  });

  it("only allows http(s) links", () => {
    assert.equal(cleanHref("https://example.com/a"), "https://example.com/a");
    assert.equal(cleanHref("javascript:alert(1)"), "");
    assert.equal(cleanHref("data:text/html,hi"), "");
  });
});
