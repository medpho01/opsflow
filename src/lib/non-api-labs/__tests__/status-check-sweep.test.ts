import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planStatusCheckSweep, type SweepOrder, type SweepWorkflow } from "../status-check-sweep";

const now = new Date("2026-10-05T12:00:00Z");
const configuredAt = new Map([[7, new Date("2026-10-01T00:00:00Z")]]);
const order = (id: number, extra: Partial<SweepOrder> = {}): SweepOrder => ({
  id, labId: 7, orderStatus: "ORDER_SCHEDULED",
  appointmentTime: new Date("2026-10-06T03:00:00Z"),
  createdAt: new Date("2026-09-20T00:00:00Z"),
  patientName: "P", ...extra,
});
const wf = (orderId: number, extra: Partial<SweepWorkflow> = {}): SweepWorkflow =>
  ({ id: `w${orderId}`, orderId, status: "LAB_ACCEPTED", hasStatusCheck: false, ...extra });

describe("status check sweep", () => {
  it("adds the check to an existing workflow that lacks one", () => {
    const plan = planStatusCheckSweep([order(1)], configuredAt, new Map([[1, wf(1)]]), now);
    assert.deepEqual(plan.addTo.map((x) => x.workflowId), ["w1"]);
    assert.equal(plan.shells.length, 0);
  });

  it("leaves a workflow that already has one, or is closed", () => {
    const plan = planStatusCheckSweep(
      [order(1), order(2)], configuredAt,
      new Map([[1, wf(1, { hasStatusCheck: true })], [2, wf(2, { status: "CANCELLED" })]]), now,
    );
    assert.equal(plan.addTo.length + plan.shells.length, 0);
  });

  it("creates a check-only workflow for an order placed before the lab was configured", () => {
    const plan = planStatusCheckSweep([order(3)], configuredAt, new Map(), now);
    assert.deepEqual(plan.shells.map((o) => o.id), [3]);
  });

  it("never takes a newer order the poller has not picked up yet", () => {
    const plan = planStatusCheckSweep([order(4, { createdAt: new Date("2026-10-05T11:58:00Z") })], configuredAt, new Map(), now);
    assert.equal(plan.shells.length, 0);
  });

  it("skips orders whose check time has passed, and cancelled or collected ones", () => {
    const plan = planStatusCheckSweep([
      order(5, { appointmentTime: new Date("2026-10-05T11:20:00Z") }),
      order(6, { orderStatus: "CANCELED" }),
      order(8, { orderStatus: "SAMPLE_COLLECTED" }),
    ], configuredAt, new Map(), now);
    assert.equal(plan.addTo.length + plan.shells.length, 0);
  });
});
