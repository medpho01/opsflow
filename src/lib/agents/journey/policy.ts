/**
 * The checkpoint policy: which checkpoints an order passes and when each is
 * due (DESIGN.md §4.1, FR-2). Defaults per order type come from the ops
 * team's rules; per-lab offsets are the interim shim until the console holds
 * the SLA policy (FR-2.1) and the Brain tunes them from history (FR-2.5).
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
};

/** LabStack order statuses in the order an order moves through them. */
export const STATUS_RANK = [
  "PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED",
  "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED", "REPORT_DELIVERED",
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
  /** Due time from the order; null when the checkpoint does not apply (no slot yet). */
  dueAt: (order: OrderSnapshot, offsets: LabOffsets) => Date | null;
  /** Is it met, from the console alone? */
  met: (order: OrderSnapshot) => boolean;
  /** Checkpoints before the sample is taken are recomputed on a reschedule (FR-2.7). */
  preCollection: boolean;
};

const MIN = 60_000;
const H = 60 * MIN;
const add = (at: Date | null, ms: number): Date | null => (at ? new Date(at.getTime() + ms) : null);

/** Per-lab overrides, in minutes relative to the default anchor. */
export type LabOffsets = {
  /** Minutes BEFORE the slot a phlebo should be assigned (default 120). */
  phleboBeforeSlotMin?: number;
  /** Hours from collection to the full report (default 24). */
  reportTatHours?: number;
};

/**
 * Interim per-lab offsets (the SLA shim, FR-2.1/2.5). Lab A assigns phlebos about 30 min
 * before the slot, so the default slot − 2 h would only produce noise. Everything else
 * is the default until the Brain proposes a lab's own timing from history.
 */
export const LAB_OFFSETS: Record<number, LabOffsets> = {
  4: { phleboBeforeSlotMin: 30 }, 5: { phleboBeforeSlotMin: 30 }, 6: { phleboBeforeSlotMin: 30 }, 7: { phleboBeforeSlotMin: 30 },
};
export const offsetsFor = (labId: number | null): LabOffsets => (labId != null ? LAB_OFFSETS[labId] ?? {} : {});

const collectedAt = (order: OrderSnapshot): Date | null => {
  if (!reached(order.orderStatus, "SAMPLE_COLLECTED")) return null;
  return order.orderStatus === "SAMPLE_COLLECTED" && order.statusUpdatedAt ? order.statusUpdatedAt : order.appointmentTime ?? order.statusUpdatedAt;
};

const confirmed: CheckpointDef = {
  name: "confirmed", from: "LAB", preCollection: true,
  dueAt: (o) => add(o.createdAt, 2 * H),
  met: (o) => reached(o.orderStatus, "ORDER_SCHEDULED"),
};
const report = (tatHoursDefault: number): CheckpointDef => ({
  name: "report_delivered", from: "LAB", preCollection: false,
  dueAt: (o, off) => add(collectedAt(o) ?? o.appointmentTime, (off.reportTatHours ?? tatHoursDefault) * H),
  met: (o) => o.orderStatus === "REPORT_DELIVERED",
});

const HOME_SAMPLE: CheckpointDef[] = [
  confirmed,
  {
    name: "phlebo_assigned", from: "LAB", preCollection: true,
    dueAt: (o, off) => add(o.appointmentTime, -(off.phleboBeforeSlotMin ?? 120) * MIN),
    met: (o) => reached(o.orderStatus, "PHLEBO_ASSIGNED") || o.phleboName.trim().length > 0,
  },
  {
    name: "phlebo_reached", from: "LAB", preCollection: true,
    dueAt: (o) => add(o.appointmentTime, 15 * MIN),
    met: (o) => reached(o.orderStatus, "PATIENT_VISITED"),
  },
  {
    name: "sample_collected", from: "LAB", preCollection: true,
    dueAt: (o) => add(o.appointmentTime, 30 * MIN),
    met: (o) => reached(o.orderStatus, "SAMPLE_COLLECTED"),
  },
  {
    name: "sample_at_lab", from: "LAB", preCollection: false,
    dueAt: (o) => add(collectedAt(o) ?? add(o.appointmentTime, 30 * MIN), 4 * H),
    met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED"),
  },
  report(24),
];

const CENTER_VISIT: CheckpointDef[] = [
  { ...confirmed, name: "visit_confirmed" },
  {
    name: "patient_visited", from: "LAB", preCollection: true,
    dueAt: (o) => add(o.appointmentTime, 45 * MIN),
    met: (o) => reached(o.orderStatus, "PATIENT_VISITED") || reached(o.orderStatus, "SAMPLE_COLLECTED"),
  },
  report(36),
];

const KIT_BASED: CheckpointDef[] = [
  confirmed,
  { name: "kit_dispatched", from: "LAB", preCollection: true, dueAt: (o) => add(o.createdAt, 24 * H), met: (o) => reached(o.orderStatus, "KIT_DISPATCHED") },
  { name: "kit_delivered", from: "COURIER", preCollection: true, dueAt: (o) => add(o.createdAt, 72 * H), met: (o) => reached(o.orderStatus, "PATIENT_VISITED") },
  { name: "kit_picked_up", from: "COURIER", preCollection: true, dueAt: (o) => add(o.createdAt, 120 * H), met: (o) => reached(o.orderStatus, "SAMPLE_COLLECTED") },
  { name: "sample_at_lab", from: "COURIER", preCollection: false, dueAt: (o) => add(o.createdAt, 192 * H), met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED") },
  report(48),
];

const CAMP: CheckpointDef[] = [
  { name: "samples_received", from: "LAB", preCollection: true, dueAt: (o) => add(o.appointmentTime, 6 * H), met: (o) => reached(o.orderStatus, "SAMPLE_DELIVERED") },
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
