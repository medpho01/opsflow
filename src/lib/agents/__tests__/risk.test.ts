import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreRisk } from "../journey/risk";
import { LAB_SOP_V1 } from "../sop/baseline";
import type { CheckpointState } from "../journey/step";
import type { OrderSnapshot } from "../journey/policy";

const at = (iso: string) => new Date(iso);
const order = (o: Partial<OrderSnapshot> = {}): OrderSnapshot => ({
  id: 1, orderType: "HOME_SAMPLE", orderStatus: "CREATED", appointmentTime: at("2026-10-21T02:30:00Z"), labId: 2229, storeId: 6,
  createdAt: at("2026-10-20T10:00:00Z"), statusUpdatedAt: null, phleboName: "", patientName: null, labName: null, storeName: null, ...o,
});
const cp = (name: CheckpointState["name"], status: CheckpointState["status"], due: string): CheckpointState => ({ name, dueAt: at(due), dueSource: "POLICY", metAt: null, status });
const base = { weights: LAB_SOP_V1.params.riskWeights, thresholds: LAB_SOP_V1.params.riskThresholds, subStates: [] as string[], rescheduleCount: 0 };

describe("risk scoring (FR-16.2)", () => {
  it("a confirmed order the day before with an active lab is low", () => {
    const r = scoreRisk({ ...base, now: at("2026-10-20T13:00:00Z"), order: order({ orderStatus: "ORDER_SCHEDULED" }), checkpoints: [cp("confirmed", "MET", "2026-10-20T12:00:00Z"), cp("phlebo_assigned", "PENDING", "2026-10-21T00:30:00Z")] });
    assert.equal(r.level, "LOW");
  });
  it("unconfirmed with the slot in 13 h and a silent lab is high, with reasons", () => {
    const r = scoreRisk({ ...base, now: at("2026-10-20T13:30:00Z"), order: order(), checkpoints: [cp("confirmed", "PENDING", "2026-10-20T12:00:00Z")], labSilentHours: 5 });
    assert.equal(r.level, "HIGH");
    assert.ok(r.reasons.some((x) => x.includes("not confirmed")));
    assert.ok(r.reasons.some((x) => x.includes("silent")));
  });
  it("a placeholder lab alone is high and cannot be done today", () => {
    const r = scoreRisk({ ...base, now: at("2026-10-21T00:00:00Z"), order: order({ labId: 1, orderStatus: "ORDER_SCHEDULED" }), checkpoints: [cp("confirmed", "MET", "2026-10-20T12:00:00Z")] });
    assert.equal(r.level, "HIGH");
    assert.equal(r.cannotDoToday, true);
  });
  it("reschedules and an earlier patient-missed add up to medium", () => {
    const r = scoreRisk({ ...base, now: at("2026-10-20T13:00:00Z"), order: order({ orderStatus: "ORDER_SCHEDULED" }), checkpoints: [cp("confirmed", "MET", "2026-10-20T12:00:00Z")], rescheduleCount: 2, subStates: ["patient_missed"] });
    assert.equal(r.level, "MEDIUM");
  });
});
