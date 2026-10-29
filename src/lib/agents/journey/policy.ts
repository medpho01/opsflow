/**
 * The checkpoint policy: which checkpoints an order passes and when each is
 * due (DESIGN.md §4.1, FR-2). Each checkpoint has an anchor (the order's
 * creation, the slot, the collection) and a default offset per order type,
 * taken from the ops team's rules. The LAB SOP owns the offset
 * (`asks.<checkpoint>.dueOffsetMin`, with per-lab or per-tier overrides the
 * Brain proposes from history, FR-2.5) — nothing per lab lives in code.
 *
 * Everything here is pure: a snapshot of the order in, checkpoints out.
 */

export type CheckpointName =
  | "confirmed" | "phlebo_assigned" | "phlebo_reached" | "sample_collected" | "sample_at_lab" | "report_delivered"
  | "visit_confirmed" | "patient_visited"
  | "kit_dispatched" | "kit_delivered" | "kit_picked_up"
  | "samples_received";

export type WaitingFrom = "LAB" | "OPS" | "COURIER" | "STORE";

/** The slice of a LabStack order the policy and the step function read. */
export type OrderSnapshot = {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date | null;
  labId: number | null;
  storeId: number | null;
  createdAt: Date;
  statusUpdatedAt: Date | null;
  phleboName: string;
  patientName: string | null;
  labName: string | null;
  storeName: string | null;
  /** The lab's own order reference (API labs), the patient's mobile and locality — what a lab needs to find the order. */
  labRef?: string | null;
  mobile?: string | null;
  area?: string | null;
  /** LabStack's own note on the latest change (reschedule or cancel reason), when there is one. */
  statusNote?: string | null;
};

/**
 * LabStack order statuses in the order an order moves through them. Every status LabStack has:
 * one missing ranks −1 and "reaches" nothing (29 Oct 2026: PARTIAL_DELIVERED orders were listed to
 * the store as "not collected yet" and asked "collected?").
 */
export const STATUS_RANK = [
  "PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "PHLEBO_DISPATCHED", "PHLEBO_STARTED", "KIT_DISPATCHED",
  "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_IN_TRANSIT", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED", "PARTIAL_DELIVERED", "REPORT_READY", "REPORT_DELIVERED",
] as const;
export const rankOf = (status: string): number => (STATUS_RANK as readonly string[]).indexOf(status);
export const reached = (status: string, atLeast: string): boolean => rankOf(status) >= rankOf(atLeast) && rankOf(status) >= 0;

/** Statuses that close a journey (FR-1.9). PATIENT_MISSED stays open: it waits for a new slot (FR-2.13). */
export const TERMINAL_STATUSES = new Set(["CANCELED", "CANCELLED", "REPORT_DELIVERED"]);

/** LabStack's placeholder lab: the order has no real lab yet (Intake desk). */
export const PLACEHOLDER_LAB_ID = 1;

export type CheckpointDef = {
  name: CheckpointName;
  from: WaitingFrom;
  /** What the due time is measured from. */
  anchor: Anchor;
  /** Minutes from the anchor by default; the SOP's `dueOffsetMin` replaces it. */
  defaultOffsetMin: number;
  /** Due time from the order; null when the checkpoint does not apply (no slot yet). */
  dueAt: (order: OrderSnapshot, offsetMin?: number | null) => Date | null;
  /** Is it met, from the console alone? */
  met: (order: OrderSnapshot) => boolean;
  /** Checkpoints before the sample is taken are recomputed on a reschedule (FR-2.7). */
  preCollection: boolean;
};

const MIN = 60_000;
const H = 60 * MIN;
const add = (at: Date | null, ms: number): Date | null => (at ? new Date(at.getTime() + ms) : null);

/** Anchors a checkpoint's due time is measured from. */
export type Anchor = "created" | "slot" | "collected";

const collectedAt = (order: OrderSnapshot): Date | null => {
  if (!reached(order.orderStatus, "SAMPLE_COLLECTED")) return null;
  return order.orderStatus === "SAMPLE_COLLECTED" && order.statusUpdatedAt ? order.statusUpdatedAt : order.appointmentTime ?? order.statusUpdatedAt;
};

