/**
 * Input contract for message rules. The trigger condition is the Task Rule
 * schema itself, so a condition means the same thing in both places.
 */
import { z } from "zod";
import { triggerConditionSchema } from "@/lib/validation/task-rules";

const hour = z.number().int().min(0).max(23);

export const messageRuleSchema = z.object({
  name: z.string().trim().min(1, "Give the rule a name").max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().default(true),
  allowedLabIds: z.array(z.coerce.number().int().positive()).default([]),
  excludedLabIds: z.array(z.coerce.number().int().positive()).default([]),
  allowedOrderTypes: z.array(z.string().min(1)).default([]),
  triggerCondition: triggerConditionSchema,
  conversationStatusIn: z.array(z.enum([
    "WAITING_FOR_LAB_CONFIRMATION", "LAB_ACCEPTED", "LAB_RESCHEDULE_REQUESTED", "LAB_REJECTED", "ESCALATED", "COMPLETED", "CANCELLED",
  ])).default([]),
  onlyIfIntroduced: z.boolean().default(true),
  notAfterAppointment: z.boolean().default(false),
  requiresLabSetting: z.enum(["appointmentRemindersEnabled", "postAppointmentCheckEnabled"]).nullable().default(null),
  action: z.enum(["SEND", "ESCALATE"]).default("SEND"),
  recipient: z.enum(["LAB", "MANAGER"]).default("LAB"),
  templateKey: z.string().trim().min(1, "Pick a message template"),
  templateSlot: z.enum(["initial", "reminder", "escalation", "appointment"]).nullable().default(null),
  pollKey: z.string().trim().min(1).nullable().default(null),
  priority: z.number().int().min(0).max(4).default(4),
  repeatEveryMinutes: z.number().int().min(5).max(60 * 24 * 7).nullable().default(null),
  maxSends: z.number().int().min(1).max(20).default(1),
  catchUpMinutes: z.number().int().min(0).max(60 * 24).default(30),
  sendWindowStartHour: hour.nullable().default(null),
  sendWindowEndHour: hour.nullable().default(null),
}).refine((rule) => (rule.sendWindowStartHour == null) === (rule.sendWindowEndHour == null), {
  message: "Set both send-window hours, or neither", path: ["sendWindowEndHour"],
}).refine((rule) => rule.repeatEveryMinutes != null || rule.maxSends === 1, {
  message: "Repeating more than once needs a repeat interval", path: ["repeatEveryMinutes"],
});

export type MessageRuleInput = z.infer<typeof messageRuleSchema>;

/** Fields whose change alters what or when a rule sends — they bump the version. */
export const VERSIONED_FIELDS: Array<keyof MessageRuleInput> = [
  "allowedLabIds", "excludedLabIds", "allowedOrderTypes", "triggerCondition", "conversationStatusIn",
  "onlyIfIntroduced", "notAfterAppointment", "requiresLabSetting", "action", "recipient", "templateKey",
  "templateSlot", "pollKey", "priority", "repeatEveryMinutes", "maxSends", "catchUpMinutes",
  "sendWindowStartHour", "sendWindowEndHour",
];

export function flattenZodError(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) details[issue.path.join(".") || "rule"] = issue.message;
  return details;
}
