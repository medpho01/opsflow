/**
 * The baseline SOPs (FR-5.4): v1 of each desk, written from the ops rules,
 * the current standard message set (provider-rules/standard-set.ts) and the
 * decisions in DESIGN.md. Seeded once; after that the SOP library and the
 * Brain's proposals own them. Nothing a lab sees changes when the Lab desk
 * moves from today's message rules to this SOP: same asks, same slots.
 */
import prisma from "@/lib/db/client";
import { parseSop, type SopBody } from "./schema";

export const LAB_SOP_V1: SopBody = parseSop({
  desk: "LAB",
  title: "Lab desk — collection and reports at every lab",
  description: "Chase each checkpoint once it is late, up the ladder, with one numbered ask per slot. Update the console when the evidence bar is met.",
  params: {
    rungGapMin: 30, brokenPromisesSkip: 2, answerHoldMin: 120, defaultPromiseMin: 120, promiseGraceMin: 15,
    workingHours: { start: "08:30", end: "20:00" },
    nightFloor: { start: "22:00", end: "05:00" },
    ladder: ["ask", "reminder", "manager_whatsapp", "task", "stuck"],
    asks: {
      confirmed: { intent: "UNCONFIRMED", leadMin: 0, graceMin: 600, urgentWithinMin: 90, nightBefore: true },
      phlebo_assigned: { intent: "PHLEBO", leadMin: 0, graceMin: 180, urgentWithinMin: 90, nightBefore: true },
      phlebo_reached: { intent: "ETA", leadMin: 0, graceMin: 90, urgentWithinMin: 90, nightBefore: false },
      sample_collected: { intent: "STATUS", leadMin: 0, graceMin: 480, urgentWithinMin: 0, nightBefore: false },
      sample_at_lab: { intent: "OVERDUE", leadMin: 0, graceMin: 720, urgentWithinMin: 0, nightBefore: false },
      report_delivered: { intent: "REPORT", leadMin: 0, graceMin: 2880, urgentWithinMin: 0, nightBefore: false },
      visit_confirmed: { intent: "UNCONFIRMED", leadMin: 0, graceMin: 600, urgentWithinMin: 90, nightBefore: true },
      patient_visited: { intent: "STATUS", leadMin: 0, graceMin: 480, urgentWithinMin: 0, nightBefore: false },
      samples_received: { intent: "OVERDUE", leadMin: 0, graceMin: 720, urgentWithinMin: 0, nightBefore: false },
    },
    evidenceBar: {
      SAMPLE_COLLECTED: { sources: ["console", "portal", "action_page", "lab_reply"], minConfidence: 0.85, needsOrderNamed: true },
      SAMPLE_DELIVERED: { sources: ["console", "portal", "action_page", "lab_reply"], minConfidence: 0.9, needsOrderNamed: true },
      PHLEBO_STARTED: { sources: ["console", "portal", "action_page", "lab_reply"], minConfidence: 0.85, needsOrderNamed: true },
      PATIENT_MISSED: { sources: ["console", "portal", "action_page", "lab_reply"], minConfidence: 0.9, needsOrderNamed: true, alwaysSuggest: true },
      PHLEBO_NO_SHOW: { sources: ["console", "lab_reply", "store_msg"], minConfidence: 0.9, needsOrderNamed: true, alwaysSuggest: true },
    },
    handoffs: [
      { onFact: "patient_unavailable", do: "store_alert", template: "STORE_PATIENT_UNREACHABLE" },
      { onFact: "cannot_fulfil", do: "create_task", taskType: "AGENT_LAB_CANNOT_FULFIL" },
      { onFact: "sample_collected", do: "status_write", transition: "SAMPLE_COLLECTED" },
      { onFact: "sample_delivered", do: "status_write", transition: "SAMPLE_DELIVERED" },
      { onFact: "phlebo_started", do: "status_write", transition: "PHLEBO_STARTED" },
      { onFact: "report_shared", do: "create_task", taskType: "AGENT_REPORT_UPLOAD" },
    ],
    menu: ["ask", "reminder", "manager_whatsapp", "call", "create_task", "stuck", "portal_read", "status_write", "store_alert", "store_warning", "ack", "wait"],
    riskWeights: {
      unconfirmed_slot_soon: 3, placeholder_lab: 5, no_phlebo_by_usual_time: 3, lab_silent_today: 2, slot_overloaded: 2,
      poor_pincode: 1, earlier_patient_missed: 1, earlier_reschedule: 1, kit_not_delivered: 3, report_likely_late: 2, lab_holiday: 5,
    },
    riskThresholds: { medium: 3, high: 5 },
    warnStoreBeforeMin: 120,
    consoleQuietMin: 90, reportRungGapMin: 1440, urgentAfterVisitMin: 240,
  },
  overrides: [
    // API labs: the portal is the first rung when an order runs late (FR-17.2).
    { when: { labTier: "A" }, set: { ladder: ["portal_read", "ask", "reminder", "manager_whatsapp", "task", "stuck"] } },
    { when: { labTier: "B" }, set: { ladder: ["portal_read", "ask", "reminder", "manager_whatsapp", "task", "stuck"] } },
    // Manual labs: no portal; chase early and the night before (FR-2.5).
    { when: { labTier: "C" }, set: { asks: { phlebo_assigned: { intent: "PHLEBO", leadMin: 0, graceMin: 180, urgentWithinMin: 90, nightBefore: true } } } },
  ],
  bounds: {
    "params.rungGapMin": { min: 20, max: 60 },
    "params.answerHoldMin": { min: 60, max: 240 },
    "params.defaultPromiseMin": { min: 60, max: 240 },
    "params.promiseGraceMin": { min: 5, max: 30 },
    "params.warnStoreBeforeMin": { min: 60, max: 240 },
    "params.consoleQuietMin": { min: 30, max: 240 },
    "params.reportRungGapMin": { min: 240, max: 2880 },
    "params.urgentAfterVisitMin": { min: 60, max: 480 },
  },
  provenance: {
    ladder: "Ops rules; FR-8.7; CHAT-REVIEW-OCT-2026 (hourly @mention asks are what gets answered)",
    "asks.confirmed": "Standard message set: reminders 1 h / 3 h, final reminder 5 h, 2 h before",
    "asks.phlebo_assigned": "Standard message set: assign a phlebo 2 h before; Lab A assigns at slot − 30 min (FR-2.5)",
    "asks.report_delivered": "Standard message set: report chase every 3 h, 08:00–20:00",
    evidenceBar: "Decision 21 Oct: one bar per transition, 0.85; patient missed and no-show always suggest",
    handoffs: "FR-8.9, FR-11.1: patient unreachable → alert the store in its group",
    consoleQuietMin: "27 Oct 2026: an Orange order updated at 7:50 was never asked about at 10:00 — live means updated in the last 90 min",
    reportRungGapMin: "27 Oct 2026: a 20-day report backlog must climb its ladder a day at a time",
    storeExceptionPhrases: "27 Oct 2026: '94669 - phlebo no show' (Plum) — the lab is asked at once, whatever the console shows",
    urgentAfterVisitMin: "27 Oct 2026: Redcliffe's phlebo started 7:09 for an 8:00 visit and went quiet; 'on time?' waited for the 10:30 slot",
  },
});

