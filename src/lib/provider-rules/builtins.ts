/**
 * The built-in steps, as message rules.
 *
 * These reproduce what the legacy ladder (non-api-labs/ladder.ts) and the
 * status-check sweep send today — same moments, same templates, same per-lab
 * switches — so moving to the rules engine changes nothing a lab sees. They are
 * seeded once (keyed by builtInKey) and are then ordinary rules: edit a timing
 * and every open order follows it on the next tick.
 *
 * Like the legacy ladder they apply to every order type the poller starts a
 * conversation for; narrow a rule's order types to change that.
 *
 * Pure data and pure conversion; the engine does the writes.
 */
import type { Prisma } from "@prisma/client";
import type { CommunicationRule } from "@/lib/non-api-labs/rules";
import type { TriggerCondition } from "@/types";

/** LabStack statuses in which the lab has not confirmed yet. */
export const AWAITING_STATUSES = ["PENDING", "CREATED"];
/** Open and not yet collected. */
export const NOT_COLLECTED_STATUSES = ["PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED", "PHLEBO_ASSIGNED", "KIT_DISPATCHED"];
/** Every status an order can be in before it is finished. */
export const OPEN_ORDER_STATUSES = [...NOT_COLLECTED_STATUSES, "PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED"];
/** Conversation states in which chasing a confirmation still makes sense. */
export const OPEN_CONVERSATION = ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED"];

type BuiltIn = Omit<Prisma.ProviderMessageRuleCreateInput, "ledger"> & { builtInKey: string };

const reminder = (key: string, name: string, minutes: number, templateKey: string, priority: number, extra: Partial<BuiltIn> = {}): BuiltIn => ({
  builtInKey: key,
  name,
  description: `Sent ${minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} min`} after the order, while the lab has not confirmed it. Never after the appointment.`,
  triggerCondition: { statusIn: AWAITING_STATUSES, minutesSinceCreated: minutes } satisfies TriggerCondition,
  conversationStatusIn: OPEN_CONVERSATION,
  onlyIfIntroduced: true,
  notAfterAppointment: true,
  templateKey,
  templateSlot: "reminder",
  priority,
  ...extra,
});

const appointmentPing = (key: string, name: string, minutesBefore: number, priority: number): BuiltIn => ({
  builtInKey: key,
  name,
  description: `Sent ${minutesBefore >= 60 ? `${minutesBefore / 60} h` : `${minutesBefore} min`} before the appointment if the lab still has not confirmed. Only for labs with appointment reminders on.`,
  triggerCondition: { statusIn: AWAITING_STATUSES, minutesBeforeAppointment: minutesBefore } satisfies TriggerCondition,
  conversationStatusIn: OPEN_CONVERSATION,
  onlyIfIntroduced: true,
  notAfterAppointment: true,
  requiresLabSetting: "appointmentRemindersEnabled",
  templateKey: "NON_API_APPOINTMENT_REMINDER",
  templateSlot: "appointment",
  priority,
});

export const BUILT_IN_RULES: BuiltIn[] = [
  reminder("REMINDER_1H", "Reminder — 1 hour after the order", 60, "NON_API_REMINDER", 4),
  reminder("REMINDER_3H", "Reminder — 3 hours after the order", 180, "NON_API_URGENT_REMINDER", 3),
  reminder("ESCALATION_5H", "Final reminder — 5 hours after the order", 300, "NON_API_ESCALATION", 1, {
    action: "ESCALATE",
    recipient: "MANAGER",
    templateSlot: "escalation",
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
    triggerCondition: { statusIn: NOT_COLLECTED_STATUSES, minutesAfterAppointment: 30 } satisfies TriggerCondition,
    conversationStatusIn: [...OPEN_CONVERSATION, "LAB_ACCEPTED", "LAB_RESCHEDULE_REQUESTED"],
    onlyIfIntroduced: false,
    requiresLabSetting: "postAppointmentCheckEnabled",
    templateKey: "NON_API_STATUS_CHECK",
    pollKey: "ORDER_STATUS_CHECK",
    priority: 2,
    },
];

/** Built-ins that the legacy "rules replace the ladder" behaviour switched off. Not the status check. */
export const LADDER_BUILT_IN_KEYS = BUILT_IN_RULES.map((rule) => rule.builtInKey).filter((key) => key !== "STATUS_CHECK");

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

/**
 * An authored legacy sequence rule (ProviderCommunicationRule, RELATIVE_DELAY)
 * as a message rule. Its anchor + offset become the matching Task-Rule timing
 * field; its send-time gates carry over where they have an equivalent.
 */
export function convertLegacyRule(rule: CommunicationRule): Omit<Prisma.ProviderMessageRuleCreateInput, "ledger"> {
  const cond: TriggerCondition = {
    statusIn: rule.sendCondition.sourceStatusIn?.length ? rule.sendCondition.sourceStatusIn : OPEN_ORDER_STATUSES,
  };
  if (rule.anchor === "ORDER") cond.minutesSinceCreated = Math.max(0, rule.offsetMinutes);
  else if (rule.offsetMinutes <= 0) cond.minutesBeforeAppointment = -rule.offsetMinutes;
  else cond.minutesAfterAppointment = rule.offsetMinutes;

  return {
    name: `${rule.name} (converted)`,
    description: `Converted from the legacy rule "${rule.name}".`,
    isActive: rule.isActive,
    allowedLabIds: rule.allowedLabIds,
    allowedOrderTypes: rule.allowedOrderTypes,
    triggerCondition: cond as unknown as Prisma.InputJsonValue,
    conversationStatusIn: rule.sendCondition.workflowStatusIn?.length ? rule.sendCondition.workflowStatusIn : OPEN_CONVERSATION,
    onlyIfIntroduced: true,
    // The legacy planner never scheduled anything after the appointment.
    notAfterAppointment: true,
    requiresLabSetting: rule.anchor === "APPOINTMENT" ? "appointmentRemindersEnabled" : null,
    action: rule.action === "ESCALATE" ? "ESCALATE" : "SEND",
    recipient: rule.recipient,
    templateKey: rule.templateKey,
    priority: rule.priority,
    sendWindowStartHour: rule.sendCondition.sendWindow?.startHour ?? null,
    sendWindowEndHour: rule.sendCondition.sendWindow?.endHour ?? null,
  };
}
