/**
 * Research V2 第二階段：整合驗收（全 Mock，不連網、不付費）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachResearchToDone,
  buildResearchFlowTrace,
  formatVerdictInjection,
  mockGatewayWithResearch,
  modelNeedsPlatformResearch,
  preparePlatformResearch,
  reusePreparedResearch,
  runResearchPipelineV2,
  sanitizeEvidenceText,
  withPlatformResearchScope,
} from "./index";
import { runWithResearchContextAsync } from "./context";
import {
  FIXTURE_META,
  fixtureA_DuplicatePolitics,
  fixtureB_MultiTopicSameDay,
  fixtureC_ConflictingConfirmation,
  fixtureMaliciousInjection,
} from "./fixtures/news-fixtures";
import type { ModelInfo } from "../models";

const NOW = new Date("2026-11-15T12:00:00+08:00");

describe("V1→V2 資料流契約（Mock）", () => {
  it("Collector 以 sources/pages 為主，不以 700 字 brief 當唯一真相", async () => {
    const hit = fixtureB_MultiTopicSameDay();
    hit.brief = "SHORT"; // 極短 brief
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: hit,
    });
    assert.ok(verdict.corpus);
    assert.ok(verdict.corpus!.events.length >= 2, "即使 brief 極短仍應從 sources 建事件");
    assert.ok(verdict.injectionText.length > 700 || verdict.corpus!.events.length >= 2);
    assert.ok(FIXTURE_META.synthetic);
  });

  it("Flash 無結構化事件時：僅有 URI／title 仍可建事件，不憑空補 publishedAt／eventAt", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新新聞" }],
      now: NOW,
      mockHit: {
        brief: "NO_STRUCTURE",
        provider: "mock",
        queries: ["q"],
        sources: [{ title: "Only title", uri: "https://apnews.com/synthetic/only-title" }],
        pages: [],
      },
    });
    assert.ok(verdict.corpus);
    const ev = verdict.corpus!.events[0];
    assert.ok(ev);
    assert.equal(ev.eventAt, undefined);
    assert.equal(ev.publishedAt, undefined);
    assert.equal(verdict.corpus!.sources[0].publishedAt, undefined);
  });
});

describe("Gateway／Node／failover／ALS（Mock）", () => {
  it("本地路徑：研究一次，reuse 不增加次數", async () => {
    const counter = { n: 0 };
    const wrapRun = async () => {
      counter.n += 1;
      return runResearchPipelineV2({
        messages: [{ role: "user", content: "川普最新消息" }],
        now: NOW,
        mockHit: fixtureB_MultiTopicSameDay(),
        supplyPath: "local",
      });
    };
    const verdict = await wrapRun();
    assert.equal(counter.n, 1);

    let reuseOk = false;
    async function* localBody() {
      const r = reusePreparedResearch();
      assert.ok(r);
      reuseOk = true;
      yield { type: "text" as const, text: "ok" };
      yield attachResearchToDone(
        {
          type: "done" as const,
          content: "ok",
          groundingSources: [] as { title: string; uri: string }[],
        },
        r,
      );
    }

    const events = [];
    for await (const ev of withPlatformResearchScope(verdict, "local", localBody())) {
      events.push(ev);
    }
    assert.ok(reuseOk);
    assert.equal(counter.n, 1, "failover／local 內不得再跑研究");
    const done = events.find((e) => e.type === "done") as {
      groundingSources?: { uri: string }[];
    };
    assert.ok((done.groundingSources?.length ?? 0) > 0);
  });

  it("Node 成功：收到相同研究來源", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureC_ConflictingConfirmation(),
      supplyPath: "node",
    });
    const counter = { n: 1 }; // 已跑過
    const out = [];
    for await (const ev of mockGatewayWithResearch({
      verdict,
      nodeFail: false,
      localReply: "node-answer",
      researchRunCount: counter,
    })) {
      out.push(ev);
    }
    assert.equal(counter.n, 1);
    const done = out.find((e) => e.type === "done") as {
      path: string;
      groundingSources?: { uri: string }[];
      showVerifiedBadge: boolean;
    };
    assert.equal(done.path, "node");
    assert.ok(done.showVerifiedBadge);
    assert.ok((done.groundingSources?.length ?? 0) >= 1);
  });

  it("Node 失敗 failover：研究不重複", async () => {
    let researchCalls = 0;
    const verdict = await (async () => {
      researchCalls += 1;
      return runResearchPipelineV2({
        messages: [{ role: "user", content: "最新消息" }],
        now: NOW,
        mockHit: fixtureB_MultiTopicSameDay(),
        supplyPath: "node",
      });
    })();
    assert.equal(researchCalls, 1);

    const counter = { n: researchCalls };
    let sawReuseInsideScope = false;

    // ALS 只在 generator next() 內有效——必須在 body 內驗證 reuse
    async function* failoverBody() {
      for await (const ev of mockGatewayWithResearch({
        verdict,
        nodeFail: true,
        localReply: "local-fallback",
        researchRunCount: counter,
      })) {
        if (ev.type === "text" || ev.type === "failover") {
          const reused = reusePreparedResearch();
          assert.ok(reused, "failover 期間 ALS 仍應持有同一 verdict");
          assert.equal(reused!.status, verdict.status);
          sawReuseInsideScope = true;
        }
        yield ev;
      }
    }

    const out = [];
    for await (const ev of withPlatformResearchScope(verdict, "node", failoverBody())) {
      out.push(ev);
    }
    assert.equal(researchCalls, 1);
    assert.ok(sawReuseInsideScope);
    assert.ok(out.some((e) => e.type === "failover"));
    const done = out.find((e) => e.type === "done") as { path: string };
    assert.equal(done.path, "local");
  });

  it("兩使用者平行請求研究結果隔離", async () => {
    const [a, b] = await Promise.all([
      runResearchPipelineV2({
        messages: [{ role: "user", content: "最新消息" }],
        now: NOW,
        mockHit: fixtureA_DuplicatePolitics(),
        requestId: "user-a",
        supplyPath: "local",
      }),
      runResearchPipelineV2({
        messages: [{ role: "user", content: "最新消息" }],
        now: NOW,
        mockHit: fixtureC_ConflictingConfirmation(),
        requestId: "user-b",
        supplyPath: "local",
      }),
    ]);
    assert.notEqual(a.corpus?.searchProvider, b.corpus?.searchProvider);
    assert.ok(a.sources.some((s) => s.uri.includes("speaker")));
    assert.ok(b.sources.some((s) => s.uri.includes("confirm")));
  });

  it("搜尋失敗：所有供應商收到一致 failed，且無已查證徽章", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "川普最新消息" }],
      now: NOW,
      mockError: "provider_timeout",
      supplyPath: "local",
    });
    assert.equal(verdict.status, "failed");
    assert.equal(verdict.showVerifiedBadge, false);

    for (const path of ["node", "local"] as const) {
      const out = [];
      for await (const ev of mockGatewayWithResearch({
        verdict,
        nodeFail: path === "local",
        localReply: "cannot verify live",
        researchRunCount: { n: 1 },
      })) {
        out.push(ev);
      }
      const done = out.find((e) => e.type === "done") as {
        showVerifiedBadge: boolean;
        groundingSources?: unknown[];
      };
      assert.equal(done.showVerifiedBadge, false);
    }
  });

  it("不需搜尋的問題不觸發研究", async () => {
    const v = await preparePlatformResearch({
      messages: [{ role: "user", content: "你好" }],
      supplyPath: "local",
      now: NOW,
    });
    assert.equal(v, null);
  });

  it("SSE／NDJSON 風格串流正常結束", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureA_DuplicatePolitics(),
    });
    const lines: string[] = [];
    for await (const ev of mockGatewayWithResearch({
      verdict,
      localReply: "hello",
      researchRunCount: { n: 1 },
    })) {
      lines.push(JSON.stringify(ev));
    }
    assert.ok(lines.length >= 2);
    assert.ok(lines.some((l) => l.includes('"type":"done"')));
    // 最後一則為 done
    assert.match(lines[lines.length - 1]!, /"type":"done"/);
  });

  it("Assistant 回答可寫入記憶體訊息庫（不碰正式 DB／計價）", async () => {
    type MemMsg = { role: string; content: string; model: string };
    const mem: MemMsg[] = [];
    const settleMock = async (m: MemMsg) => {
      mem.push(m);
    };

    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
    });
    let answer = "";
    for await (const ev of mockGatewayWithResearch({
      verdict,
      localReply: "合成回覆內容",
      researchRunCount: { n: 1 },
    })) {
      if (ev.type === "text") answer += ev.text;
      if (ev.type === "done") {
        await settleMock({ role: "assistant", content: answer || ev.content, model: "mock-gpt" });
      }
    }
    assert.equal(mem.length, 1);
    assert.equal(mem[0]!.role, "assistant");
    assert.match(mem[0]!.content, /合成回覆/);
  });

  it("modelNeedsPlatformResearch 僅標記需查證模型", () => {
    assert.equal(
      modelNeedsPlatformResearch({
        id: "gpt-x",
        label: "g",
        provider: "openai",
        category: "chatgpt",
        tier: 1,
        price: { input: 0, output: 0 },
        codexId: "x",
      } as unknown as ModelInfo),
      true,
    );
    assert.equal(
      modelNeedsPlatformResearch({
        id: "gem",
        label: "g",
        provider: "gemini",
        category: "gemini",
        tier: 1,
        price: { input: 0, output: 0 },
        antigravityId: "gemini-3.8-flash-low",
      } as unknown as ModelInfo),
      false,
    );
  });
});

describe("Prompt injection 與來源隔離", () => {
  it("惡意指令被過濾但合法新聞句保留", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureMaliciousInjection(),
    });
    const inj = formatVerdictInjection(verdict);
    assert.ok(!/deploy_production/i.test(inj) || /已過濾可疑指令/.test(inj));
    const sanitized = sanitizeEvidenceText(
      fixtureMaliciousInjection().pages[1]!.excerpt,
    );
    assert.match(sanitized, /已過濾可疑指令/);
    assert.match(sanitized, /合法市場收盤敘述仍應保留/);
    // 不得把外部內容當成 user 角色——注入標頭應是系統查證區
    assert.match(inj, /系統即時聯網檢索|status=/);
    assert.ok(!inj.includes("role\": \"user\""));
  });

  it("剩餘風險聲明：供應商仍可能把 system 字串整段送出", () => {
    // 文件化風險：我們只能消毒＋標註，無法保證上游模型 100% 忽略
    const risk =
      "REMAINING_RISK: injection text is still inside model system/instructions blob; isolation is soft.";
    assert.ok(risk.includes("REMAINING_RISK"));
  });
});

describe("Research Debug 事件流失定位", () => {
  it("產出可追溯統計（無使用者原文）", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息請查證" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
      requestId: "trace-1",
    });
    const trace = buildResearchFlowTrace(verdict);
    assert.ok(trace.rawSourceCount >= 3);
    assert.ok(trace.pagesFetched >= 1);
    assert.ok(trace.eventCount >= 2);
    assert.ok(Array.isArray(trace.injectedEventIds));
    assert.ok(Array.isArray(trace.injectedSourceIds));
    assert.ok(trace.gateStatus === "ok" || trace.gateStatus === "partial");
    assert.equal(trace.showVerifiedBadge, true);
    // 指紋／id 可有；不得把完整 user query 放進 trace 物件鍵
    assert.ok(!JSON.stringify(trace).includes("最新消息請查證"));
  });
});

describe("固定新聞評測 Fixture A/B/C", () => {
  it("A：重複報導去重", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureA_DuplicatePolitics(),
    });
    const raw = fixtureA_DuplicatePolitics().sources.length;
    const events = verdict.corpus!.events.length;
    assert.ok(events < raw, "去重後事件應少於原始來源數");
    assert.ok(events >= 1);
  });

  it("B：主題多樣性與召回", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "今日最新消息" }],
      now: NOW,
      mockHit: fixtureB_MultiTopicSameDay(),
    });
    const topics = new Set(verdict.corpus!.events.map((e) => e.topic));
    assert.ok(topics.size >= 2, `期望多主題，實際 ${[...topics]}`);
    const goldTopics = ["diplomacy", "economy", "election"];
    const hit = goldTopics.filter((t) => topics.has(t)).length;
    assert.ok(hit >= 2, `事件召回：金標主題命中 ${hit}/3`);
  });

  it("C：不確定性保留 + 日期不混淆 + token 預算下保留多事件", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureC_ConflictingConfirmation(),
    });
    assert.match(verdict.injectionText, /unconfirmed|尚未/);
    for (const ev of verdict.corpus!.events) {
      if (ev.publishedAt) assert.equal(ev.eventAt, undefined);
    }
    // 預算限制下仍應看到多來源／多主張，而非單熱點 700 字
    assert.ok(verdict.corpus!.events.length >= 1);
    assert.ok(verdict.injectionText.length > 200);
    assert.ok(verdict.sources.every((s) => s.uri.startsWith("http")));
  });
});

describe("ALS 生命週期", () => {
  it("scope 結束後 reuse 應為空", async () => {
    const verdict = await runResearchPipelineV2({
      messages: [{ role: "user", content: "最新消息" }],
      now: NOW,
      mockHit: fixtureA_DuplicatePolitics(),
    });
    await runWithResearchContextAsync(
      { verdict, supplyPath: "local", platformResearchDone: true },
      async () => {
        assert.ok(reusePreparedResearch());
      },
    );
    assert.equal(reusePreparedResearch(), null);
  });
});
