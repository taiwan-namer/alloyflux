import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeMessageCursor,
  encodeMessageCursor,
  pickRelevantSnippets,
  selectBoundedHistory,
  shouldPersistPartialAssistant,
  shouldUpgradeTurnCompletion,
  STRATEGY_LIMITS,
} from "./strategy-loop";

describe("pickRelevantSnippets", () => {
  const chunks = [
    "[決策] F 方案停損設在 ATR 的 1.5 倍",
    "[發現] 亞洲時段的勝率明顯較低",
    "[報告 交易統計] BTCUSDT 空單平均持倉 3.2 小時",
    "[發言] 今天先不討論資金費率",
  ];

  it("挑出與問題重疊的段落並保持原順序", () => {
    const out = pickRelevantSnippets(chunks, "停損和 ATR 怎麼設定？亞洲時段呢", 2000);
    assert.ok(out.includes("停損"));
    assert.ok(out.includes("亞洲時段"));
    assert.ok(!out.includes("資金費率"));
    assert.ok(out.indexOf("停損") < out.indexOf("亞洲時段"));
  });

  it("不超過字數上限", () => {
    const long = Array.from({ length: 50 }, (_, i) => `停損 參數 ${i} ${"x".repeat(200)}`);
    const out = pickRelevantSnippets(long, "停損參數", 2000);
    assert.ok(out.length <= 2000 + 50 * 3);
    assert.ok(out.length > 0);
  });

  it("沒有相關內容時回傳空字串", () => {
    assert.equal(pickRelevantSnippets(chunks, "以太坊合併", 2000), "");
  });
});

describe("4A selectBoundedHistory", () => {
  it("預設取最新 N 則且以 user 開頭", () => {
    const msgs = [
      { role: "assistant", content: "old-a" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const out = selectBoundedHistory(msgs, { maxMessages: 4, maxChars: 10000 });
    assert.equal(out.length, 4);
    assert.equal(out[0]!.role, "user");
    assert.equal(out[0]!.content, "u1");
    assert.equal(out[out.length - 1]!.content, "a2");
  });

  it("超過字元 budget 時從最舊成對裁切", () => {
    const msgs = [
      { role: "user", content: "U".repeat(100) },
      { role: "assistant", content: "A".repeat(100) },
      { role: "user", content: "u-new" },
      { role: "assistant", content: "a-new" },
    ];
    const out = selectBoundedHistory(msgs, { maxMessages: 12, maxChars: 50 });
    assert.ok(out.length <= 4);
    assert.ok(out.some((m) => m.content.includes("new")));
    assert.ok(out.reduce((n, m) => n + m.content.length, 0) <= 50 + 200);
  });

  it("STRATEGY_LIMITS.historyMessages 預設為 12", () => {
    assert.equal(STRATEGY_LIMITS.historyMessages, 12);
  });
});

describe("4A message cursor", () => {
  it("encode/decode 往返", () => {
    const enc = encodeMessageCursor(12345, "smsg_abc");
    const dec = decodeMessageCursor(enc);
    assert.deepEqual(dec, { createdAt: 12345, id: "smsg_abc" });
  });

  it("非法游標回 null", () => {
    assert.equal(decodeMessageCursor(""), null);
    assert.equal(decodeMessageCursor("nope"), null);
    assert.equal(decodeMessageCursor(":onlyid"), null);
  });
});

describe("4A partial／idempotent 契約（純函式／記憶體模擬）", () => {
  it("空 visible 不寫 lead assistant", () => {
    assert.equal(shouldPersistPartialAssistant(""), false);
    assert.equal(shouldPersistPartialAssistant("   "), false);
    assert.equal(shouldPersistPartialAssistant("有字"), true);
  });

  it("aborted→ok 可升級；ok→aborted 不可", () => {
    assert.equal(shouldUpgradeTurnCompletion("aborted", "ok"), true);
    assert.equal(shouldUpgradeTurnCompletion("failed", "degraded"), true);
    assert.equal(shouldUpgradeTurnCompletion("ok", "aborted"), false);
    assert.equal(shouldUpgradeTurnCompletion("ok", "ok"), false);
  });

  it("同 turnId 重複 partial／finalize 不增生列（Map 模擬 route 層）", () => {
    type Row = { turnId: string; role: string; speakerRole: string | null; status: string; content: string };
    const key = (r: Pick<Row, "turnId" | "role" | "speakerRole">) =>
      `${r.turnId}|${r.role}|${r.speakerRole ?? ""}`;
    const store = new Map<string, Row>();
    function upsert(row: Row) {
      const k = key(row);
      const prev = store.get(k);
      if (!prev) {
        store.set(k, row);
        return { deduped: false, size: store.size };
      }
      if (shouldUpgradeTurnCompletion(prev.status as never, row.status as never)) {
        store.set(k, { ...prev, content: row.content, status: row.status });
        return { deduped: true, size: store.size };
      }
      return { deduped: true, size: store.size };
    }
    upsert({ turnId: "t1", role: "user", speakerRole: null, status: "aborted", content: "q" });
    upsert({ turnId: "t1", role: "user", speakerRole: null, status: "aborted", content: "q" });
    assert.equal(store.size, 1);
    upsert({
      turnId: "t1",
      role: "assistant",
      speakerRole: "lead",
      status: "aborted",
      content: "half",
    });
    const afterPartial = upsert({
      turnId: "t1",
      role: "assistant",
      speakerRole: "lead",
      status: "aborted",
      content: "half",
    });
    assert.equal(afterPartial.deduped, true);
    assert.equal(store.size, 2);
    upsert({
      turnId: "t1",
      role: "assistant",
      speakerRole: "lead",
      status: "ok",
      content: "full reply",
    });
    assert.equal(store.size, 2);
    assert.equal(store.get("t1|assistant|lead")?.content, "full reply");
    assert.equal(store.get("t1|assistant|lead")?.status, "ok");
  });
});
