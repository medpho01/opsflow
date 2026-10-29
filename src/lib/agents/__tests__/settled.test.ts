import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partitionQueued, settledByConsole } from "../executors/dispatcher";

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

  it("an ETA ask queued for a visit more than 3 h away is dropped at send time (29 Oct 2026, #95010)", () => {
    const now = new Date("2026-10-29T07:00:00Z");
    const item = (appointment: string) => ({ orderId: 95010, payload: { line: { appointment } } });
    assert.equal(partitionQueued([item("2026-10-30T03:00:00Z")], "ETA", now, "A").stale.length, 1);
    assert.equal(partitionQueued([item("2026-10-29T08:00:00Z")], "ETA", now, "A").fresh.length, 1);
  });

  it("every LabStack status ranks: a partial report is past collection, not before it (29 Oct 2026)", async () => {
    const { reached } = await import("../journey/policy");
    assert.ok(reached("PARTIAL_DELIVERED", "SAMPLE_COLLECTED"));
    assert.ok(reached("SAMPLE_IN_TRANSIT", "SAMPLE_COLLECTED") && !reached("SAMPLE_IN_TRANSIT", "SAMPLE_DELIVERED"));
    assert.ok(!reached("PARTIAL_DELIVERED", "REPORT_DELIVERED"), "the rest of the report is still owed");
    assert.ok(reached("PHLEBO_STARTED", "PHLEBO_ASSIGNED") && !reached("PHLEBO_STARTED", "PATIENT_VISITED"));
    assert.equal(settledByConsole("STATUS", { orderStatus: "PARTIAL_DELIVERED", phleboName: "" }), "settled (PARTIAL_DELIVERED)");
  });
});