const anchorAt = (anchor: Anchor, o: OrderSnapshot): Date | null =>
  anchor === "created" ? o.createdAt : anchor === "slot" ? o.appointmentTime : collectedAt(o) ?? add(o.appointmentTime, 30 * MIN);

type Spec = Omit<CheckpointDef, "dueAt">;
const cp = (spec: Spec): CheckpointDef => ({
  ...spec,
  dueAt: (o, offsetMin) => add(anchorAt(spec.anchor, o), (offsetMin ?? spec.defaultOffsetMin) * MIN),
});

const confirmed = cp({
  name: "confirmed", from: "LAB", preCollection: true, anchor: "created", defaultOffsetMin: 2 * 60,
  met: (o) => reached(o.orderStatus, "ORDER_SCHEDULED"),
});
const report = (tatHoursDefault: number): CheckpointDef => cp({
  name: "report_delivered", from: "LAB", preCollection: false, anchor: "collected", defaultOffsetMin: tatHoursDefault * 60,
  met: (o) => o.orderStatus === "REPORT_DELIVERED",
});

const HOME_SAMPLE: CheckpointDef[] = [
  confirmed,
  cp({
    name: "phlebo_assigned", from: "LAB", preCollection: true, anchor: "slot", defaultOffsetMin: -120,
    met: (o) => reached(o.orderStatus, "PHLEBO_ASSIGNED") || o.phleboName.trim().length > 0,
  }),
  cp({ name: "phlebo_reached", from: "LAB", preCollection: true, anchor: "slot", defaultOffsetMin: 15, met: (o) => reached(o.orderStatus, "PATIENT_VISITED") }),
  cp({ name: "sample_collected", from: "LAB", preCollection: true, anchor: "slot", defaultOffsetMin: 30, met: (o) => reached(o.orderStatus, "SAMPLE_COLLECTED") }),
  cp({ name: "sample_at_lab", from: "LAB", preCollection: false, anchor: "collected", defaultOffsetMin: 4 * 60, met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED") }),
  report(24),
];

const CENTER_VISIT: CheckpointDef[] = [
  { ...confirmed, name: "visit_confirmed" },
  cp({
    name: "patient_visited", from: "LAB", preCollection: true, anchor: "slot", defaultOffsetMin: 45,
    met: (o) => reached(o.orderStatus, "PATIENT_VISITED") || reached(o.orderStatus, "SAMPLE_COLLECTED"),
  }),
  report(36),
];

const KIT_BASED: CheckpointDef[] = [
  confirmed,
  cp({ name: "kit_dispatched", from: "LAB", preCollection: true, anchor: "created", defaultOffsetMin: 24 * 60, met: (o) => reached(o.orderStatus, "KIT_DISPATCHED") }),
  cp({ name: "kit_delivered", from: "COURIER", preCollection: true, anchor: "created", defaultOffsetMin: 72 * 60, met: (o) => reached(o.orderStatus, "PATIENT_VISITED") }),
  cp({ name: "kit_picked_up", from: "COURIER", preCollection: true, anchor: "created", defaultOffsetMin: 120 * 60, met: (o) => reached(o.orderStatus, "SAMPLE_COLLECTED") }),
  cp({ name: "sample_at_lab", from: "COURIER", preCollection: false, anchor: "created", defaultOffsetMin: 192 * 60, met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED") }),
  report(48),
];

const CAMP: CheckpointDef[] = [
  cp({ name: "samples_received", from: "LAB", preCollection: true, anchor: "slot", defaultOffsetMin: 6 * 60, met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED") }),
  report(48),
];

export function checkpointDefs(orderType: string): CheckpointDef[] {
  switch (orderType) {
    case "CENTER_VISIT": return CENTER_VISIT;
    case "KIT_BASED": return KIT_BASED;
    case "CAMP": case "SAMPLE_DROP_OFF": return CAMP;
    default: return HOME_SAMPLE;
  }
}

/** Who the order waits on for a checkpoint: the placeholder lab means ops has to route it first. */
export function waitingFrom(def: CheckpointDef, order: OrderSnapshot): WaitingFrom {
  if (order.labId === PLACEHOLDER_LAB_ID || order.labId == null) return "OPS";
  return def.from;
}
