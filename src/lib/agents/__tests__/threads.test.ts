import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closedByConsole, firstRemindAt, waitingOnFor } from "../store/threads";

const at = (iso: string) => new Date(iso);

describe("store requests tracked until closed (27 Oct 2026)", () => {
  it("the lab is chased for status, slots and reports; a person acts on the rest", () => {
    for (const k of ["status", "report", "slot"]) assert.equal(waitingOnFor(k), "LAB");
    for (const k of ["reschedule", "cancel", "change_tests", "new_booking", "serviceability", "complaint", "other"]) assert.equal(waitingOnFor(k), "OPS");
  });
  it("the lab gets an hour, our own team 45 minutes", () => {
    assert.equal(firstRemindAt("status", at("2026-10-27T04:00:00Z")).toISOString(), "2026-10-27T05:00:00.000Z");
    assert.equal(firstRemindAt("reschedule", at("2026-10-27T04:00:00Z")).toISOString(), "2026-10-27T04:45:00.000Z");
  });
  it("a reschedule closes when the console shows a new time", () => {
    const t = { kind: "reschedule", snapshot: { appointmentTime: "2026-10-27T00:30:00.000Z", status: "ORDER_SCHEDULED" } };
    assert.equal(closedByConsole(t, { orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-27T00:30:00Z") }), null);
    assert.equal(closedByConsole(t, { orderStatus: "RESCHEDULED", appointmentTime: at("2026-10-28T02:30:00Z") }), "rescheduled in the console");
  });
  it("a cancel closes on CANCELLED; a report on REPORT_DELIVERED; anything on a terminal status", () => {
    assert.equal(closedByConsole({ kind: "cancel", snapshot: null }, { orderStatus: "CANCELLED", appointmentTime: null }), "cancelled in the console");
    assert.equal(closedByConsole({ kind: "report", snapshot: null }, { orderStatus: "REPORT_DELIVERED", appointmentTime: null }), "report delivered");
    assert.equal(closedByConsole({ kind: "status", snapshot: null }, { orderStatus: "REPORT_DELIVERED", appointmentTime: null }), "order delivered");
    assert.equal(closedByConsole({ kind: "status", snapshot: null }, { orderStatus: "SAMPLE_COLLECTED", appointmentTime: null }), null);
  });
  it("a complaint stays open after delivery — it is not about the order's progress", () => {
    assert.equal(closedByConsole({ kind: "complaint", snapshot: null }, { orderStatus: "REPORT_DELIVERED", appointmentTime: null }), null);
  });
});
