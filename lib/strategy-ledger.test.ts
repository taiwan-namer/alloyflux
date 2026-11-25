import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLedgerTurn,
  emptyLedger,
  readLedger,
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

  it("renderLedgerForHost 包含項目、目前標記與上一輪指令", () => {
    const r = applyLedgerTurn(seeded(), { instructions: ["補測試"], reportRequests: [] }, NOW);
    const text = renderLedgerForHost(r.ledger);
    assert.match(text, /\[4B\] 品牌體感與失靈修復 — 🟡 進行中 ◀ 目前/);
    assert.match(text, /\s{2}- \[4B-DE\]/);
    assert.match(text, /你上一回合下的指令\n- 指令：補測試/);
  });
});