export const STORE_SOP_V1: SopBody = parseSop({
  desk: "STORE",
  title: "Store desk — every store question closed from its group",
  description: "Answer from the journey and the console within 5 minutes; otherwise chase the lab and relay; change requests become tasks with the exact change.",
  params: {
    workingHours: { start: "07:00", end: "21:00" },
    nightFloor: { start: "22:00", end: "06:00" },
    ladder: ["ask", "reminder", "task"],
    menu: ["store_reply", "store_alert", "store_warning", "create_task", "ask", "ack", "wait"],
    intents: {
      status: { do: "answer" },
      report: { do: "answer" },
      slot: { do: "answer" },
      reschedule: { do: "task", taskType: "AGENT_RESCHEDULE", template: "STORE_NOTED" },
      cancel: { do: "task", taskType: "AGENT_CANCEL", template: "STORE_NOTED" },
      change_tests: { do: "task", taskType: "AGENT_ORDER_CHANGE", template: "STORE_NOTED" },
      new_booking: { do: "task", taskType: "AGENT_NEW_BOOKING" },
      serviceability: { do: "network_task", taskType: "AGENT_SERVICEABILITY" },
      complaint: { do: "escalation", taskType: "AGENT_COMPLAINT" },
      noise: { do: "ignore" },
    },
    warnStoreBeforeMin: 120,
  },
  overrides: [],
  bounds: { "params.warnStoreBeforeMin": { min: 60, max: 240 } },
  provenance: { intents: "FR-9.1 to 9.6; store-bot analysis Jun–Aug (status checks 2,612 of 12,427 messages)" },
});

export const INTAKE_SOP_V1: SopBody = parseSop({
  desk: "INTAKE",
  title: "Intake desk — from created to scheduled",
  description: "Placement errors, placeholder labs and unconfirmed orders become the right task or ask at once.",
  params: {
    ladder: ["task"],
    menu: ["create_task", "ask", "wait"],
    asks: { confirmed: { intent: "UNCONFIRMED", leadMin: 0, graceMin: 600, urgentWithinMin: 90, nightBefore: true } },
    handoffs: [
      { onFact: "placement_error", do: "create_task", taskType: "AGENT_PLACEMENT_RETRY" },
      { onFact: "placeholder_lab", do: "create_task", taskType: "AGENT_FIND_LAB" },
    ],
  },
  overrides: [],
  bounds: {},
  provenance: { handoffs: "Flow 7: placement error → retry task; placeholder lab 72 h before the slot → network-team task" },
});

export const BASELINE: Record<string, SopBody> = { LAB: LAB_SOP_V1, STORE: STORE_SOP_V1, INTAKE: INTAKE_SOP_V1 };

/** Seed the baseline SOPs where a desk has none. Safe on every boot. */
export async function ensureBaselineSops(): Promise<string[]> {
  const seeded: string[] = [];
  for (const [desk, body] of Object.entries(BASELINE)) {
    const existing = await prisma.agentSop.findUnique({ where: { desk } });
    if (existing?.currentVersionId) continue;
    const sop = existing ?? await prisma.agentSop.create({ data: { desk } });
    const version = await prisma.agentSopVersion.create({
      data: { sopId: sop.id, version: 1, body: body as object, author: "SYSTEM", status: "LIVE", approvedAt: new Date(), summary: "Baseline from the ops rules and the current message set" },
    });
    await prisma.agentSop.update({ where: { id: sop.id }, data: { currentVersionId: version.id } });
    seeded.push(desk);
  }
  return seeded;
}
