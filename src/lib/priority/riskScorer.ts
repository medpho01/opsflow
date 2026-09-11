/**
 * Pickup-delay risk engine — pure, deterministic, explainable.
 *
 * Hard guarantees, all structural rather than promised:
 *   • No database access. This module imports no client, and holds no handle
 *     on one. Persistence is the caller's job (see shadowDb.ts).
 *   • No network, no API calls, no LLM. The only imports are local types and
 *     a config object.
 *   • No clock. Every time-derived input arrives pre-computed on OrderSignals
 *     against a `now` pinned once per run, so the same inputs always produce
 *     the same output — replayable months later.
 *   • No operational side effects. It returns a value; it changes nothing.
 *
 * Scoring is a weighted sum over signal ladders, normalised to 0-100:
 *
 *     score = round(100 * earnedPoints / maxEvaluablePoints)
 *
 * The denominator is the weight of signals ACTUALLY EVALUATED, not the total
 * weight of the model. A signal that does not apply to this order's phase, or
 * whose input was missing, leaves both numerator and denominator. Scoring
 * against the full model instead would systematically deflate partial-data
 * orders into false negatives — the failure mode the /api/dashboard audit
 * calls out as "silently mapped failure to 0".
 *
 * Weights and thresholds live in riskConfig.ts. This file contains no
 * business numbers except the mandated band cutoffs.
 */
import type {
  OrderSignals,
  PriorityRiskBand,
  RiskConfig,
  RiskReason,
  RiskResult,
  RiskSignalCode,
  RiskSignalDef,
  SignalEvaluationKind,
  UnavailableSignal,
} from "./types";
import { RISK_BAND_BOUNDS } from "./types";
import { DEFAULT_RISK_CONFIG } from "./riskConfig";

/**
 * Map an integer score to its band. Exported and tested independently so the
 * mandated cutoffs (0-24 / 25-49 / 50-74 / 75-100) can be verified at every
 * boundary without constructing a whole order.
 *
 * Out-of-range input is clamped rather than throwing: a band is always
 * returned, so no caller can be handed a score with no band.
 */
export function bandForScore(score: number): PriorityRiskBand {
  const clamped = clampScore(score);
  for (const bound of RISK_BAND_BOUNDS) {
    if (clamped >= bound.min && clamped <= bound.max) return bound.band;
  }
  // Unreachable while RISK_BAND_BOUNDS covers 0-100 contiguously.
  return "LOW";
}

/**
 * Clamp to an integer in [0, 100].
 *
 * NaN floors to 0 — it carries no magnitude, so there is no side to clamp it
 * to. Infinities clamp naturally through Math.round/min/max (+Inf -> 100,
 * -Inf -> 0), which is the correct reading: they are out of range, not
 * meaningless. Neither should ever reach here — the score is computed from
 * finite integers — but a risk score must never be NaN downstream.
 */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Internal per-signal verdict. */
interface SignalVerdict {
  kind: SignalEvaluationKind;
  points: number;
  weight: number;
  reason?: RiskReason;
  unavailableReason?: string;
}

const NOT_APPLICABLE: SignalVerdict = { kind: "NOT_APPLICABLE", points: 0, weight: 0 };

function hit(
  def: RiskSignalDef,
  points: number,
  reason: Omit<RiskReason, "points">,
): SignalVerdict {
  return {
    kind: "HIT",
    points,
    weight: def.maxPoints,
    reason: { ...reason, points },
  };
}

function miss(def: RiskSignalDef): SignalVerdict {
  return { kind: "MISS", points: 0, weight: def.maxPoints };
}

function unavailable(def: RiskSignalDef, reason: string): SignalVerdict {
  return { kind: "UNAVAILABLE", points: 0, weight: def.maxPoints, unavailableReason: reason };
}

/**
 * Walk a descending threshold ladder and return the points for the first
 * rung the value satisfies. `compare` decides the direction, because some
 * ladders trigger below a threshold (lead time) and some above (staleness).
 */
function ladderPoints(
  def: RiskSignalDef,
  value: number,
  compare: (value: number, threshold: number) => boolean,
): number {
  for (const tier of def.tiers) {
    if (compare(value, tier.thresholdMin)) return tier.points;
  }
  return 0;
}

// ── Individual signals ────────────────────────────────────────────────────
// Each returns exactly one verdict. None reads a clock or touches I/O.

