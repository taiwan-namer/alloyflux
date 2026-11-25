import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyServerTemplateId,
  beginTemplateSave,
  displayTemplateId,
  markTemplateSaveOk,
  shouldPatchTemplateSelection,
  shouldRollbackTemplate,
  SOP_STICKY_GRACE_MS,
} from "./sop-template-sync";

describe("sop-template-sync", () => {
  it("display falls back without inventing a server value", () => {
    assert.equal(displayTemplateId("", null, "automax"), "automax");
    assert.equal(displayTemplateId("x", null, "automax"), "x");
    assert.equal(displayTemplateId("", "srv", "automax"), "srv");
  });

  it("PATCH when server null but UI already shows default", () => {
    assert.equal(shouldPatchTemplateSelection("automax", null, "automax"), true);
    assert.equal(shouldPatchTemplateSelection("automax", "automax", "automax"), false);
    assert.equal(shouldPatchTemplateSelection("other", "automax", "automax"), true);
  });

  it("ignores late sync while sticky within grace, then accepts external", () => {
    let gate = beginTemplateSave({
      sessionId: "s1",
      nextId: "t2",
      serverBefore: "t1",
      prevGen: 0,
    });
    gate = markTemplateSaveOk(gate, 1000);

    assert.deepEqual(
      applyServerTemplateId({
        sessionId: "s1",
        serverRaw: "t1",
        saving: false,
        gate,
        nowMs: 1000 + SOP_STICKY_GRACE_MS - 1,
      }),
      { action: "ignore" },
    );

    assert.deepEqual(
      applyServerTemplateId({
        sessionId: "s1",
        serverRaw: "t2",
        saving: false,
        gate,
        nowMs: 1500,
      }),
      { action: "accept", clearGate: true, nextLocal: "t2" },
    );

    assert.deepEqual(
      applyServerTemplateId({
        sessionId: "s1",
        serverRaw: "external",
        saving: false,
        gate,
        nowMs: 1000 + SOP_STICKY_GRACE_MS + 1,
      }),
      { action: "accept", clearGate: true, nextLocal: "external" },
    );
  });

  it("rollback only for same gen/session/value", () => {
    const gate = beginTemplateSave({
      sessionId: "s1",
      nextId: "t2",
      serverBefore: "t1",
      prevGen: 3,
    });
    assert.equal(
      shouldRollbackTemplate({ gate, sessionId: "s1", expectedGen: 4, currentLocal: "t2" }),
      true,
    );
    assert.equal(
      shouldRollbackTemplate({ gate, sessionId: "s1", expectedGen: 4, currentLocal: "t9" }),
      false,
    );
    assert.equal(
      shouldRollbackTemplate({ gate, sessionId: "s2", expectedGen: 4, currentLocal: "t2" }),
      false,
    );
  });

  it("ignores props while saving", () => {
    const gate = beginTemplateSave({
      sessionId: "s1",
      nextId: "t2",
      serverBefore: null,
      prevGen: 0,
    });
    assert.deepEqual(
      applyServerTemplateId({
        sessionId: "s1",
        serverRaw: "old",
        saving: true,
        gate,
        nowMs: 1,
      }),
      { action: "ignore" },
    );
  });
});
