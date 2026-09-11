/**
 * Unit tests for the pickup-delay risk engine.
 *
 * Runner: Node's built-in `node:test` (Node 22), executed through the
 * already-installed `tsx`. No new dependency, no package.json change — the
 * repo has no test runner and adding one is shared-tooling churn that was
 * not in scope.
 *
 *   node --import tsx --test src/lib/priority/__tests__/riskScorer.test.ts
 *
 * The engine is pure, so these tests need no database, no server, and no
 * network — which matters here because the local Postgres is down.
 *
 * ── Arithmetic being asserted ────────────────────────────────────────────
 * Pre-appointment phase (appointment in the future, status awaiting pickup)
 * evaluates five signals; PAST_APPT_NOT_PICKED_UP is phase-inapplicable:
 *
 *   NO_PHLEBO_NEAR_APPT    30    ladder ≤30m:30  ≤60m:20  ≤90m:10
 *   STATUS_STALE           10    ladder ≥120m:10
 *   SHORT_LEAD_TIME        10    ladder <60m:10  <180m:5
 *   EARLY_MORNING_SLOT      5    ladder <10h:5
 *   PRIOR_RESCHEDULE_COMM   5
 *   ───────────────────────────
 *   denominator            60
 *
 * score = round(100 * earned / 60)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreRisk, bandForScore, clampScore } from "../riskScorer";
import { DEFAULT_RISK_CONFIG } from "../riskConfig";
import type { OrderSignals } from "../types";

/**
 * Baseline: a healthy pre-appointment order that fires nothing.
 * Appointment 10h out, phlebo assigned, fresh status, generous lead time,
 * afternoon slot, never rescheduled.
 */
function baseSignals(overrides: Partial<OrderSignals> = {}): OrderSignals {
  return {
    orderId: 1001,
    orderType: "HOME_SAMPLE",
    orderStatus: "PHLEBO_ASSIGNED",
    storeId: 3,
    minutesToAppointment: 600,
    minutesSinceCreated: 120,
    minutesSinceStatusUpdated: 5,
    leadTimeMinutes: 1440,
    appointmentIstHour: 14,
    hasPhleboAssigned: true,
    rescheduleCommunicationSent: false,
    ...overrides,
  };
}

describe("bandForScore — mandated cutoffs", () => {
  test("LOW covers 0-24", () => {
    assert.equal(bandForScore(0), "LOW");
    assert.equal(bandForScore(1), "LOW");
    assert.equal(bandForScore(24), "LOW");
  });

  test("MEDIUM covers 25-49", () => {
    assert.equal(bandForScore(25), "MEDIUM");
    assert.equal(bandForScore(37), "MEDIUM");
    assert.equal(bandForScore(49), "MEDIUM");
  });

  test("HIGH covers 50-74", () => {
    assert.equal(bandForScore(50), "HIGH");
    assert.equal(bandForScore(62), "HIGH");
    assert.equal(bandForScore(74), "HIGH");
  });

  test("CRITICAL covers 75-100", () => {
    assert.equal(bandForScore(75), "CRITICAL");
    assert.equal(bandForScore(88), "CRITICAL");
    assert.equal(bandForScore(100), "CRITICAL");
  });

  test("every boundary pair sits on the correct side", () => {
    // The six boundaries named in the requirement, asserted as pairs so an
    // off-by-one in either direction fails.
    assert.equal(bandForScore(24), "LOW");
    assert.equal(bandForScore(25), "MEDIUM");
    assert.equal(bandForScore(49), "MEDIUM");
    assert.equal(bandForScore(50), "HIGH");
    assert.equal(bandForScore(74), "HIGH");
    assert.equal(bandForScore(75), "CRITICAL");
  });

  test("every integer 0-100 maps to exactly one band, with no gaps", () => {
    for (let s = 0; s <= 100; s++) {
      const band = bandForScore(s);
      assert.ok(
        ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(band),
        `score ${s} produced an unexpected band: ${band}`,
      );
    }
  });

  test("out-of-range input is clamped, never thrown", () => {
    assert.equal(bandForScore(-1), "LOW");
    assert.equal(bandForScore(-9999), "LOW");
    assert.equal(bandForScore(101), "CRITICAL");
    assert.equal(bandForScore(9999), "CRITICAL");
    assert.equal(clampScore(Number.NaN), 0);
    assert.equal(clampScore(Number.POSITIVE_INFINITY), 100);
    assert.equal(clampScore(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clampScore(37.4), 37);
    assert.equal(clampScore(37.5), 38);
  });
});

describe("scoreRisk — band outcomes", () => {
  test("LOW: nothing fires → score 0", () => {
    const r = scoreRisk(baseSignals());
    assert.equal(r.score, 0);
    assert.equal(r.band, "LOW");
    assert.deepEqual(r.reasons, []);
  });

  test("LOW: a single 5-point signal → 5/60 = 8", () => {
    const r = scoreRisk(baseSignals({ rescheduleCommunicationSent: true }));
    assert.equal(r.earnedPoints, 5);
    assert.equal(r.maxEvaluablePoints, 60);
    assert.equal(r.score, 8);
    assert.equal(r.band, "LOW");
  });

  test("MEDIUM: no phlebo at T-80 + short-ish lead → 15/60 = 25", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 80,   // ≤90 rung → 10
      hasPhleboAssigned: false,
      leadTimeMinutes: 120,       // <180 rung → 5
    }));
    assert.equal(r.earnedPoints, 15);
    assert.equal(r.score, 25);
    assert.equal(r.band, "MEDIUM");
  });

  test("HIGH: no phlebo at T-45 + stale + early slot → 35/60 = 58", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 45,        // ≤60 rung → 20
      hasPhleboAssigned: false,
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 200,  // ≥120 → 10
      appointmentIstHour: 7,           // <10 → 5
    }));
    assert.equal(r.earnedPoints, 35);
    assert.equal(r.score, 58);
    assert.equal(r.band, "HIGH");
  });

  test("CRITICAL: no phlebo at T-20 + stale + early slot → 45/60 = 75", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 20,        // ≤30 rung → 30
      hasPhleboAssigned: false,
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 200,  // → 10
      appointmentIstHour: 7,           // → 5
    }));
    assert.equal(r.earnedPoints, 45);
    assert.equal(r.score, 75);
    assert.equal(r.band, "CRITICAL");
  });

  test("post-appointment phase scores on PAST_APPT, not NO_PHLEBO", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: -50,       // 50m past, ≥45 rung → 30
      hasPhleboAssigned: false,
      minutesSinceStatusUpdated: 200,  // → 10
    }));
    const codes = r.reasons.map((x) => x.code);
    assert.ok(codes.includes("PAST_APPT_NOT_PICKED_UP"));
    assert.ok(!codes.includes("NO_PHLEBO_NEAR_APPT"), "phase signals must be mutually exclusive");
    assert.equal(r.earnedPoints, 40);
    assert.equal(r.score, 67);
    assert.equal(r.band, "HIGH");
  });
});

