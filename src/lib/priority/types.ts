/**
 * Priority scoring — domain types.
 *
 * These describe the pickup-delay risk model and the VIP classifier. Scoring
 * is pure: no database access, no network, no clock reads (time-derived
 * inputs arrive pre-computed on OrderSignals against a `now` pinned once per
 * request).
 *
 * There used to be a separate observational "shadow mode" pipeline with its
 * own persisted snapshot type and its own order-source adapter boundary.
 * Both are gone: scoring now runs inline against the same Task data the
 * Smart View already fetches, so there is nothing here describing a second
 * data source or a stored evaluation row.
 */
/**
 * Not a Prisma enum: the band is never persisted (see the schema.prisma
 * comment above the HNI models), and Prisma Client only emits an enum
 * that's actually used by a model field.
 */
export type PriorityRiskBand = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Mandated band cutoffs (inclusive lower bound, inclusive upper bound).
 * LOW 0-24 / MEDIUM 25-49 / HIGH 50-74 / CRITICAL 75-100.
 */
export const RISK_BAND_BOUNDS: ReadonlyArray<{
  band: PriorityRiskBand;
  min: number;
  max: number;
}> = [
  { band: "LOW", min: 0, max: 24 },
  { band: "MEDIUM", min: 25, max: 49 },
  { band: "HIGH", min: 50, max: 74 },
  { band: "CRITICAL", min: 75, max: 100 },
];

/** A signal that fired and contributed points, with its human-readable "why". */
export interface RiskReason {
  /** Stable machine code, e.g. "NO_PHLEBO_NEAR_APPT". Safe to group on. */
  code: string;
  /** Short label for the board chip. */
  label: string;
  /** Points this signal contributed to earnedPoints. */
  points: number;
  /**
   * Operator-facing sentence, rendered verbatim — e.g.
   * "appointment in 75m · no phlebo assigned". Must never contain patient
   * name, phone, notes, or internalNotes.
   */
  detail: string;
  /** Source field the signal was derived from, e.g. "Order.phleboName". */
  sourceField: string;
}

/** Why an order was flagged VIP. `vip` is derived FROM this list. */
export interface VipReason {
  /** Stable machine code, e.g. "HNI_PINCODE". Safe to group and filter on. */
  code: string;
  /** Short label for a board chip. */
  label: string;
  /** Category the reason belongs to. Coarser than `code`. */
  basis: "HNI" | "VALUE" | "CUSTOMER" | "LIST";
  /**
   * Operator-facing sentence, rendered verbatim. Must never contain a
   * patient name, phone number, or customer identifier.
   */
  detail: string;
  /** The field this was derived from, e.g. "HniPincode.classification". */
  sourceField: string;
}

/**
 * A signal that could NOT be evaluated. Recorded so "not measured" stays
 * distinct from "measured zero" — unavailable signals are removed from the
 * scoring denominator rather than scored as absent, and are surfaced in the
 * UI as an explicit coverage caveat.
 */