function evalNoPhleboNearAppt(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.NO_PHLEBO_NEAR_APPT;
  if (s.minutesToAppointment === null) {
    return unavailable(def, "order has no appointmentTime");
  }
  // Phase gate: this signal is about the run-up to the appointment. Once the
  // appointment has passed, PAST_APPT_NOT_PICKED_UP owns the risk instead —
  // the two are mutually exclusive by construction, so they never double-count.
  if (s.minutesToAppointment < 0) return NOT_APPLICABLE;
  if (!cfg.awaitingPickupStatuses.includes(s.orderStatus)) return NOT_APPLICABLE;
  if (s.hasPhleboAssigned === null) {
    return unavailable(def, "phleboName/phleboNumber not readable on the order");
  }
  if (s.hasPhleboAssigned) return miss(def);

  const points = ladderPoints(def, s.minutesToAppointment, (v, t) => v <= t);
  if (points === 0) return miss(def);
  return hit(def, points, {
    code: "NO_PHLEBO_NEAR_APPT",
    label: "No phlebo assigned",
    detail: `appointment in ${Math.round(s.minutesToAppointment)}m · no phlebo assigned`,
    sourceField: "Order.phleboName / Order.phleboNumber",
  });
}

function evalPastApptNotPickedUp(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.PAST_APPT_NOT_PICKED_UP;
  if (s.minutesToAppointment === null) {
    return unavailable(def, "order has no appointmentTime");
  }
  if (s.minutesToAppointment >= 0) return NOT_APPLICABLE;
  if (!cfg.awaitingPickupStatuses.includes(s.orderStatus)) return NOT_APPLICABLE;

  const minutesPast = -s.minutesToAppointment;
  const points = ladderPoints(def, minutesPast, (v, t) => v >= t);
  if (points === 0) return miss(def);
  return hit(def, points, {
    code: "PAST_APPT_NOT_PICKED_UP",
    label: "Appointment passed, not picked up",
    detail: `appointment was ${Math.round(minutesPast)}m ago · still ${s.orderStatus}`,
    sourceField: "Order.appointmentTime / Order.orderStatus",
  });
}

function evalStatusStale(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.STATUS_STALE;
  if (!cfg.stalenessApplicableStatuses.includes(s.orderStatus)) return NOT_APPLICABLE;
  if (s.minutesSinceStatusUpdated === null) {
    return unavailable(def, "order has no statusUpdatedAt");
  }
  const points = ladderPoints(def, s.minutesSinceStatusUpdated, (v, t) => v >= t);
  if (points === 0) return miss(def);
  return hit(def, points, {
    code: "STATUS_STALE",
    label: "Status stale",
    detail: `held in ${s.orderStatus} for ${Math.round(s.minutesSinceStatusUpdated)}m`,
    sourceField: "Order.statusUpdatedAt",
  });
}

function evalShortLeadTime(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.SHORT_LEAD_TIME;
  if (s.leadTimeMinutes === null) {
    return unavailable(def, "order has no createdAt or no appointmentTime");
  }
  const points = ladderPoints(def, s.leadTimeMinutes, (v, t) => v < t);
  if (points === 0) return miss(def);
  return hit(def, points, {
    code: "SHORT_LEAD_TIME",
    label: "Short lead time",
    detail: `booked ${Math.round(s.leadTimeMinutes)}m before the appointment`,
    sourceField: "Order.createdAt / Order.appointmentTime",
  });
}

function evalEarlyMorningSlot(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.EARLY_MORNING_SLOT;
  if (s.appointmentIstHour === null) {
    return unavailable(def, "order has no appointmentTime");
  }
  const points = ladderPoints(def, s.appointmentIstHour, (v, t) => v < t);
  if (points === 0) return miss(def);
  return hit(def, points, {
    code: "EARLY_MORNING_SLOT",
    label: "Early-morning slot",
    detail: `appointment at ${String(s.appointmentIstHour).padStart(2, "0")}:00 IST`,
    sourceField: "Order.appointmentTime (Asia/Kolkata hour)",
  });
}

