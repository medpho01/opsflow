import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closest, settle, type DeskPlan } from "../store/understand";

const plan = (p: Partial<DeskPlan>): DeskPlan => ({ action: "answer", reply: "#1: collected at 8:04 am.", labQuestion: null, basis: ["LabStack: SAMPLE_COLLECTED"], reason: "", confidence: 0.9, ...p });

describe("the desk's plan is held to rules the model may not bend (11 Nov 2026)", () => {
  it("an answer needs evidence and enough confidence, else a person takes it", () => {
    assert.equal(settle(plan({}), { forPerson: false }, { labReachable: true, orderId: 1 }).action, "answer");
    assert.equal(settle(plan({ basis: [] }), { forPerson: false }, { labReachable: true, orderId: 1 }).action, "handoff");
    assert.equal(settle(plan({ confidence: 0.5 }), { forPerson: false }, { labReachable: true, orderId: 1 }).action, "handoff");
    assert.equal(settle(plan({ reply: "#1: @919999999999 please check" }), { forPerson: false }, { labReachable: true, orderId: 1 }).action, "handoff");
  });
  it("the lab is asked only when it can be, about a known order, with a question", () => {
    const ask = plan({ action: "ask_lab", reply: "#1: asking the lab now.", labQuestion: "When will the urine sample be collected?" });
    assert.equal(settle(ask, { forPerson: false }, { labReachable: true, orderId: 1 }).action, "ask_lab");
    assert.equal(settle(ask, { forPerson: false }, { labReachable: false, orderId: 1 }).action, "handoff");
    assert.equal(settle(ask, { forPerson: false }, { labReachable: true, orderId: null }).action, "handoff");
    assert.equal(settle({ ...ask, labQuestion: null }, { forPerson: false }, { labReachable: true, orderId: 1 }).action, "handoff");
  });
  it("a message for a person is left alone, and nothing is posted", () => {
    const s = settle(plan({}), { forPerson: true }, { labReachable: true, orderId: 1 });
    assert.equal(s.action, "silent"); assert.equal(s.reply, null);
  });
});

describe("the team's earlier answers are read in, the closest first", () => {
  it("ranks by shared words, ignoring ids and filler", () => {
    const rows = [
      { question: "96025 urine samples not collected let us know the slots available", teamReply: "a" },
      { question: "97120 please share the report", teamReply: "b" },
      { question: "95448 reschedule to tomorrow same slot", teamReply: "c" },
    ];
    assert.equal(closest("97355 urine not collected, any slots today?", rows, 1)[0].teamReply, "a");
    assert.equal(closest("report pending for 97001, please share", rows, 1)[0].teamReply, "b");
    assert.deepEqual(closest("zzz", rows, 2), []);
  });
});
