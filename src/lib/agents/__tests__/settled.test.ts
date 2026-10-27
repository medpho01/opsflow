import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settledByConsole } from "../executors/dispatcher";

describe("what the console has settled is not sent (27 Oct 2026)", () => {
  it("a phlebo on the way settles 'phlebo needed', 'please confirm' and the escalation", () => {
    const o = { orderStatus: "PHLEBO_STARTED", phleboName: "Chandra" };
    assert.ok(settledByConsole("PHLEBO", o)); assert.ok(settledByConsole("UNCONFIRMED", o)); assert.ok(settledByConsole("ESCALATION", o));
    assert.equal(settledByConsole("ETA", o), null); // "on time?" still fair
  });
  it("a collected sample settles everything up to the report", () => {
    const o = { orderStatus: "SAMPLE_COLLECTED", phleboName: "" };
    for (const ask of ["PHLEBO", "UNCONFIRMED", "ETA", "STATUS", "ESCALATION"]) assert.ok(settledByConsole(ask, o), ask);
    assert.equal(settledByConsole("REPORT", o), null);
  });
  it("an order still only scheduled settles nothing", () => {
    const o = { orderStatus: "ORDER_SCHEDULED", phleboName: "" };
    for (const ask of ["PHLEBO", "ETA", "STATUS", "ESCALATION", "REPORT"]) assert.equal(settledByConsole(ask, o), null, ask);
  });
});
