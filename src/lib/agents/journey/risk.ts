/**
 * Risk scoring (FR-16.2): a deterministic score with reasons, recomputed on
 * every wake and in the 05:45 and 19:00 batches. Each signal adds points from
 * the SOP's weights; the Brain retunes them from recorded outcomes (FR-16.7).
 */
import type { CheckpointState } from "./step";
import { PLACEHOLDER_LAB_ID, type OrderSnapshot } from "./policy";

const MIN = 60_000;
const H = 60 * MIN;

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type RiskContext = {
  now: Date;
  order: OrderSnapshot;
  checkpoints: CheckpointState[];
  subStates: string[];
  rescheduleCount: number;
  /** Hours since the lab's group last wrote today, null when unknown or active. */
  labSilentHours?: number | null;
  /** Orders this lab has in the same hour vs its p90 for that hour, when known. */
  slotLoadRatio?: number | null;
  poorPincode?: boolean;
  labHoliday?: boolean;
  weights: Record<string, number>;
  thresholds: { medium: number; high: number };
};
export type RiskResult = { level: RiskLevel; score: number; reasons: string[]; cannotDoToday: boolean; predictedDelayMin: number | null };

export function scoreRisk(ctx: RiskContext): RiskResult {
  const { now, order, checkpoints, weights, thresholds } = ctx;
  const w = (k: string, d: number) => weights[k] ?? d;
  let score = 0;
  const reasons: string[] = [];
  const add = (k: string, d: number, reason: string) => { score += w(k, d); reasons.push(reason); };
  const slot = order.appointmentTime;
  const hoursToSlot = slot ? (slot.getTime() - now.getTime()) / H : null;
  const cp = (name: string) => checkpoints.find((c) => c.name === name);

  if (order.labId === PLACEHOLDER_LAB_ID || order.labId == null) add("placeholder_lab", 5, "no real lab assigned");
  if (cp("confirmed")?.status !== "MET" && cp("visit_confirmed")?.status !== "MET" && hoursToSlot != null && hoursToSlot <= 14 && hoursToSlot > -1) {
    add("unconfirmed_slot_soon", 3, `lab has not confirmed, slot in ${Math.max(0, Math.round(hoursToSlot))} h`);
  }
  const phlebo = cp("phlebo_assigned");
  if (phlebo && phlebo.status !== "MET" && phlebo.status !== "WAIVED" && now.getTime() > phlebo.dueAt.getTime()) add("no_phlebo_by_usual_time", 3, "no phlebo by the lab's usual time");
  if (ctx.labSilentHours != null && ctx.labSilentHours >= 2 && hoursToSlot != null && hoursToSlot <= 24) add("lab_silent_today", 2, `lab silent for ${Math.round(ctx.labSilentHours)} h`);
  if (ctx.slotLoadRatio != null && ctx.slotLoadRatio > 1) add("slot_overloaded", 2, "more orders in this slot than the lab usually handles");
  if (ctx.poorPincode) add("poor_pincode", 1, "pincode with poor collection history");
  if (ctx.subStates.includes("patient_missed")) add("earlier_patient_missed", 1, "patient missed earlier on this order");
  if (ctx.rescheduleCount > 0) { score += w("earlier_reschedule", 1) * ctx.rescheduleCount; reasons.push(`rescheduled ${ctx.rescheduleCount}×`); }
  const kit = cp("kit_delivered");
  if (kit && kit.status === "BREACHED") add("kit_not_delivered", 3, "kit not delivered by the courier's ETA");
  const report = cp("report_delivered");
  if (report && report.status !== "MET" && report.status !== "WAIVED" && cp("sample_collected")?.status === "MET" && now.getTime() > report.dueAt.getTime() - 2 * H) add("report_likely_late", 2, "report will run past TAT");
  if (ctx.labHoliday) add("lab_holiday", 5, "lab holiday");

  const level: RiskLevel = score >= thresholds.high ? "HIGH" : score >= thresholds.medium ? "MEDIUM" : "LOW";
  const cannotDoToday = level === "HIGH" && (reasons.includes("no real lab assigned") || ctx.labHoliday === true || (ctx.labSilentHours != null && ctx.labSilentHours >= 4 && hoursToSlot != null && hoursToSlot <= 3));
  const predictedDelayMin = level === "LOW" ? null : level === "MEDIUM" ? 60 : 180;
  return { level, score, reasons, cannotDoToday, predictedDelayMin };
}
