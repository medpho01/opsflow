/**
 * Unit tests for the Task -> OrderSignals/VipSignals mapping layer.
 *
 * Runner: Node's built-in `node:test`, same as riskScorer.test.ts /
 * vipResolver.test.ts:
 *
 *   node --import tsx --test src/lib/priority/__tests__/taskSignals.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderSignalsFromTask,
  buildVipSignalsFromTask,
  type TaskSignalInput,
} from "../taskSignals";
import { InMemoryHniLookup } from "../hniLookup";

const NOW = new Date("2026-06-01T10:00:00.000Z");

function baseTask(overrides: Partial<TaskSignalInput> = {}): TaskSignalInput {
  return {
    id: 1,
    orderType: "HOME_SAMPLE",
    storeId: 42,
    appointmentTime: new Date("2026-06-01T10:30:00.000Z"),
    createdAt: new Date("2026-06-01T08:00:00.000Z"),
    lastStatusUpdate: new Date("2026-06-01T09:00:00.000Z"),
    metadata: { orderStatus: "ORDER_SCHEDULED", phleboName: "", phleboNumber: "" },
    ...overrides,
  };
}

describe("buildOrderSignalsFromTask", () => {
  test("reads orderStatus and phlebo fields out of Task.metadata", () => {
    const signals = buildOrderSignalsFromTask(
      baseTask({ metadata: { orderStatus: "PHLEBO_ASSIGNED", phleboName: "Asha", phleboNumber: "" } }),
      NOW,
    );
    assert.equal(signals.orderStatus, "PHLEBO_ASSIGNED");
    assert.equal(signals.hasPhleboAssigned, true);
  });

  test("a task with no metadata at all reports phlebo assignment as unavailable, not false", () => {
    const signals = buildOrderSignalsFromTask(baseTask({ metadata: null }), NOW);
    assert.equal(signals.orderStatus, "");
    assert.equal(signals.hasPhleboAssigned, null);
  });

  test("blank phlebo fields (present but empty) mean not assigned, not unavailable", () => {
    const signals = buildOrderSignalsFromTask(baseTask(), NOW);
    assert.equal(signals.hasPhleboAssigned, false);
  });

  test("rescheduleCommunicationSent is always null — no such field exists in this pipeline", () => {
    const signals = buildOrderSignalsFromTask(baseTask(), NOW);
    assert.equal(signals.rescheduleCommunicationSent, null);
  });

  test("minutesToAppointment is null when there is no appointment", () => {
    const signals = buildOrderSignalsFromTask(baseTask({ appointmentTime: null }), NOW);
    assert.equal(signals.minutesToAppointment, null);
    assert.equal(signals.leadTimeMinutes, null);
    assert.equal(signals.appointmentIstHour, null);
  });

  test("minutesToAppointment is computed from the pinned `now`, not a fresh clock read", () => {
    const signals = buildOrderSignalsFromTask(baseTask(), NOW);
    assert.equal(signals.minutesToAppointment, 30);
  });
});

describe("buildVipSignalsFromTask", () => {
  const lookup = new InMemoryHniLookup([
    { pincode: "560001", locality: "L", city: "Bengaluru", state: "KA", classification: "HNI", purityPct: 95, rationale: null },
  ]);

  test("no pincode anywhere in metadata resolves NO_PINCODE, not a guess", () => {
    const signals = buildVipSignalsFromTask(baseTask(), "Bengaluru", lookup);
    assert.equal(signals.pincode, null);
    assert.equal(signals.hni.status, "NO_PINCODE");
    assert.equal(signals.customerId, null);
  });

  test("a pincode under any of the candidate metadata keys resolves against the HNI lookup", () => {
    const signals = buildVipSignalsFromTask(
      baseTask({ metadata: { orderStatus: "ORDER_SCHEDULED", postalCode: "560 001" } }),
      "Bengaluru",
      lookup,
    );
    assert.equal(signals.pincode, "560001");
    assert.equal(signals.hni.status, "CLASSIFIED");
    assert.equal(signals.hni.record?.classification, "HNI");
  });

  test("storeCity passes through from the caller's store join, unmodified", () => {
    const signals = buildVipSignalsFromTask(baseTask(), "Mumbai", lookup);
    assert.equal(signals.storeCity, "Mumbai");
  });
});
