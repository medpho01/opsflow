/**
 * Message rules — the shapes the engine works with.
 *
 * A rule is a Task Rule whose action is "message the provider": the same
 * TriggerCondition (plus statusNotIn), evaluated against the current state of
 * every open order on every tick. Every lab communication is a rule: the
 * new-order message, reminders, appointment and phlebo checks, the status
 * check, report chasing, deadline-style chasers, and the daily summaries.
 * See DOCS/features/provider-communication/DESIGN.md.
 */
import type { ProviderMessageRule } from "@prisma/client";
import type { TriggerCondition } from "@/types";

export type RuleKind = "ORDER" | "SUMMARY";
export type RuleAction = "SEND" | "ESCALATE";
export type RuleRecipient = "LAB" | "MANAGER";
export type SummaryScope = "APPOINTMENT_TOMORROW" | "APPOINTMENT_TODAY" | "OPEN";
export type IntegrationType = "NON_API" | "API";

/** The Task Rule condition, plus the statuses that must NOT match. */
export type RuleCondition = TriggerCondition & { statusNotIn?: string[] };

/** "Only while the lab has (not) told us X" — X is a reply fact kind. */
export type FactCondition = { kind: string; present: boolean };

export const FACT_KINDS = [
  "eta", "phlebo_name", "phlebo_phone", "delay_reason", "sample_collected",
  "patient_unavailable", "new_appointment_time", "report_shared", "cannot_fulfil", "note",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export type MessageRule = {
  id: string;
  builtInKey: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  kind: RuleKind;
  allowedLabIds: number[];
  excludedLabIds: number[];
  allowedOrderTypes: string[];
  integrationTypes: IntegrationType[];
  triggerCondition: RuleCondition;
  conversationStatusIn: string[];
  factConditions: FactCondition[];
  introduces: boolean;
  onlyIfIntroduced: boolean;
  onlyNewSinceLabConfigured: boolean;
  notAfterAppointment: boolean;
  stopOnAnswer: boolean;
  action: RuleAction;
  recipient: RuleRecipient;
  templateKey: string;
  pollKey: string | null;
  priority: number;
  repeatEveryMinutes: number | null;
  maxSends: number;
  catchUpMinutes: number;
  sendWindowStartHour: number | null;
  sendWindowEndHour: number | null;
  milestoneLabel: string | null;
  summaryHour: number | null;
  summaryMinute: number | null;
  summaryScope: SummaryScope | null;
  skipWhenEmpty: boolean;
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
  phleboName: string | null;
  phleboNumber: string | null;
  metadata: Record<string, unknown>;
};

/** OpsFlow's conversation with the lab about one order (lab_communication_workflows). */
export type RuleConversation = {
  id: string;
  status: string;
  /** The lab got the new-order message for this order. */
  introduced: boolean;
  lastMessageAt: Date | null;
};

/** The slice of NonApiLabConfig the engine needs. */
export type RuleLab = {
  labId: number;
  labName: string;
  integrationType: IntegrationType;
  createdAt: Date;
  quietWindowMinutes: number;
};

/** Ledger state for one (rule, order): occurrences recorded, the last one's time, and whether the lab answered. */
export type LedgerState = { count: number; lastAt: Date | null; answered: boolean };
export const EMPTY_LEDGER: LedgerState = { count: 0, lastAt: null, answered: false };

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
const facts = (value: unknown): FactCondition[] =>
  Array.isArray(value)
    ? value.filter((item): item is FactCondition =>
      !!item && typeof (item as FactCondition).kind === "string" && typeof (item as FactCondition).present === "boolean")
    : [];

export function toMessageRule(row: ProviderMessageRule): MessageRule {
  return {
    id: row.id,
    builtInKey: row.builtInKey,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    version: row.version,
    kind: row.kind === "SUMMARY" ? "SUMMARY" : "ORDER",
    allowedLabIds: numbers(row.allowedLabIds),
    excludedLabIds: numbers(row.excludedLabIds),
    allowedOrderTypes: strings(row.allowedOrderTypes),
    integrationTypes: strings(row.integrationTypes).filter((t): t is IntegrationType => t === "NON_API" || t === "API"),
    triggerCondition: (row.triggerCondition ?? { statusIn: [] }) as unknown as RuleCondition,
    conversationStatusIn: strings(row.conversationStatusIn),
    factConditions: facts(row.factConditions),
    introduces: row.introduces,
    onlyIfIntroduced: row.onlyIfIntroduced,
    onlyNewSinceLabConfigured: row.onlyNewSinceLabConfigured,
    notAfterAppointment: row.notAfterAppointment,
    stopOnAnswer: row.stopOnAnswer,
    action: row.action === "ESCALATE" ? "ESCALATE" : "SEND",
    recipient: row.recipient === "MANAGER" ? "MANAGER" : "LAB",
    templateKey: row.templateKey,
    pollKey: row.pollKey,
    priority: row.priority,
    repeatEveryMinutes: row.repeatEveryMinutes,
    maxSends: Math.max(1, row.maxSends),
    catchUpMinutes: Math.max(0, row.catchUpMinutes),
    sendWindowStartHour: row.sendWindowStartHour,
    sendWindowEndHour: row.sendWindowEndHour,
    milestoneLabel: row.milestoneLabel,
    summaryHour: row.summaryHour,
    summaryMinute: row.summaryMinute,
    summaryScope: (row.summaryScope as SummaryScope | null) ?? null,
    skipWhenEmpty: row.skipWhenEmpty,
  };
}
