import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLedgerTurn,
  emptyLedger,
  readLedger,
  renderLedgerAnchor,
  renderLedgerForHost,
  validateLedgerInput,
  type StrategyLedger,
} from "./strategy-ledger";

const NOW = 1_795_600_000_000;

function seeded(): StrategyLedger {
  const r = validateLedgerInput(
    {
      currentItemId: "4B",
      items: [
        { id: "4A", title: "地基與效能", status: "done" },
        { id: "4B", title: "品牌體感與失靈修復", status: "in_progress" },
        { id: "4B-DE", title: "隔離驗收工具 D/E", status: "parked", parentId: "4B", resumeTrigger: "4B 驗收時" },
        { id: "4C", title: "模型選擇器", status: "todo" },
      ],
    },
    NOW,
  );
  assert.ok(r.ok);
  return r.ledger;
}

const pkgInput = {
  id: "wp-4b-1",
  itemId: "4B",
  goal: "修好秒停",
  scope: ["components/StrategyRoomView.tsx"],
  acceptance: ["按停止 1 秒內停止吐字"],
  stopConditions: ["需要改後端串流"],
};

describe("strategy ledger", () => {
  it("validateLedgerInput 擋掉壞資料與重複 id", () => {
    assert.equal(validateLedgerInput({ items: [] }).ok, false);
    assert.equal(validateLedgerInput({ items: [{ id: "a", title: "x" }, { id: "a", title: "y" }] }).ok, false);
    assert.equal(validateLedgerInput({ items: [{ id: "a", title: "x" }], currentItemId: "zzz" }).ok, false);
  });

  it("readLedger 對壞 meta 回傳空帳本", () => {
    assert.deepEqual(readLedger({ ledger: "nope" }), emptyLedger());
    assert.deepEqual(readLedger(undefined), emptyLedger());
  });

  it("帳本未啟用時不攔截指令，但記錄上一輪指令", () => {
    const r = applyLedgerTurn(emptyLedger(), { instructions: ["改 A 檔"], reportRequests: [] }, NOW);
    assert.equal(r.allowedInstructions.length, 1);
    assert.equal(r.held.length, 0);
    assert.deepEqual(r.ledger.lastHostTurn?.instructions, ["改 A 檔"]);
  });

  it("部署／push 指令一律保留", () => {
    const r = applyLedgerTurn(
      seeded(),
      { instructions: ["跑測試", "完成後 git push origin main"], reportRequests: [] },
      NOW,
    );
    assert.equal(r.allowedInstructions.length, 1);
    assert.equal(r.held.length, 1);
    assert.match(r.held[0]!.reason, /發起人/);
  });

  it("禁令句不保留；同句另有要執行的部署子句仍保留", () => {
    const r = applyLedgerTurn(
      seeded(),
      {
        instructions: [
          "本包不包含部署、push、正式資料庫寫入、交易操作或新跑盤，這些不是待批准的調查前置條件。既有進程保持不動。",
          "未經主持人驗收禁止 git push 部署",
          "部署前不得跳過測試，完成後部署到正式環境",
        ],
        reportRequests: [],
      },
      NOW,
    );
    assert.equal(r.allowedInstructions.length, 2);
    assert.equal(r.held.length, 1);
    assert.match(r.held[0]!.text, /完成後部署/);
  });

  it("同 ID 工作包重新下發沿用退回次數，第二次退回仍進僵局", () => {
    let l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW + 1).ledger;
    const resent = applyLedgerTurn(
      l,
      { workPackage: { ...pkgInput, goal: "限縮：只交現況" }, instructions: [], reportRequests: [] },
      NOW + 2,
    );
    assert.equal(resent.ledger.currentPackage?.rejectCount, 1);
    assert.equal(resent.ledger.currentPackage?.createdAt, NOW);
    const again = applyLedgerTurn(resent.ledger, { verdict: "reject", instructions: [], reportRequests: [] }, NOW + 3);
    assert.equal(again.escalated, true);
  });

  it("不同 ID 的新工作包計數從 0 開始", () => {
    let l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW + 1).ledger;
    const next = applyLedgerTurn(
      l,
      { workPackage: { ...pkgInput, id: "wp-4b-9" }, instructions: [], reportRequests: [] },
      NOW + 2,
    );
    assert.equal(next.ledger.currentPackage?.rejectCount, 0);
  });

  it("指令標了其他項目會被保留，標目前項目或未標則放行", () => {
    const r = applyLedgerTurn(
      seeded(),
      {
        instructions: [
          { itemId: "4C", text: "先做模型選單" },
          { itemId: "4B", text: "修秒停" },
          "補測試",
        ],
        reportRequests: [],
      },
      NOW,
    );
    assert.equal(r.allowedInstructions.length, 2);
    assert.equal(r.held.length, 1);
    assert.equal(r.held[0]!.itemId, "4C");
  });

  it("目前項目的子項目指令放行", () => {
    const r = applyLedgerTurn(
      seeded(),
      { instructions: [{ itemId: "4B-DE", text: "評估 D/E 是否還需要" }], reportRequests: [] },
      NOW,
    );
    assert.equal(r.allowedInstructions.length, 1);
    assert.equal(r.held.length, 0);
  });

  it("ledgerOps：park / setCurrent / add", () => {
    const r = applyLedgerTurn(
      seeded(),
      {
        ledgerOps: [
          { op: "park", id: "4B", reason: "等設計", resumeTrigger: "4C 完成後" },
          { op: "setCurrent", id: "4C" },
          { op: "add", id: "4C-1", title: "盤點模型分組", parentId: "4C" },
          { op: "setStatus", id: "ghost", status: "done" },
        ],
        instructions: [],
        reportRequests: [],
      },
      NOW,
    );
    const by = Object.fromEntries(r.ledger.items.map((i) => [i.id, i]));
    assert.equal(by["4B"]!.status, "parked");
    assert.equal(by["4B"]!.resumeTrigger, "4C 完成後");
    assert.equal(by["4C"]!.status, "in_progress");
    assert.equal(r.ledger.currentItemId, "4C");
    assert.ok(by["4C-1"]);
    assert.equal(by["ghost"], undefined);
  });

  it("退回 2 次進入僵局，僵局中施工指令被攔，報告需求放行", () => {
    let l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    assert.equal(l.currentPackage?.status, "executing");

    l = applyLedgerTurn(l, { verdict: "reject", verdictReason: "缺測試", instructions: ["補測試"], reportRequests: [] }, NOW).ledger;
    assert.equal(l.currentPackage?.rejectCount, 1);

    const second = applyLedgerTurn(l, { verdict: "reject", instructions: ["再修一次"], reportRequests: [] }, NOW);
    assert.equal(second.escalated, true);
    assert.equal(second.ledger.currentPackage?.status, "escalated");
    assert.equal(second.allowedInstructions.length, 0);

    const blocked = applyLedgerTurn(
      second.ledger,
      { instructions: ["又修"], reportRequests: [{ id: "r1", title: "卡關說明" }] },
      NOW,
    );
    assert.equal(blocked.allowedInstructions.length, 0);
    assert.equal(blocked.allowedReportRequests.length, 1);
    assert.match(renderLedgerForHost(blocked.ledger), /僵局處置/);
  });

  it("僵局處置 park：項目暫停、工作包清除、恢復派送", () => {
    let l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW).ledger;
    const r = applyLedgerTurn(
      l,
      {
        escalationDecision: { choice: "park", reason: "成本太高", resumeTrigger: "4C 後" },
        ledgerOps: [{ op: "setCurrent", id: "4C" }],
        instructions: [{ itemId: "4C", text: "盤點模型" }],
        reportRequests: [],
      },
      NOW,
    );
    assert.equal(r.escalated, false);
    assert.equal(r.ledger.currentPackage, null);
    assert.equal(r.ledger.items.find((i) => i.id === "4B")!.status, "parked");
    assert.equal(r.allowedInstructions.length, 1);
  });

  it("僵局處置 narrow 需搭配新工作包，計數歸零", () => {
    let l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW).ledger;
    l = applyLedgerTurn(l, { verdict: "reject", instructions: [], reportRequests: [] }, NOW).ledger;

    const noPkg = applyLedgerTurn(l, { escalationDecision: { choice: "narrow", reason: "x" }, instructions: ["修"], reportRequests: [] }, NOW);
    assert.equal(noPkg.escalated, true);

    const ok = applyLedgerTurn(
      l,
      {
        escalationDecision: { choice: "narrow", reason: "只修前端" },
        workPackage: { ...pkgInput, id: "wp-4b-2", goal: "只修前端停止按鈕" },
        instructions: ["修按鈕"],
        reportRequests: [],
      },
      NOW,
    );
    assert.equal(ok.escalated, false);
    assert.equal(ok.ledger.currentPackage?.id, "wp-4b-2");
    assert.equal(ok.ledger.currentPackage?.rejectCount, 0);
    assert.equal(ok.allowedInstructions.length, 1);
  });

  it("同回合 setBrief＋排路線圖＋開工", () => {
    const r = applyLedgerTurn(
      emptyLedger(),
      {
        ledgerOps: [
          { op: "setBrief", topic: "E 設計盤整", problems: ["卡頓", "重複"], requirements: ["不重複"], constraints: ["不部署"] },
          { op: "add", id: "P1", title: "查清楚" },
          { op: "add", id: "P2", title: "修好" },
          { op: "setCurrent", id: "P1" },
        ],
        workPackage: { ...pkgInput, id: "wp-p1", itemId: "P1" },
        instructions: [{ itemId: "P1", text: "盤點" }],
        reportRequests: [],
      },
      NOW,
    );
    assert.equal(r.ledger.brief?.topic, "E 設計盤整");
    assert.deepEqual(r.ledger.brief?.constraints, ["不部署"]);
    assert.equal(r.ledger.currentItemId, "P1");
    assert.equal(r.ledger.currentPackage?.id, "wp-p1");
    assert.equal(r.allowedInstructions.length, 1);
    const text = renderLedgerForHost(r.ledger);
    assert.match(text, /## 專案簡介\n主題：E 設計盤整/);
    assert.match(text, /## 路線圖（0\/2 完成）/);
    assert.equal(readLedger({ ledger: r.ledger }).brief?.topic, "E 設計盤整");
  });

  it("驗收通過＋下一項工作包：判舊包、寫結論、接下一項並放行指令", () => {
    const l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    const r = applyLedgerTurn(
      l,
      {
        verdict: "accept",
        conclusion: "秒停修好；測試 12 項全過",
        workPackage: { ...pkgInput, id: "wp-4c-1", itemId: "4C", goal: "做模型選單" },
        instructions: [{ itemId: "4C", text: "做模型選單" }],
        reportRequests: [],
      },
      NOW + 1,
    );
    const by = Object.fromEntries(r.ledger.items.map((i) => [i.id, i]));
    assert.equal(by["4B"]!.status, "done");
    assert.equal(by["4B"]!.conclusion, "秒停修好；測試 12 項全過");
    assert.equal(r.ledger.currentItemId, "4C");
    assert.equal(by["4C"]!.status, "in_progress");
    assert.equal(r.ledger.currentPackage?.id, "wp-4c-1");
    assert.equal(r.ledger.currentPackage?.status, "executing");
    assert.equal(r.allowedInstructions.length, 1);
    assert.match(renderLedgerForHost(r.ledger), /結論：秒停修好/);
  });

  it("驗收通過但沒給下一包：自動接下一項並提醒補工作包", () => {
    const l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    const r = applyLedgerTurn(l, { verdict: "accept", instructions: [], reportRequests: [] }, NOW + 1);
    assert.equal(r.ledger.currentItemId, "4C");
    assert.equal(r.ledger.currentPackage, null);
    assert.ok(r.events.some((e) => /未寫結論/.test(e)));
    assert.match(renderLedgerForHost(r.ledger), /目前項目 4C 沒有工作包/);
    assert.match(renderLedgerAnchor(r.ledger), /沒有工作包/);
  });

  it("驗收通過但同回合替同一項目開新包：項目不結案", () => {
    const l = applyLedgerTurn(seeded(), { workPackage: pkgInput, instructions: [], reportRequests: [] }, NOW).ledger;
    const r = applyLedgerTurn(
      l,
      { verdict: "accept", workPackage: { ...pkgInput, id: "wp-4b-2" }, instructions: [], reportRequests: [] },
      NOW + 1,
    );
    assert.equal(r.ledger.items.find((i) => i.id === "4B")!.status, "in_progress");
    assert.equal(r.ledger.currentItemId, "4B");
    assert.equal(r.ledger.currentPackage?.id, "wp-4b-2");
    assert.equal(r.ledger.currentPackage?.status, "executing");
  });

  it("最後一項完成：路線圖全部完成", () => {
    const v = validateLedgerInput({ items: [{ id: "A", title: "唯一", status: "in_progress" }], currentItemId: "A" }, NOW);
    assert.ok(v.ok);
    if (!v.ok) return;
    const r = applyLedgerTurn(
      v.ledger,
      { ledgerOps: [{ op: "complete", id: "A", conclusion: "完成" }], instructions: [], reportRequests: [] },
      NOW,
    );
    assert.equal(r.ledger.currentItemId, null);
    assert.ok(r.events.some((e) => /全部完成/.test(e)));
  });

  it("新會議室提示主持人先排路線圖", () => {
    assert.match(renderLedgerForHost(emptyLedger()), /尚未排路線圖/);
  });

  it("renderLedgerForHost 包含項目、目前標記與上一輪指令", () => {
    const r = applyLedgerTurn(seeded(), { instructions: ["補測試"], reportRequests: [] }, NOW);
    const text = renderLedgerForHost(r.ledger);
    assert.match(text, /\[4B\] 品牌體感與失靈修復 — 🟡 進行中 ◀ 目前/);
    assert.match(text, /\s{2}- \[4B-DE\]/);
    assert.match(text, /你上一回合下的指令\n- 指令：補測試/);
  });
});

describe("renderLedgerAnchor", () => {
  it("空帳本不輸出；有目前項目時輸出一行錨點", () => {
    assert.equal(renderLedgerAnchor(emptyLedger()), "");
    const v = validateLedgerInput({
      items: [{ id: "4A", title: "地基與效能期", status: "in_progress" }],
      currentItemId: "4A",
    });
    assert.ok(v.ok);
    if (!v.ok) return;
    const text = renderLedgerAnchor(v.ledger);
    assert.match(text, /4A「地基與效能期」/);
    assert.ok(text.length < 400);
  });
});
