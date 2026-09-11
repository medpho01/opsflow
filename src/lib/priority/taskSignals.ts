/**
 * Maps a Task row (as already fetched by prisma.task.findMany in
 * src/app/api/tasks/route.ts) into the pure OrderSignals / VipSignals shapes
 * the risk scorer and VIP resolver consume.
 *
 * This is the whole adapter. There used to be a separate order-source
 * pipeline (synthetic vs. a labstack adapter, selected by a registry, fed by
 * its own bounded/circuit-broken database read) built for a standalone
 * shadow-mode runner. That pipeline is gone: scoring now runs on exactly the
 * Task row the Smart View already loaded, in the same request — one
 * pipeline, not two.
 */
import type { HniLookup, OrderSignals, VipSignals } from "./types";
import { normalizePincode } from "./hniLookup";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h30m in ms

function istHour(utcDate: Date): number {
  return new Date(utcDate.getTime() + IST_OFFSET_MS).getUTCHours();
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/** Minimal shape this mapper needs from a Task row. */
export interface TaskSignalInput {
  id: number;
  orderType: string;
  storeId: number | null;
  appointmentTime: Date | null;
  createdAt: Date;
  lastStatusUpdate: Date | null;
  /** Task.metadata — a Prisma Json field. */
  metadata: unknown;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Candidate keys checked on Task.metadata when looking for a pincode. None
 * of these are populated by taskCreator.ts today (confirmed: it writes only
 * orderId/orderStatus/appointmentTime/patientName/labName/storeName/
 * phleboName/phleboNumber/whyThisTask), so this always resolves to null on
 * real data today — but once the source starts supplying one of these keys,
 * HNI resolution activates with no code change here. Mirrors the retired
 * labstackOrderSource.ts's PINCODE_FIELD_CANDIDATES list.
 */
const PINCODE_METADATA_KEYS = [
  "pincode", "pinCode", "postalCode", "postal_code", "zipcode", "zipCode",
] as const;

function readPincode(metadata: unknown): string | null {
  for (const key of PINCODE_METADATA_KEYS) {
    const raw = metadataString(metadata, key);
    if (raw === null) continue;
    const normalized = normalizePincode(raw);
    if (normalized !== null) return normalized;
  }
  return null;
}

/**
 * `orderStatus`/phlebo fields live inside Task.metadata (JSON), not as
 * top-level columns — confirmed against taskCreator.ts. A task not created
 * through taskCreator (e.g. a manually-created task from POST /api/tasks)
 * may carry none of these keys; every field below degrades to "unavailable"
 * rather than a wrong guess in that case, which is exactly what
 * riskScorer.ts already expects for a `null` input.
 */
export function buildOrderSignalsFromTask(task: TaskSignalInput, now: Date): OrderSignals {
  const orderStatus = metadataString(task.metadata, "orderStatus") ?? "";
  const phleboName = metadataString(task.metadata, "phleboName");
  const phleboNumber = metadataString(task.metadata, "phleboNumber");
  const hasPhleboAssigned =
    phleboName === null && phleboNumber === null
      ? null
      : (phleboName?.trim().length ?? 0) > 0 || (phleboNumber?.trim().length ?? 0) > 0;

  const appt = task.appointmentTime;

  return {
    orderId: task.id,
    orderType: task.orderType,
    orderStatus,
    storeId: task.storeId,
    minutesToAppointment: appt ? minutesBetween(now, appt) : null,
    minutesSinceCreated: minutesBetween(task.createdAt, now),
    minutesSinceStatusUpdated: task.lastStatusUpdate
      ? minutesBetween(task.lastStatusUpdate, now)
      : null,
    leadTimeMinutes: appt ? minutesBetween(task.createdAt, appt) : null,
    appointmentIstHour: appt ? istHour(appt) : null,
    hasPhleboAssigned,
    // No reschedule-communication flag exists anywhere in this pipeline.
    // riskScorer.ts already treats a null input as UNAVAILABLE for this one
    // signal — this is an honest absence, not a special case to code around.
    rescheduleCommunicationSent: null,
  };
}

export function buildVipSignalsFromTask(
  task: TaskSignalInput,
  storeCity: string | null,
  hniLookup: HniLookup,
): VipSignals {
  const pincode = readPincode(task.metadata);
  return {
    orderId: task.id,
    orderType: task.orderType,
    storeId: task.storeId,
    storeCity,
    // Nothing on Task carries a customer FK today.
    customerId: null,
    customerOrderCount: null,
    pincode,
    hni: hniLookup.resolve(pincode),
  };
}
