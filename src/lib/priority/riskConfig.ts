/**
 * Pickup-delay risk model — weights and thresholds, held as DATA.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️  APPROVAL STATUS
 *
 * The engine's STRUCTURE is approved (deterministic, pure, banded 0-24 /
 * 25-49 / 50-74 / 75-100, explainable). The NUMBERS below are not: they were
 * never signed off, so every one is annotated with either the repository
 * artefact it is anchored to, or "PROPOSED — REQUIRES BUSINESS APPROVAL".
 *
 * Nothing here is inferred from an LLM. Changing a weight is a one-line edit
 * to this file; riskScorer.ts never hard-codes a number.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ANCHORING METHOD
 *
 * OpsFlow already encodes a business severity ranking: each seeded task rule
 * in prisma/seed.ts carries a TaskPriority chosen by ops. That gives three
 * tiers to anchor against, rather than inventing a scale:
 *
 *   URGENT-anchored signal  → 30 points
 *   HIGH-anchored signal    → 20 points
 *   MEDIUM-anchored signal  → 10 points
 *   no rule anchor          →  5 points, marked PROPOSED
 *
 * Timing thresholds are taken verbatim from existing rules and UI constants
 * rather than chosen. Each is cited inline.
 */
import type { RiskConfig } from "./types";

/** Bumped when the SHAPE of the model changes (signals added/removed). */
export const EVALUATOR_VERSION = "risk-1.0.0";

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  configVersion: 1,

  /**
   * Once the sample is collected there is no pickup-delay risk left to
   * predict, so the engine short-circuits to 0/LOW. Without this, a
   * collected order could still accumulate points from staleness and slot
   * signals and surface as HIGH — predicting a delay that already cannot
   * happen.
   * Anchored: statuses observed in prisma/seed.ts rules R5/R8 and
   * tests/demo/EXPECTED_TASKS.md.
   */
  pickupCompleteStatuses: [
    "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_IN_TRANSIT",
    "SAMPLE_PROCESSED", "REPORT_READY", "REPORT_UPLOADED", "REPORT_DELIVERED",
  ],

  /**
   * Statuses that mean "pickup still owed". Anchored: hsc_r4/hsc_r6 use
   * statusIn ["PHLEBO_ASSIGNED"]; ORDER_SCHEDULED is included because an
   * order still merely scheduled past its appointment is strictly worse.
   * ORDER_SCHEDULED inclusion: PROPOSED — REQUIRES BUSINESS APPROVAL.
   */
  awaitingPickupStatuses: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"],

  /** Statuses for which staleness is meaningful. Anchored: hsc_r7_stale_order. */
  stalenessApplicableStatuses: ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED"],

  signals: {
    /**
     * No phlebotomist named on the order as the appointment approaches.
     * Ladder anchors:
     *   ≤30m → 30pts. prisma/seed.ts rationale R3 ("Appointment within 30
     *          min, phlebo assigned but not dispatched"), priority URGENT.
     *   ≤60m → 20pts. prisma/seed.ts rationale R2 ("Confirmed but no phlebo
     *          assigned 60 min before appointment"), hsc_r2 priority HIGH.
     *   ≤90m → 10pts. MyWorkBoard.NOW_WINDOW_MIN = 90 — the window ops
     *          already treats as "now".
     */
    NO_PHLEBO_NEAR_APPT: {
      maxPoints: 30,
      tiers: [
        { thresholdMin: 30, points: 30 },
        { thresholdMin: 60, points: 20 },
        { thresholdMin: 90, points: 10 },
      ],
    },

    /**
     * Appointment has passed and the order is still awaiting pickup.
     * Ladder anchors:
     *   ≥45m → 30pts. hsc_r6_patient_missed, minutesAfterAppointment 45.
     *   ≥15m → 20pts. hsc_r4_confirm_collected, minutesAfterAppointment 15,
     *          priority URGENT.
     */
    PAST_APPT_NOT_PICKED_UP: {
      maxPoints: 30,
      tiers: [
        { thresholdMin: 45, points: 30 },
        { thresholdMin: 15, points: 20 },
      ],
    },

    /**
     * Order has sat in the same status too long.
     * Anchored: hsc_r7_stale_order, minutesSinceStatusUpdated 120,
     * priority MEDIUM → 10 points.
     */
    STATUS_STALE: {
      maxPoints: 10,
      tiers: [{ thresholdMin: 120, points: 10 }],
    },

    /**
     * Rushed booking — little time between creation and appointment.
     * No rule anchors this. Thresholds and points both:
     * PROPOSED — REQUIRES BUSINESS APPROVAL.
     */
    SHORT_LEAD_TIME: {
      maxPoints: 10,
      tiers: [
        { thresholdMin: 60, points: 10 },
        { thresholdMin: 180, points: 5 },
      ],
    },

    /**
     * Early-morning appointment slot.
     * Threshold anchored: MyWorkBoard.EARLY_MORNING_CUTOFF_HOUR_IST = 10,
     * commented "appts before 10 AM count as early", and the Tomorrow view
     * already gives these a dedicated callout — ops treats them as needing
     * attention. The POINT VALUE has no anchor:
     * PROPOSED — REQUIRES BUSINESS APPROVAL.
     */
    EARLY_MORNING_SLOT: {
      maxPoints: 5,
      tiers: [{ thresholdMin: 10, points: 5 }],
    },

    /**
     * A reschedule communication was sent on this order.
     * Field confirmed to exist (Order.sentCommunicationRescheduled, see
     * tests/demo/seed-orders.sql) but it is a BOOLEAN — no count, no
     * timestamp — so it is weak evidence of prior rework.
     * PROPOSED — REQUIRES BUSINESS APPROVAL.
     */
    PRIOR_RESCHEDULE_COMM: {
      maxPoints: 5,
      tiers: [{ thresholdMin: 0, points: 5 }],
    },
  },

  /**
   * Signals the PRD asks for that CANNOT be computed from data in this
   * repository. They are reported in `unavailable` on every result so the
   * board can say "not measured" — but they carry NO weight, because
   * assigning a weight to a signal that has never been observed would be
   * inventing a number. They are excluded from the coverage denominator for
   * the same reason.
   */
  blockedSignals: [
    { signal: "PROVIDER_RELIABILITY", reason: "no order status-change audit table exists in labstack" },
    { signal: "AREA_RELIABILITY", reason: "no pincode/lat-long field exists on Order" },
    { signal: "PROVIDER_CONFIRMATION", reason: "no comm/workflow engine exists" },
    { signal: "PRIOR_MISS_COUNT", reason: "PATIENT_MISSED orders are excluded from every fetch; no history table" },
    { signal: "ORDER_TYPE_BASE_RATE", reason: "requires provider/area base rates, which are unavailable" },
    { signal: "ASSIGNED_NOT_DISPATCHED", reason: "no dispatched/started status exists in the Order status enum" },
  ],

  /** Mandated cutoffs. Frozen onto each score at write time. */
  bandThresholds: { LOW: 0, MEDIUM: 25, HIGH: 50, CRITICAL: 75 },

  /**
   * Below this coverage percentage a result is flagged lowConfidence.
   * PROPOSED — REQUIRES BUSINESS APPROVAL.
   */
  lowConfidenceFloorPct: 40,

  /**
   * Whether a lowConfidence result has its band capped at HIGH (option (a)
   * from the contract discussion) or is merely flagged (option (b)).
   * Defaults to FALSE — flag only — because option (a) was never approved.
   */
  capBandOnLowConfidence: false,
};
