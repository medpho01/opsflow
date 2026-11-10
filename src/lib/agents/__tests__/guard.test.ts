import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { levelFor, hardRuleViolation, DEFAULT_LEVELS } from "../guard/guard";
import type { ProposedAction } from "../journey/step";

const action = (a: Partial<ProposedAction> = {}): ProposedAction => ({ desk: "LAB", action: "status_write", params: { to: "SAMPLE_COLLECTED", meetsBar: true }, reason: "", idemKey: "k", ...a });
const rows = (list: Array<[string, string, string, string]>) => ({ autonomy: list.map(([action, scopeKind, scopeKey, level]) => ({ action, desk: "LAB", scopeKind, scopeKey, level })) });

describe("autonomy levels (decision 2, 21 Oct)", () => {
  it("defaults when nothing is set", () => {
    assert.equal(levelFor({ autonomy: [] }, action({ action: "ask", params: {} }), { journeyId: null, orderId: 1, labId: 4, storeId: 6, labTier: "A" }), "ACT");
    assert.equal(levelFor({ autonomy: [] }, action(), { journeyId: null, orderId: 1, labId: 4, storeId: 6, labTier: "A" }), DEFAULT_LEVELS.status_write);
  });
  it("the tier row applies to every lab of that tier; a lab row may only lower it", () => {
    const s = rows([["status_write", "TIER", "A", "ACT"], ["status_write", "LAB", "14", "SUGGEST"]]);
    assert.equal(levelFor(s, action(), { journeyId: null, orderId: 1, labId: 4, storeId: 6, labTier: "A" }), "ACT");
    assert.equal(levelFor(s, action(), { journeyId: null, orderId: 1, labId: 14, storeId: 6, labTier: "A" }), "SUGGEST");
  });
  it("a lab promoted on its own sample rises above its tier", () => {
    const s = rows([["status_write", "TIER", "C", "SUGGEST"], ["status_write", "LAB", "2229", "ACT"]]);
    assert.equal(levelFor(s, action(), { journeyId: null, orderId: 1, labId: 2229, storeId: 6, labTier: "C" }), "ACT");
  });
  it("below the evidence bar, or always-suggest, never above SUGGEST", () => {
    const s = rows([["status_write", "TIER", "A", "ACT"]]);
    assert.equal(levelFor(s, action({ params: { to: "SAMPLE_COLLECTED", meetsBar: false } }), { journeyId: null, orderId: 1, labId: 4, storeId: 6, labTier: "A" }), "SUGGEST");
    assert.equal(levelFor(s, action({ params: { to: "PATIENT_MISSED", meetsBar: true, alwaysSuggest: true } }), { journeyId: null, orderId: 1, labId: 4, storeId: 6, labTier: "A" }), "SUGGEST");
  });
});

describe("hard rules", () => {
  it("never a transition outside the five, never a cancel", () => {
    assert.ok(hardRuleViolation(action({ params: { to: "CANCELED" } })));
    assert.ok(hardRuleViolation(action({ action: "cancel" as never })));
    assert.equal(hardRuleViolation(action()), null);
  });
});

describe("a question to a lab and a task for a person never wait for a click (10 Nov 2026)", () => {
  const ctx = { journeyId: null, orderId: 1, labId: 14, storeId: 6, labTier: "A" as const };
  it("the case worker's ask and task act; a console write and a store message still wait", () => {
    assert.equal(levelFor({ autonomy: [] }, action({ action: "ask", params: { alwaysSuggest: true } }), ctx), "ACT");
    assert.equal(levelFor({ autonomy: [] }, action({ action: "create_task", params: { alwaysSuggest: true, taskType: "AGENT_CONSOLE_UPDATE" } }), ctx), "ACT");
    assert.equal(levelFor({ autonomy: [] }, action({ action: "status_write", params: { to: "PATIENT_MISSED", meetsBar: true, alwaysSuggest: true } }), ctx), "SUGGEST");
    assert.equal(levelFor({ autonomy: [] }, action({ desk: "STORE", action: "store_reply", params: { alwaysSuggest: true } }), ctx), "SUGGEST");
  });
  it("a lab set to suggest still gets its asks; a lab on shadow stays recorded only", () => {
    assert.equal(levelFor(rows([["ask", "LAB", "14", "SUGGEST"]]), action({ action: "ask", params: {} }), ctx), "ACT");
    assert.equal(levelFor(rows([["ask", "LAB", "14", "SHADOW"]]), action({ action: "ask", params: {} }), ctx), "SHADOW");
  });
});
