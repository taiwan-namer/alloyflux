import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countCursorTurnsSinceWeb,
  parseLeanTurnType,
  readRoomMode,
  buildReportInjection,
  reportSeriesKey,
  selectStrategyHistory,
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

describe("selectStrategyHistory（cache 友善視窗）", () => {
  const mk = (n: number, len = 50) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}-${"x".repeat(len)}`,
      structured: null as Record<string, unknown> | null,
    }));

  it("起點對齊格線：連續兩回合（+2 則）開頭相同", () => {
    const all = mk(30);
    const a = selectStrategyHistory(all.slice(0, 24));
    const b = selectStrategyHistory(all.slice(0, 26));
    assert.equal(a[0]!.content, b[0]!.content);
  });

  it("只撈最新 N 則時用 offset 維持絕對格線", () => {
    const all = mk(60);
    const full = selectStrategyHistory(all);
    const partial = selectStrategyHistory(all.slice(20), { offset: 20 });
    assert.equal(full[0]!.content, partial[0]!.content);
    assert.equal(full.length, partial.length);
  });

  it("排除通知與顧問訊息，且從 user 開頭", () => {
    const msgs = mk(10);
    msgs[8]!.structured = { kind: "note" };
    msgs[9]!.structured = { kind: "advisor" };
    const out = selectStrategyHistory(msgs);
    assert.ok(out.every((m) => !m.structured));
    assert.equal(out[0]!.role, "user");
  });

  it("較舊的 assistant 壓縮、最後一則 assistant 保留全文", () => {
    const msgs = mk(8, 3000);
    const out = selectStrategyHistory(msgs, { maxChars: 1_000_000 });
    assert.ok(out[1]!.content.length < 3000);
    assert.equal(out[out.length - 1]!.content.length, msgs[7]!.content.length);
  });
});

describe("buildReportInjection", () => {
  const r = (id: string, title: string, createdAt: number, content = "body") => ({
    id,
    requestId: "",
    title,
    content,
    chars: content.length,
    createdAt,
  });

  it("系列標題去掉 _pN", () => {
    assert.equal(reportSeriesKey("4A_evidence_p2"), reportSeriesKey("4A_evidence"));
    assert.equal(reportSeriesKey("4A-evidence-p3"), "4a-evidence");
  });

  it("只注入上一回合之後的新報告與指名報告，同系列合併", () => {
    const reports = [
      r("srep_new2", "code_p2", 300, "second"),
      r("srep_new1", "code_p1", 200, "first"),
      r("srep_old", "舊報告", 50),
      r("srep_focus", "指名報告", 40, "focused"),
    ];
    const out = buildReportInjection(reports, { lastHostTurnAt: 100, focusIds: ["srep_focus"] });
    assert.deepEqual(new Set(out.injectedIds), new Set(["srep_new1", "srep_new2", "srep_focus"]));
    assert.ok(out.bodies.indexOf("first") < out.bodies.indexOf("second"));
    assert.match(out.bodies, /2 段已合併/);
    assert.match(out.index, /srep_old/);
    assert.doesNotMatch(out.index, /srep_new1/);
  });
});

describe("精簡會議室回合閘門", () => {
  const u = (source: string, kind?: string) => ({ role: "user", structured: { source, ...(kind ? { kind } : {}) } });
  const a = () => ({ role: "assistant", structured: {} });

  it("從最後一則網頁訊息起算 Cursor 觸發的回合，通知不算", () => {
    const msgs = [u("cursor"), a(), u("web"), a(), u("cursor"), a(), u("cursor", "note"), u("cursor"), a()];
    assert.equal(countCursorTurnsSinceWeb(msgs), 2);
  });

  it("沒有網頁訊息時全部都算", () => {
    assert.equal(countCursorTurnsSinceWeb([u("cursor"), a(), u("cursor"), a()]), 2);
  });

  it("只接受 align／report", () => {
    assert.equal(parseLeanTurnType("align"), "align");
    assert.equal(parseLeanTurnType("report"), "report");
    assert.equal(parseLeanTurnType("progress"), null);
    assert.equal(readRoomMode({ mode: "lean" }), "lean");
    assert.equal(readRoomMode({}), "classic");
  });

  it("使用者原文不裁，較舊主持人回覆壓到 1800 字", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "y".repeat(5000),
      structured: null,
    }));
    const out = selectStrategyHistory(msgs, { maxChars: 1_000_000 });
    assert.equal(out[0]!.content.length, 5000);
    const olderAssistant = out.find((m, i) => m.role === "assistant" && i !== out.length - 1);
    assert.ok(olderAssistant);
    assert.match(olderAssistant!.content, /中略/);
    assert.ok(olderAssistant!.content.length < 1900);
    assert.equal(out[out.length - 1]!.content.length, 5000);
  });
});