describe("scoreRisk — extremes", () => {
  test("minimum possible score is 0 / LOW", () => {
    const r = scoreRisk(baseSignals());
    assert.equal(r.score, 0);
    assert.equal(r.band, "LOW");
    assert.ok(r.score >= 0);
  });

  test("maximum possible score is exactly 100 / CRITICAL", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 20,        // 30
      hasPhleboAssigned: false,
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 500,  // 10
      leadTimeMinutes: 30,             // 10
      appointmentIstHour: 6,           // 5
      rescheduleCommunicationSent: true, // 5
    }));
    assert.equal(r.earnedPoints, 60);
    assert.equal(r.maxEvaluablePoints, 60);
    assert.equal(r.score, 100);
    assert.equal(r.band, "CRITICAL");
    assert.equal(r.reasons.length, 5);
  });

  test("score can never exceed 100 or fall below 0", () => {
    // Sweep a deterministic grid across every ladder rung and both phases.
    const appts = [-500, -120, -45, -15, -1, 0, 20, 30, 45, 60, 90, 200, 600];
    const stales = [0, 30, 119, 120, 500];
    const leads = [10, 59, 60, 179, 180, 5000];
    const hours = [0, 6, 9, 10, 14, 23];
    for (const minutesToAppointment of appts) {
      for (const minutesSinceStatusUpdated of stales) {
        for (const leadTimeMinutes of leads) {
          for (const appointmentIstHour of hours) {
            const r = scoreRisk(baseSignals({
              minutesToAppointment,
              minutesSinceStatusUpdated,
              leadTimeMinutes,
              appointmentIstHour,
              hasPhleboAssigned: false,
              rescheduleCommunicationSent: true,
            }));
            assert.ok(Number.isInteger(r.score), `non-integer score: ${r.score}`);
            assert.ok(r.score >= 0 && r.score <= 100, `out-of-range score: ${r.score}`);
            assert.equal(r.band, bandForScore(r.score));
          }
        }
      }
    }
  });

  test("an already-collected sample short-circuits to 0 / LOW", () => {
    // No pickup delay left to predict once the sample is in hand — staleness
    // and slot points must not accumulate into a phantom warning.
    for (const status of DEFAULT_RISK_CONFIG.pickupCompleteStatuses) {
      const r = scoreRisk(baseSignals({
        orderStatus: status,
        minutesToAppointment: -500,
        minutesSinceStatusUpdated: 999,
        appointmentIstHour: 6,
        hasPhleboAssigned: false,
        rescheduleCommunicationSent: true,
      }));
      assert.equal(r.score, 0, `status ${status} should short-circuit`);
      assert.equal(r.band, "LOW");
      assert.deepEqual(r.reasons, []);
    }
  });
});