export interface UnavailableSignal {
  signal: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// RISK MODEL
// ─────────────────────────────────────────────────────────────────────────

/**
 * The pre-computed inputs the risk engine scores. Every field maps to a
 * field confirmed present in this repository — nothing here is invented.
 *
 * All clock arithmetic is done BEFORE this object is built, against a `now`
 * pinned once per request. The scorer therefore reads no clock at all, which
 * is what makes it deterministic.
 */
export interface OrderSignals {
  /** Task.id (this schema denormalizes order data onto Task directly). */
  orderId: number;
  /** Task.orderType — HOME_SAMPLE | CENTER_VISIT | CAMP | KIT_BASED | INJECTION */
  orderType: string;
  /** The order's status, e.g. from Task.metadata.orderStatus. */
  orderStatus: string;
  /** Task.storeId */
  storeId: number | null;
  /** Minutes until Task.appointmentTime. Negative = the appointment passed. */
  minutesToAppointment: number | null;
  /** Minutes since Task.createdAt. */
  minutesSinceCreated: number | null;
  /** Minutes since Task.lastStatusUpdate. */
  minutesSinceStatusUpdated: number | null;
  /** appointmentTime - createdAt, in minutes. */
  leadTimeMinutes: number | null;
  /** Hour-of-day (0-23) of the appointment in Asia/Kolkata. */
  appointmentIstHour: number | null;
  /**
   * Derived from phleboName / phleboNumber being non-empty.
   * `null` when neither field was readable — which is NOT the same as false.
   */
  hasPhleboAssigned: boolean | null;
  /** Whether a reschedule communication was sent. `null` when the key was absent. */
  rescheduleCommunicationSent: boolean | null;
}

/** One rung of a threshold ladder. Higher-severity rungs are listed first. */
export interface RiskSignalTier {
  thresholdMin: number;
  points: number;
}

export interface RiskSignalDef {
  maxPoints: number;
  tiers: RiskSignalTier[];
}

/** Signals that cannot be computed from data available in this repository. */
export interface BlockedSignalDef {
  signal: string;
  reason: string;
}

export interface RiskConfig {
  configVersion: number;
  pickupCompleteStatuses: string[];
  awaitingPickupStatuses: string[];
  stalenessApplicableStatuses: string[];
  signals: Record<RiskSignalCode, RiskSignalDef>;
  blockedSignals: BlockedSignalDef[];
  bandThresholds: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
  lowConfidenceFloorPct: number;
  capBandOnLowConfidence: boolean;
}

export type RiskSignalCode =
  | "NO_PHLEBO_NEAR_APPT"
  | "PAST_APPT_NOT_PICKED_UP"
  | "STATUS_STALE"
  | "SHORT_LEAD_TIME"
  | "EARLY_MORNING_SLOT"
  | "PRIOR_RESCHEDULE_COMM";

/**
 * Per-signal evaluation outcome. Three states, not two — the distinction
 * between them is what keeps the score honest:
 *
 *   HIT            fired; contributes points, and its weight is in the denominator
 *   MISS           evaluated, did not fire; 0 points, weight IS in the denominator
 *   NOT_APPLICABLE does not apply to this order's phase (e.g. the
 *                  before-appointment signal on an order whose appointment has
 *                  passed); excluded from BOTH numerator and denominator
 *   UNAVAILABLE    applies, but the input was missing; excluded from both, and
 *                  reported so "not measured" never reads as "measured zero"
 */
export type SignalEvaluationKind = "HIT" | "MISS" | "NOT_APPLICABLE" | "UNAVAILABLE";

export interface RiskResult {
  /** Integer 0-100, always. */
  score: number;
  band: PriorityRiskBand;
  /** Signals that fired, ordered most-significant first. */
  reasons: RiskReason[];
  /** Applicable-but-unmeasurable signals, plus the permanently blocked ones. */
  unavailable: UnavailableSignal[];
  earnedPoints: number;
  /** Denominator used: total weight of signals that were actually evaluated. */
  maxEvaluablePoints: number;
  /** maxEvaluablePoints / (maxEvaluablePoints + unavailable applicable weight). */
  coverageRatio: number;
  lowConfidence: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// VIP MODEL
// ─────────────────────────────────────────────────────────────────────────

/**
 * Inputs to the VIP classifier. Every field maps to something confirmed
 * present in this repository. Note what is ABSENT and why:
 *
 *   no customer/patient FK  — Task carries no userId
 *   no order value          — no monetary column exists anywhere
 *   no customer tier        — no such field exists anywhere
 *
 * There is deliberately NO risk field here. The classifier cannot see a risk
 * score even if a caller wanted it to.
 */
export interface VipSignals {
  orderId: number;
  orderType: string;
  /** Task.storeId */
  storeId: number | null;
  /** Store.city, via the storeId join already done in tasks/route.ts. `null` when unknown. */
  storeCity: string | null;
  /**
   * Customer FK. `null` today — nothing on Task carries one. Kept as a field
   * so a future source of customerId (e.g. surfaced into Task.metadata) needs
   * no shape change here.
   */
  customerId: number | null;
  /**
   * Count of this customer's orders in the configured trailing window.
   * `null` when not computed — which is NOT the same as zero.
   */
  customerOrderCount: number | null;
  /** Normalised pincode, or null when the source has none (true for every real order today). */
  pincode: string | null;
  /**
   * Outcome of resolving `pincode` against the HNI reference table. Carries
   * the full status so the classifier can tell "not an affluent area" apart
   * from "we hold no classification for this area".
   */
  hni: HniResolution;
}

export type VipProviderCode =
  | "LIST_CUSTOMER"
  | "LIST_STORE"
  | "LIST_CITY"
  | "REPEAT_CUSTOMER"
  | "HNI"
  | "VALUE"
  | "CUSTOMER_TIER";

export interface VipConfig {
  configVersion: number;
  /** Ops-maintained inclusion lists. Empty by default — VIP stays inert. */
  vipCustomerIds: number[];
  vipStoreIds: number[];
  /** Compared case- and whitespace-insensitively. */
  vipCities: string[];
  /**
   * Exclusion overrides. An explicit exclusion is a deliberate ops
   * correction, so it beats every inclusion rule.
   */
  excludedCustomerIds: number[];
  excludedStoreIds: number[];
  repeatCustomer: {
    /** Disabled by default: no business threshold has been defined. */
    enabled: boolean;
    minOrders: number;
    windowMonths: number;
  };
  /**
   * How the HNI signal treats each classification outcome.
   *
   * Every policy is explicit rather than implied, because the ambiguous case
   * is the one that matters: a MIXED pincode contains both affluent and
   * non-affluent localities, and promoting it to VIP automatically would
   * assert something the reference data does not say.
   */
  hni: {
    /** Master switch. When false the provider reports UNAVAILABLE. */
    enabled: boolean;
    /** What a MIXED classification means. Defaults to UNDETERMINED. */
    mixedPolicy: "NOT_VIP" | "VIP" | "UNDETERMINED";
    /**
     * What an absent (or deactivated) pincode means. Defaults to
     * UNDETERMINED, because an incomplete reference table cannot support
     * the claim "this area is not affluent".
     */
    unlistedPolicy: "NOT_VIP" | "UNDETERMINED";
    /**
     * What an UNKNOWN classification means. UNKNOWN says the reference data
     * never established how cleanly the PIN maps to the affluent locality —
     * which is NOT the same claim as MIXED. It therefore gets its own policy
     * rather than being folded into mixedPolicy. Defaults to UNDETERMINED.
     */
    unknownPolicy: "NOT_VIP" | "VIP" | "UNDETERMINED";
    /**
     * Optional floor on the reference data's own purity indicator. An HNI
     * row below it is treated as MIXED. Null disables the check.
     */
    minPurityPct: number | null;
  };
  /** Providers that cannot be evaluated from data in this repository. */
  blockedProviders: { provider: VipProviderCode; reason: string }[];
}

export interface VipResult {
  /** Derived FROM `reasons` — "true with no reason" is unrepresentable. */
  vip: boolean;
  reasons: VipReason[];
  unavailable: UnavailableSignal[];
  /**
   * Rules that WOULD have fired but were overridden by an ops exclusion.
   * Kept so a false is as explainable as a true.
   */
  suppressedReasons: VipReason[];
  /** Set when an ops exclusion overrode one or more inclusion rules. */
  suppressedBy: string | null;
  /**
   * How many providers could actually be evaluated. Zero means "VIP not
   * evaluated", which the UI must render differently from "not VIP".
   */
  evaluatedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────
// HNI LOOKUP
// ─────────────────────────────────────────────────────────────────────────

export type HniClassificationValue = "HNI" | "NON_HNI" | "MIXED" | "UNKNOWN";

/** One classified pincode, as the lookup returns it. */
export interface HniPincodeRecord {
  pincode: string;
  locality: string | null;
  city: string | null;
  state: string | null;
  classification: HniClassificationValue;
  purityPct: number | null;
  rationale: string | null;
  /**
   * The reference data's own vocabulary, preserved verbatim. Optional
   * because rows loaded before these columns existed simply do not carry
   * them; nothing is inferred when they are absent.
   */
  tier?: "A" | "B" | "C" | null;
  pinPurity?: "PURE" | "MIXED" | "UNKNOWN" | null;
  confidence?: "HIGH" | "MED" | null;
}

/**
 * The outcome of resolving one order's pincode against the reference data.
 *
 * `status` is deliberately four-valued so the VIP engine can distinguish
 * "this area is not affluent" from "we don't know", and so an ambiguous
 * MIXED area is never silently promoted to HNI.
 */
export type HniResolutionStatus =
  /** No pincode on the order. */
  | "NO_PINCODE"
  /** Pincode present but not a valid six-digit value. */
  | "INVALID_PINCODE"
  /** Valid pincode, absent from (or inactive in) the reference data. */
  | "NOT_CLASSIFIED"
  /** Found and classified. */
  | "CLASSIFIED";

export interface HniResolution {
  status: HniResolutionStatus;
  /** The normalised pincode, when one could be derived. */
  pincode: string | null;
  /** Present only when status is CLASSIFIED. */
  record: HniPincodeRecord | null;
}

/** Pincode → classification. Backed by the database, or by a map in tests. */
export interface HniLookup {
  resolve(rawPincode: string | null): HniResolution;
}
