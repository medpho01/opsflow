import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { atRiskText, lateState, lateText } from "../store/atrisk";

describe("at-risk note to the store (29 Oct 2026)", () => {
  it("lists every order once, with time and lab, and asks for a new slot or another lab", () => {
    const text = atRiskText([{ orderId: 95048, name: "A", time: "9:00 am", lab: "Vision Lab" }, { orderId: 95072, name: "B", time: "9:00 am", lab: "Vision Lab" }]);
    assert.match(text, /^⚠️ \*At risk — the lab hasn't confirmed these visits yet \(2\)\*/);
    assert.match(text, /1\. #95048 · A · 9:00 am · Vision Lab/);
    assert.match(text, /share a new slot here — or tell us to try another lab/);
    assert.doesNotMatch(text, /@/, "no one is tagged");
  });
});

describe("running-late note to the store (10 Nov 2026)", () => {
  it("says what the console shows about each visit, in the store's words", () => {
    assert.equal(lateState("ORDER_SCHEDULED", ""), "no phlebo assigned yet");
    assert.equal(lateState("PHLEBO_ASSIGNED", "Ravi Kumar"), "phlebo Ravi assigned, not started yet");
    assert.equal(lateState("PHLEBO_STARTED", "Ravi Kumar"), "phlebo Ravi is on the way");
    const text = lateText([{ orderId: 97508, name: "A", time: "9:00 am", lab: "Orange Health", state: lateState("PHLEBO_STARTED", "Ravi") }]);
    assert.match(text, /^⏰ \*Running late — not collected yet \(1\)\*/);
    assert.match(text, /1\. #97508 · A · 9:00 am · Orange Health — phlebo Ravi is on the way/);
    assert.match(text, /will update here/);
  });
});