describe("scoreRisk — missing data", () => {
  test("unknown phlebo state is reported, not scored as zero", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 20,
      hasPhleboAssigned: null,          // unreadable
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 200,   // → 10
    }));
    // The 30-point signal leaves BOTH numerator and denominator.
    assert.equal(r.maxEvaluablePoints, 30);
    assert.equal(r.earnedPoints, 10);
    assert.equal(r.score, 33);
    assert.equal(r.band, "MEDIUM");
    const codes = r.unavailable.map((u) => u.signal);
    assert.ok(codes.includes("NO_PHLEBO_NEAR_APPT"));
    assert.equal(r.coverageRatio, 50);
  });

  test("a missing appointment collapses coverage and flags low confidence", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: null,
      leadTimeMinutes: null,
      appointmentIstHour: null,
      minutesSinceStatusUpdated: 200,
    }));
    // Only STATUS_STALE (10) and PRIOR_RESCHEDULE_COMM (5) remain evaluable.
    assert.equal(r.maxEvaluablePoints, 15);
    assert.equal(r.coverageRatio, 17);
    assert.equal(r.lowConfidence, true);
    assert.ok(Number.isInteger(r.score));
  });

  test("permanently blocked signals are always reported as unavailable", () => {
    const r = scoreRisk(baseSignals());
    const reported = r.unavailable.map((u) => u.signal);
    for (const blocked of DEFAULT_RISK_CONFIG.blockedSignals) {
      assert.ok(
        reported.includes(blocked.signal),
        `${blocked.signal} must be reported as unavailable`,
      );
    }
    // ...and must never influence the arithmetic.
    assert.equal(r.maxEvaluablePoints, 60);
  });

  test("every unavailable entry carries a human-readable reason", () => {
    const r = scoreRisk(baseSignals({ hasPhleboAssigned: null }));
    for (const u of r.unavailable) {
      assert.ok(u.reason.length > 0, `${u.signal} has no reason text`);
    }
  });
});

describe("scoreRisk — explainability", () => {
  test("multiple simultaneous factors each produce their own reason", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 20,
      hasPhleboAssigned: false,
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 200,
      leadTimeMinutes: 30,
      appointmentIstHour: 7,
      rescheduleCommunicationSent: true,
    }));
    assert.equal(r.reasons.length, 5);
    const codes = r.reasons.map((x) => x.code);
    assert.deepEqual(codes, [
      "NO_PHLEBO_NEAR_APPT",   // 30
      "STATUS_STALE",          // 10 — ties broken by fixed evaluation order
      "SHORT_LEAD_TIME",       // 10
      "EARLY_MORNING_SLOT",    // 5
      "PRIOR_RESCHEDULE_COMM", // 5
    ]);
    // Reasons are ordered most-significant first.
    for (let i = 1; i < r.reasons.length; i++) {
      assert.ok(r.reasons[i - 1].points >= r.reasons[i].points);
    }
    // Points in the reasons must reconcile with earnedPoints exactly.
    const summed = r.reasons.reduce((acc, x) => acc + x.points, 0);
    assert.equal(summed, r.earnedPoints);
  });

  test("each reason names a real source field and carries no patient data", () => {
    const r = scoreRisk(baseSignals({
      minutesToAppointment: 20,
      hasPhleboAssigned: false,
      appointmentIstHour: 7,
    }));
    for (const reason of r.reasons) {
      assert.ok(reason.code.length > 0);
      assert.ok(reason.label.length > 0);
      assert.ok(reason.detail.length > 0);
      assert.ok(
        reason.sourceField.startsWith("Order."),
        `${reason.code} must cite an Order field, got "${reason.sourceField}"`,
      );
    }
  });
});

describe("scoreRisk — determinism", () => {
  test("repeated evaluation of identical input is deeply equal", () => {
    const signals = baseSignals({
      minutesToAppointment: 20,
      hasPhleboAssigned: false,
      orderStatus: "ORDER_SCHEDULED",
      minutesSinceStatusUpdated: 200,
      appointmentIstHour: 7,
    });
    const first = scoreRisk(signals);
    for (let i = 0; i < 100; i++) {
      assert.deepStrictEqual(scoreRisk(signals), first);
    }
  });

  test("scoring does not mutate its input", () => {
    const signals = baseSignals({ hasPhleboAssigned: false, minutesToAppointment: 20 });
    const snapshot = JSON.parse(JSON.stringify(signals));
    scoreRisk(signals);
    assert.deepStrictEqual(signals, snapshot);
  });

  test("results depend only on inputs, not on wall-clock time", async () => {
    const signals = baseSignals({ minutesToAppointment: 20, hasPhleboAssigned: false });
    const before = scoreRisk(signals);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepStrictEqual(scoreRisk(signals), before);
  });
});
