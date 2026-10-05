/**
 * Message rules — the shapes the engine works with.
 *
 * A rule is a Task Rule whose action is "message the provider": the same
 * TriggerCondition, evaluated by engine/taskCreator.evaluateTrigger, against
 * the current state of every open order on every tick. See
 * DOCS/features/provider-communication/DESIGN.md.
 */
import type { ProviderMessageRule } from "@prisma/client";
import type { TriggerCondition } from "@/types";

export type MessageRulesMode = "OFF" | "SHADOW" | "LIVE";
export const MESSAGE_RULES_MODES: MessageRulesMode[] = ["OFF", "SHADOW", "LIVE"];

export type RuleAction = "SEND" | "ESCALATE";
export type RuleRecipient = "LAB" | "MANAGER";
export type TemplateSlot = "initial" | "reminder" | "escalation" | "appointment";
export type LabSettingKey = "appointmentRemindersEnabled" | "postAppointmentCheckEnabled";

export type MessageRule = {
  id: string;
  builtInKey: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  sourceKey: string;
  allowedLabIds: number[];
  excludedLabIds: number[];
  allowedOrderTypes: string[];
  triggerCondition: TriggerCondition;
  conversationStatusIn: string[];
  onlyIfIntroduced: boolean;
  notAfterAppointment: boolean;
  requiresLabSetting: LabSettingKey | null;
  action: RuleAction;
  recipient: RuleRecipient;
  templateKey: string;
  templateSlot: TemplateSlot | null;
  pollKey: string | null;
  priority: number;
  repeatEveryMinutes: number | null;
  maxSends: number;
  catchUpMinutes: number;
  sendWindowStartHour: number | null;
  sendWindowEndHour: number | null;
};

/** One open LabStack order, shaped like engine/labstack's RawOrder where evaluateTrigger reads it. */
export type RuleOrder = {
  id: number;
  labId: number;
  orderType: string;
  orderStatus: string;
  createdAt: Date;
  statusUpdatedAt: Date | null;
  appointmentTime: Date | null;
  patientName: string | null;
  metadata: Record<string, unknown>;
};

/** OpsFlow's conversation with the lab about one order (lab_communication_workflows). */
export type RuleConversation = {
  id: string;
  status: string;
  /** False for a check-only shell: the lab never got the new-order message. */
  introduced: boolean;
  lastMessageAt: Date | null;
};

/** The slice of NonApiLabConfig the engine needs. */
export type RuleLab = {
  labId: number;
  createdAt: Date;
  quietWindowMinutes: number;
  appointmentRemindersEnabled: boolean;
  postAppointmentCheckEnabled: boolean;
};

/** Ledger state for one (rule, order): how many occurrences are recorded, and when the last one was. */
export type LedgerState = { count: number; lastAt: Date | null };

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

export function toMessageRule(row: ProviderMessageRule): MessageRule {
  return {
    id: row.id,
    builtInKey: row.builtInKey,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    version: row.version,
    sourceKey: row.sourceKey,
    allowedLabIds: numbers(row.allowedLabIds),
    excludedLabIds: numbers(row.excludedLabIds),
    allowedOrderTypes: strings(row.allowedOrderTypes),
    triggerCondition: (row.triggerCondition ?? { statusIn: [] }) as unknown as TriggerCondition,
    conversationStatusIn: strings(row.conversationStatusIn),
    onlyIfIntroduced: row.onlyIfIntroduced,
    notAfterAppointment: row.notAfterAppointment,
    requiresLabSetting: (row.requiresLabSetting as LabSettingKey | null) ?? null,
    action: row.action === "ESCALATE" ? "ESCALATE" : "SEND",
    recipient: row.recipient === "MANAGER" ? "MANAGER" : "LAB",
    templateKey: row.templateKey,
    templateSlot: (row.templateSlot as TemplateSlot | null) ?? null,
    pollKey: row.pollKey,
    priority: row.priority,
    repeatEveryMinutes: row.repeatEveryMinutes,
    maxSends: Math.max(1, row.maxSends),
    catchUpMinutes: Math.max(0, row.catchUpMinutes),
    sendWindowStartHour: row.sendWindowStartHour,
    sendWindowEndHour: row.sendWindowEndHour,
  };
}
