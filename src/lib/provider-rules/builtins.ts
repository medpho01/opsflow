/**
 * The built-in message rules.
 *
 * The first group reproduces what labs already receive — the new-order
 * message, the 1h/3h/5h reminders, the appointment pings, the status check and
 * the evening list — with the same moments and templates, so the move to
 * rules changes nothing a lab sees. The second group adds the communications
 * agreed in Oct 2026 (assign a phlebo, phlebo ETA, report chase, pending
 * reports) and is seeded PAUSED: turning one on is a decision, not a deploy.
 *
 * Seeded once by builtInKey; after that they are ordinary rules — edit a
 * timing and every open order follows it on the next tick.
 */
import type { Prisma } from "@prisma/client";
import type { RuleCondition } from "./types";

/** LabStack statuses in which the lab has not confirmed yet. */
export const AWAITING_STATUSES = ["PENDING", "CREATED"];
/** Confirmed by the lab, phlebo not yet assigned. */
export const CONFIRMED_UNASSIGNED_STATUSES = ["ORDER_SCHEDULED", "RESCHEDULED"];
/** Open and not yet collected. */
export const NOT_COLLECTED_STATUSES = ["PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED"];
/** Collected, report not delivered yet. */
export const REPORT_PENDING_STATUSES = ["PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED"];
/** Conversation states in which chasing a confirmation still makes sense. */
export const OPEN_CONVERSATION = ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED"];

export type BuiltIn = Omit<Prisma.ProviderMessageRuleCreateInput, "ledger" | "triggerCondition"> & {
  builtInKey: string;
  triggerCondition: RuleCondition;
};