function evalPriorRescheduleComm(s: OrderSignals, cfg: RiskConfig): SignalVerdict {
  const def = cfg.signals.PRIOR_RESCHEDULE_COMM;
  if (s.rescheduleCommunicationSent === null) {
    return unavailable(def, "Order.sentCommunicationRescheduled not present in source row");
  }
  if (!s.rescheduleCommunicationSent) return miss(def);
  return hit(def, def.tiers[0].points, {
    code: "PRIOR_RESCHEDULE_COMM",
    label: "Prior reschedule",
    detail: "a reschedule communication was sent on this order",
    sourceField: "Order.sentCommunicationRescheduled",
  });
}

/**
 * Evaluation order is fixed, and is the tie-breaker when two reasons carry
 * equal points — so reason ordering is deterministic, not dependent on object
 * key iteration.
 */
const SIGNAL_EVALUATORS: ReadonlyArray<{
  code: RiskSignalCode;
  run: (s: OrderSignals, cfg: RiskConfig) => SignalVerdict;
}> = [
  { code: "NO_PHLEBO_NEAR_APPT", run: evalNoPhleboNearAppt },
  { code: "PAST_APPT_NOT_PICKED_UP", run: evalPastApptNotPickedUp },
  { code: "STATUS_STALE", run: evalStatusStale },
  { code: "SHORT_LEAD_TIME", run: evalShortLeadTime },
  { code: "EARLY_MORNING_SLOT", run: evalEarlyMorningSlot },
  { code: "PRIOR_RESCHEDULE_COMM", run: evalPriorRescheduleComm },
];

/**
 * Score one order's pickup-delay risk.
 *
 * Pure: same (signals, config) always yields a deeply-equal result.
 */
export function scoreRisk(
  signals: OrderSignals,
  config: RiskConfig = DEFAULT_RISK_CONFIG,
): RiskResult {
  // Permanently blocked signals are reported on every result so the board can
  // state what was not measured. They carry no weight and never touch the
  // arithmetic — assigning a weight to a signal never observed would be
  // inventing a number.
  const unavailableSignals: UnavailableSignal[] = config.blockedSignals.map((b) => ({
    signal: b.signal,
    reason: b.reason,
  }));

  // Short-circuit: the sample is already collected, so there is no pickup
  // delay left to predict. Scoring on would let staleness and slot points
  // accumulate into a warning about something that can no longer happen.
  if (config.pickupCompleteStatuses.includes(signals.orderStatus)) {
    return {
      score: 0,
      band: "LOW",
      reasons: [],
      unavailable: unavailableSignals,
      earnedPoints: 0,
      maxEvaluablePoints: 0,
      coverageRatio: 100,
      lowConfidence: false,
    };
  }

  let earnedPoints = 0;
  let maxEvaluablePoints = 0;
  let unmeasurableWeight = 0;
  const reasons: RiskReason[] = [];

  for (const { code, run } of SIGNAL_EVALUATORS) {
    const verdict = run(signals, config);
    switch (verdict.kind) {
      case "HIT":
        earnedPoints += verdict.points;
        maxEvaluablePoints += verdict.weight;
        if (verdict.reason) reasons.push(verdict.reason);
        break;
      case "MISS":
        maxEvaluablePoints += verdict.weight;
        break;
      case "UNAVAILABLE":
        unmeasurableWeight += verdict.weight;
        unavailableSignals.push({
          signal: code,
          reason: verdict.unavailableReason ?? "input missing",
        });
        break;
      case "NOT_APPLICABLE":
        break;
    }
  }

  const score = maxEvaluablePoints > 0
    ? clampScore((100 * earnedPoints) / maxEvaluablePoints)
    : 0;

  // Coverage answers "of what applies to this order, how much could we
  // actually measure" — so phase-inapplicable signals are excluded from both
  // sides. An order with nothing evaluable reports 0, not 100.
  const applicableWeight = maxEvaluablePoints + unmeasurableWeight;
  const coverageRatio = applicableWeight > 0
    ? Math.round((100 * maxEvaluablePoints) / applicableWeight)
    : 0;

  const lowConfidence = coverageRatio < config.lowConfidenceFloorPct;

  let band = bandForScore(score);
  if (lowConfidence && config.capBandOnLowConfidence && band === "CRITICAL") {
    band = "HIGH";
  }

  // Most significant reason first; ties broken by evaluation order, which is
  // fixed above. Deterministic for identical inputs.
  reasons.sort((a, b) => b.points - a.points);

  return {
    score,
    band,
    reasons,
    unavailable: unavailableSignals,
    earnedPoints,
    maxEvaluablePoints,
    coverageRatio,
    lowConfidence,
  };
}