const hours = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} min`);

const reminder = (key: string, name: string, minutes: number, templateKey: string, priority: number, extra: Partial<BuiltIn> = {}): BuiltIn => ({
  builtInKey: key,
  name,
  description: `Sent ${hours(minutes)} after the order while the lab has not confirmed it. Never after the appointment.`,
  triggerCondition: { statusIn: AWAITING_STATUSES, minutesSinceCreated: minutes },
  conversationStatusIn: OPEN_CONVERSATION,
  onlyIfIntroduced: true,
  notAfterAppointment: true,
  templateKey,
  priority,
  ...extra,
});

const appointmentPing = (key: string, name: string, minutesBefore: number, priority: number): BuiltIn => ({
  builtInKey: key,
  name,
  description: `Sent ${hours(minutesBefore)} before the appointment if the lab still has not confirmed.`,
  triggerCondition: { statusIn: AWAITING_STATUSES, minutesBeforeAppointment: minutesBefore },
  conversationStatusIn: OPEN_CONVERSATION,
  onlyIfIntroduced: true,
  notAfterAppointment: true,
  templateKey: "NON_API_APPOINTMENT_REMINDER",
  priority,
});

export const BUILT_IN_RULES: BuiltIn[] = [
  // ── What labs already get ────────────────────────────────────────────────
  {
    builtInKey: "NEW_ORDER",
    name: "New order",
    description: "As soon as an order is placed: the order details and the LabStack confirmation link. Only orders placed after the lab was configured.",
    triggerCondition: { statusIn: [], minutesSinceCreated: 0 },
    introduces: true,
    onlyIfIntroduced: false,
    onlyNewSinceLabConfigured: true,
    notAfterAppointment: true,
    // Orders noticed late (an outage) still reach the lab the same day.
    catchUpMinutes: 1440,
    templateKey: "NON_API_NEW_ORDER",
    priority: 0,
  },
  reminder("REMINDER_1H", "Reminder — 1 hour after the order", 60, "NON_API_REMINDER", 4),
  reminder("REMINDER_3H", "Reminder — 3 hours after the order", 180, "NON_API_URGENT_REMINDER", 3),
  reminder("ESCALATION_5H", "Final reminder — 5 hours after the order", 300, "NON_API_ESCALATION", 1, {
    action: "ESCALATE",
    recipient: "MANAGER",
    description: "Sent 5 hours after the order if still unconfirmed, to the lab manager when one is on file. Never after the appointment.",
  }),
  appointmentPing("APPT_24H", "Unconfirmed — 24 h before the appointment", 1440, 4),
  appointmentPing("APPT_2H", "Unconfirmed — 2 h before the appointment", 120, 2),
  appointmentPing("APPT_30M", "Unconfirmed — 30 min before the appointment", 30, 1),
  appointmentPing("APPT_10M", "Unconfirmed — 10 min before the appointment", 10, 0),
  {
    builtInKey: "STATUS_CHECK",
    name: "Status check — 30 min after the appointment",
    description: "Asks what happened, with a one-tap poll. Sent whether or not the lab confirmed; skipped once LabStack shows the sample collected.",
    triggerCondition: { statusIn: NOT_COLLECTED_STATUSES, minutesAfterAppointment: 30 },
    conversationStatusIn: [...OPEN_CONVERSATION, "LAB_ACCEPTED", "LAB_RESCHEDULE_REQUESTED"],
    onlyIfIntroduced: false,
    templateKey: "NON_API_STATUS_CHECK",
    pollKey: "ORDER_STATUS_CHECK",
    factConditions: [{ kind: "sample_collected", present: false }],
    priority: 2,
  },
  {
    builtInKey: "SUMMARY_TOMORROW",
    name: "Tomorrow's orders — evening list",
    description: "Once a day: every order with an appointment tomorrow, with address, map, tests and a confirmation link for the unconfirmed ones.",
    kind: "SUMMARY",
    summaryScope: "APPOINTMENT_TOMORROW",
    summaryHour: 19,
    summaryMinute: 0,
    triggerCondition: { statusIn: [] },
    catchUpMinutes: 180,
    templateKey: "PROVIDER_DAILY_DIGEST",
    skipWhenEmpty: true,
    onlyIfIntroduced: false,
    // The evening list went to every configured lab, API ones included.
    integrationTypes: [],
  },

  // ── New communications (seeded paused) ───────────────────────────────────
  {
    builtInKey: "ASSIGN_PHLEBO",
    name: "Assign a phlebo — 2 h before the appointment",
    description: "Confirmed but no phlebo assigned 2 hours before the appointment: asks the lab to assign one and share the name and number. Repeats every 30 min, up to 3 times, until LabStack shows a phlebo or the lab replies with one.",
    isActive: false,
    triggerCondition: { statusIn: CONFIRMED_UNASSIGNED_STATUSES, minutesBeforeAppointment: 120 },
    factConditions: [{ kind: "phlebo_name", present: false }],
    onlyIfIntroduced: true,
    notAfterAppointment: true,
    templateKey: "NON_API_ASSIGN_PHLEBO",
    priority: 1,
    repeatEveryMinutes: 30,
    maxSends: 3,
  },
  {
    builtInKey: "PHLEBO_ETA",
    name: "Phlebo on time? — 1 h before the appointment",
    description: "Phlebo assigned: shares the phlebo's name and number from LabStack and asks whether they are on time, with an ETA. Stops once the lab replies with an ETA.",
    isActive: false,
    triggerCondition: { statusIn: ["PHLEBO_ASSIGNED"], minutesBeforeAppointment: 60 },
    factConditions: [{ kind: "eta", present: false }],
    onlyIfIntroduced: false,
    notAfterAppointment: true,
    templateKey: "NON_API_PHLEBO_ETA",
    priority: 2,
    repeatEveryMinutes: 20,
    maxSends: 2,
  },
  {
    builtInKey: "REPORT_CHASE",
    name: "Report chase — 12 h after the appointment",
    description: "Sample collected but no report 12 hours after the appointment: asks for the report. Repeats every 3 hours, up to 4 times, until LabStack shows it delivered or the lab says it is shared. Only between 08:00 and 20:00.",
    isActive: false,
    triggerCondition: { statusIn: REPORT_PENDING_STATUSES, minutesAfterAppointment: 720 },
    factConditions: [{ kind: "report_shared", present: false }],
    onlyIfIntroduced: false,
    templateKey: "NON_API_REPORT_CHASE",
    priority: 3,
    repeatEveryMinutes: 180,
    maxSends: 4,
    // Not urgent enough to wake a lab group: chases go out 08:00–20:00 only.
    sendWindowStartHour: 8,
    sendWindowEndHour: 20,
  },
  {
    builtInKey: "SUMMARY_PENDING_REPORTS",
    name: "Pending reports — morning list",
    description: "Once a day: every order collected more than 12 hours after its appointment with no report yet, oldest first.",
    isActive: false,
    kind: "SUMMARY",
    summaryScope: "OPEN",
    summaryHour: 10,
    summaryMinute: 0,
    triggerCondition: { statusIn: REPORT_PENDING_STATUSES, minutesAfterAppointment: 720 },
    factConditions: [{ kind: "report_shared", present: false }],
    catchUpMinutes: 180,
    templateKey: "PROVIDER_PENDING_REPORTS",
    skipWhenEmpty: true,
    onlyIfIntroduced: false,
  },
];

/** Legacy scheduled-action rung → the built-in that now sends it (ledger import). */
export const LEGACY_RUNG_TO_BUILT_IN: Record<string, string> = {
  ORDER_CONFIRMATION: "REMINDER_1H",
  ORDER_URGENT: "REMINDER_3H",
  ORDER_ESCALATION: "ESCALATION_5H",
  APPT_T_MINUS_24H: "APPT_24H",
  APPT_T_MINUS_2H: "APPT_2H",
  APPT_T_MINUS_30M: "APPT_30M",
  APPT_T_MINUS_10M: "APPT_10M",
  APPT_STATUS_CHECK: "STATUS_CHECK",
};
