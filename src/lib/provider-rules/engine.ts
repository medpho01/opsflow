/**
 * The message-rules engine — one pass per minute, from the non-API lab tick.
 *
 *   1. read the active rules and the live labs;
 *   2. read every open order of those labs from LabStack (bounded window);
 *   3. for each order, decide each rule (evaluate.ts) against the order's
 *      CURRENT state and the ledger of what was already sent;
 *   4. record misses; send at most one message per order (LIVE) or record
 *      what would have been sent (SHADOW).
 *
 * Nothing is planned ahead, so a rule added, edited, paused or deleted applies
 * to every open order on the next pass. The ledger is what stops a message
 * going twice. See DOCS/features/provider-communication/DESIGN.md.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { hasWhatsAppTarget } from "@/lib/non-api-labs/target";
import { isNonApiTemplateKey } from "@/lib/non-api-labs/templates";
import { deliverWorkflowMessage, type ConfigRow } from "@/lib/non-api-labs/scheduler";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { isAwaitingConfirmation } from "@/lib/non-api-labs/source-check";
import { loadActiveCommunicationRules } from "@/lib/non-api-labs/rule-store";
import { loadProviderCommsSettings } from "@/lib/provider-comms/sla-config";
import { decideRule, planOrder, shellConversationStatus, triggerMoment } from "./evaluate";
import { BUILT_IN_RULES, LADDER_BUILT_IN_KEYS, LEGACY_RUNG_TO_BUILT_IN, convertLegacyRule } from "./builtins";
import {
  toMessageRule, MESSAGE_RULES_MODES,
  type LedgerState, type MessageRule, type MessageRulesMode, type RuleConversation, type RuleLab, type RuleOrder, type TemplateSlot,
} from "./types";

const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";
/** Bounded LabStack read: orders around now. Far-future orders have nothing due yet. */
const LOOKBACK_HOURS = 48;
const LOOKAHEAD_HOURS = 72;
/** Safety cap per pass; the rest go next minute. */
const MAX_SENDS_PER_PASS = 200;
const DEAD_STATUSES = ["CANCELED", "REPORT_DELIVERED", "PATIENT_MISSED"];

// ── Mode ─────────────────────────────────────────────────────────────────

export async function loadMessageRulesMode(): Promise<MessageRulesMode> {
  const settings = await loadProviderCommsSettings();
  const mode = settings.messageRulesMode as MessageRulesMode;
  return MESSAGE_RULES_MODES.includes(mode) ? mode : "SHADOW";
}

/**
 * Switch modes. Going LIVE first records what the legacy scheduler already
 * sent (so nothing goes twice) and retires its pending timed steps (so nothing
 * goes from both). Going back to SHADOW/OFF needs nothing: the legacy planner
 * plans new orders again, and the ledger keeps what was sent.
 */
export async function setMessageRulesMode(mode: MessageRulesMode): Promise<{ imported: number; retired: number }> {
  if (!MESSAGE_RULES_MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
  let imported = 0;
  let retired = 0;
  if (mode === "LIVE") {
    await ensureBuiltInRules();
    imported = await importLegacySends();
    const result = await prisma.labScheduledAction.updateMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "SUPPRESSED", cancelledAt: new Date(), completedAt: new Date(), lastError: "Replaced by message rules", lockedAt: null, lockedBy: null },
    });
    retired = result.count;
  }
  await prisma.providerCommsSettings.upsert({
    where: { id: "default" },
    update: { messageRulesMode: mode },
    create: { id: "default", messageRulesMode: mode },
  });
  return { imported, retired };
}

// ── Seeding ──────────────────────────────────────────────────────────────

/**
 * Create the built-in rules once. On that first run, active legacy sequence
 * rules are converted too, and the built-in reminders step aside for the labs
 * they covered — the legacy "a rule replaces the ladder" behaviour.
 */
export async function ensureBuiltInRules(): Promise<{ created: number; converted: number }> {
  const existing = await prisma.providerMessageRule.count({ where: { builtInKey: { not: null } } });
  if (existing > 0) return { created: 0, converted: 0 };

  const legacy = await loadActiveCommunicationRules().catch(() => []);
  const coveredLabs = new Set<number>();
  let coversAll = false;
  for (const rule of legacy) {
    if (rule.allowedLabIds.length === 0) coversAll = true;
    for (const labId of rule.allowedLabIds) coveredLabs.add(labId);
  }

  let created = 0;
  for (const builtIn of BUILT_IN_RULES) {
    const isLadder = LADDER_BUILT_IN_KEYS.includes(builtIn.builtInKey);
    try {
      await prisma.providerMessageRule.create({
        data: {
          ...builtIn,
          ...(isLadder && coversAll ? { isActive: false } : {}),
          ...(isLadder && !coversAll && coveredLabs.size > 0 ? { excludedLabIds: [...coveredLabs] } : {}),
        },
      });
      created += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
  for (const rule of legacy) {
    await prisma.providerMessageRule.create({ data: convertLegacyRule(rule) });
  }
  return { created, converted: legacy.length };
}

/** Record the legacy scheduler's sends against the built-ins that replace them. */
export async function importLegacySends(): Promise<number> {
  const builtIns = await prisma.providerMessageRule.findMany({ where: { builtInKey: { not: null } } });
  const byKey = new Map(builtIns.map((rule) => [rule.builtInKey!, rule]));
  const sent = await prisma.labCommunication.findMany({
    where: { type: { in: ["REMINDER", "ESCALATION"] }, orderId: { not: null }, labId: { not: null } },
    select: { id: true, orderId: true, labId: true, idempotencyKey: true, createdAt: true },
  });
  const rows: Prisma.ProviderMessageLedgerCreateManyInput[] = [];
  for (const communication of sent) {
    // non-api:<orderId>:<rungKey | ruleId | type>:<runAt>
    const rung = communication.idempotencyKey.split(":")[2] ?? "";
    const rule = byKey.get(LEGACY_RUNG_TO_BUILT_IN[rung] ?? "");
    if (!rule) continue;
    rows.push({
      ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER",
      entityId: communication.orderId!, labId: communication.labId!, occurrence: 1,
      outcome: "IMPORTED", shadow: false, communicationId: communication.id,
      detail: "Sent by the legacy scheduler", createdAt: communication.createdAt,
    });
  }
  if (rows.length === 0) return 0;
  const result = await prisma.providerMessageLedger.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function loadMessageRules(): Promise<MessageRule[]> {
  const rows = await prisma.providerMessageRule.findMany({ where: { isActive: true, sourceKey: "orders" } });
  return rows.map(toMessageRule);
}

async function loadLiveLabs(): Promise<Map<number, { lab: RuleLab; config: ConfigRow }>> {
  const configs = (await prisma.nonApiLabConfig.findMany({
    where: { isActive: true, integrationType: "NON_API" },
  })).filter(hasWhatsAppTarget);
  return new Map(configs.map((config) => [config.labId, {
    config,
    lab: {
      labId: config.labId,
      createdAt: config.createdAt,
      quietWindowMinutes: config.quietWindowMinutes,
      appointmentRemindersEnabled: config.appointmentRemindersEnabled,
      postAppointmentCheckEnabled: config.postAppointmentCheckEnabled,
    },
  }]));
}

type OrderRow = {
  id: number; labId: number; orderType: string; orderStatus: string;
  createdAt: Date; statusUpdatedAt: Date | null; appointmentTime: Date | null;
  patientName: string | null; metadata: Record<string, unknown> | null;
};

/** `now` is passed in rather than read from the database, so a pass is about one instant. */
export async function fetchOpenOrders(labIds: number[], now = new Date()): Promise<RuleOrder[]> {
  if (labIds.length === 0) return [];
  const rows = await labstackWorkerQuery<OrderRow>(
    `SELECT o.id, o."labId", o."orderType"::text AS "orderType", o."orderStatus"::text AS "orderStatus",
            o."createdAt", o."statusUpdatedAt", o."appointmentTime",
            u.name AS "patientName", to_jsonb(o.*) AS metadata
       FROM public."Order" o
       LEFT JOIN public."User" u ON u.id = o."userId"
      WHERE o."labId" = ANY($1::int[])
        AND o."orderStatus"::text <> ALL($2::text[])
        AND (
              (o."appointmentTime" >= $5::timestamp - make_interval(hours => $3::int)
               AND o."appointmentTime" < $5::timestamp + make_interval(hours => $4::int))
           OR o."createdAt" >= $5::timestamp - make_interval(hours => $3::int)
        )`,
    // LabStack stores naive UTC, so compare against naive UTC.
    [labIds, DEAD_STATUSES, LOOKBACK_HOURS, LOOKAHEAD_HOURS, now.toISOString().replace("T", " ").replace("Z", "")],
  );
  const date = (value: Date | null) => (value ? new Date(value) : null);
  return rows.map((row) => ({
    id: row.id,
    labId: row.labId,
    orderType: row.orderType,
    orderStatus: row.orderStatus,
    createdAt: new Date(row.createdAt),
    statusUpdatedAt: date(row.statusUpdatedAt),
    appointmentTime: date(row.appointmentTime),
    patientName: row.patientName,
    metadata: row.metadata ?? {},
  }));
}

async function loadConversations(orderIds: number[]) {
  const workflows = orderIds.length === 0 ? [] : await prisma.labCommunicationWorkflow.findMany({
    where: { orderId: { in: orderIds } },
  });
  const last = workflows.length === 0 ? [] : await prisma.labCommunication.groupBy({
    by: ["workflowId"],
    where: { workflowId: { in: workflows.map((w) => w.id) } },
    _max: { createdAt: true },
  });
  const lastByWorkflow = new Map(last.map((row) => [row.workflowId, row._max.createdAt]));
  return new Map(workflows.map((workflow) => {
    const snapshot = (workflow.orderSnapshot ?? {}) as { statusCheckOnly?: boolean };
    const conversation: RuleConversation = {
      id: workflow.id,
      status: workflow.status,
      introduced: !snapshot.statusCheckOnly,
      lastMessageAt: lastByWorkflow.get(workflow.id) ?? null,
    };
    return [workflow.orderId, { conversation, workflow }];
  }));
}

async function loadLedger(ruleIds: string[], orderIds: number[], shadow: boolean) {
  const rows = ruleIds.length === 0 || orderIds.length === 0 ? [] : await prisma.providerMessageLedger.groupBy({
    by: ["ruleId", "entityId"],
    where: { ruleId: { in: ruleIds }, entityType: "ORDER", entityId: { in: orderIds }, shadow },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  return new Map(rows.map((row) => [`${row.ruleId}:${row.entityId}`, { count: row._count._all, lastAt: row._max.createdAt } satisfies LedgerState]));
}

// ── Template resolution ──────────────────────────────────────────────────

const SLOT_FIELD: Record<TemplateSlot, { field: keyof ConfigRow; standard: string }> = {
  initial: { field: "initialTemplateKey", standard: "NON_API_NEW_ORDER" },
  reminder: { field: "reminderTemplateKey", standard: "NON_API_REMINDER" },
  escalation: { field: "escalationTemplateKey", standard: "NON_API_ESCALATION" },
  appointment: { field: "appointmentTemplateKey", standard: "NON_API_APPOINTMENT_REMINDER" },
};

/** The rule's template, unless this lab chose its own for the rule's slot in Lab Config. */
export function templateFor(rule: MessageRule, config: ConfigRow): string {
  if (rule.templateSlot) {
    const slot = SLOT_FIELD[rule.templateSlot];
    const labKey = config[slot.field] as string | null;
    if (labKey && labKey !== slot.standard && isNonApiTemplateKey(labKey)) return labKey;
  }
  return rule.templateKey;
}

// ── The pass ─────────────────────────────────────────────────────────────

export type RulesPassResult = {
  mode: MessageRulesMode;
  orders: number;
  sent: number;
  shadow: number;
  missed: number;
  skipped: number;
  confirmed: number;
  failed: number;
};

export async function runMessageRulesPass(now = new Date()): Promise<RulesPassResult> {
  const mode = await loadMessageRulesMode();
  const result: RulesPassResult = { mode, orders: 0, sent: 0, shadow: 0, missed: 0, skipped: 0, confirmed: 0, failed: 0 };
  if (mode === "OFF") return result;

  await ensureBuiltInRules();
  const [rules, labs] = await Promise.all([loadMessageRules(), loadLiveLabs()]);
  if (rules.length === 0 || labs.size === 0) return result;

  const orders = await fetchOpenOrders([...labs.keys()], now);
  result.orders = orders.length;
  if (orders.length === 0) return result;

  const shadow = mode === "SHADOW";
  const [conversations, ledger] = await Promise.all([
    loadConversations(orders.map((order) => order.id)),
    loadLedger(rules.map((rule) => rule.id), orders.map((order) => order.id), shadow),
  ]);

  // LabStack shows the order confirmed: record it on the conversation, so the
  // timeline and the board say so (the legacy scheduler did this lazily).
  if (!shadow) {
    for (const order of orders) {
      const entry = conversations.get(order.id);
      if (!entry || isAwaitingConfirmation(order.orderStatus)) continue;
      if (entry.conversation.status !== "WAITING_FOR_LAB_CONFIRMATION" && entry.conversation.status !== "ESCALATED") continue;
      const moved = await prisma.labCommunicationWorkflow.updateMany({
        where: { id: entry.conversation.id, status: { in: ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED"] } },
        data: { status: "LAB_ACCEPTED", acceptedAt: now },
      });
      if (moved.count > 0) {
        await prisma.labCommunicationOrderEvent.create({
          data: {
            workflowId: entry.conversation.id, type: "LAB_ACCEPTED", actorType: "LAB",
            payload: { source: "LABSTACK", orderStatus: order.orderStatus },
          },
        });
        entry.conversation.status = "LAB_ACCEPTED";
        result.confirmed += 1;
      }
    }
  }

  const timeZone = TIME_ZONE();
  for (const order of orders) {
    const live = labs.get(order.labId);
    const entry = conversations.get(order.id);
    const plan = planOrder(rules, order, {
      lab: live?.lab,
      conversation: entry?.conversation,
      now,
      timeZone,
      ledgerFor: (ruleId) => ledger.get(`${ruleId}:${order.id}`) ?? { count: 0, lastAt: null },
    });

    for (const { rule, decision } of plan.misses) {
      await writeLedger(rule, order, decision.occurrence, shadow ? "SHADOW_MISSED" : "MISSED", shadow, decision.reason);
      result.missed += 1;
    }
    if (!plan.send || !live) continue;
    if (result.sent + result.shadow >= MAX_SENDS_PER_PASS) continue;

    const { rule, decision } = plan.send;
    if (shadow) {
      await writeLedger(rule, order, decision.occurrence, "SHADOW", true, `would send ${templateFor(rule, live.config)}`);
      result.shadow += 1;
      continue;
    }
    try {
      const outcome = await sendRuleMessage(rule, order, decision.occurrence, decision.needsShell, live.config, now);
      if (outcome === "sent") result.sent += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`[MessageRules] rule ${rule.name} on order ${order.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

async function writeLedger(rule: MessageRule, order: RuleOrder, occurrence: number, outcome: string, shadow: boolean, detail: string, communicationId?: string) {
  try {
    await prisma.providerMessageLedger.create({
      data: {
        ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER", entityId: order.id, labId: order.labId,
        occurrence, outcome, shadow, detail, communicationId: communicationId ?? null,
      },
    });
  } catch (error) {
    // Another pass recorded it first — exactly what the unique key is for.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
}

/** A conversation for an order placed before its lab was configured (status-check style rules). */
async function createShellConversation(order: RuleOrder, now: Date) {
  const details = await fetchOrderContactDetails([order.id]).catch(() => null);
  const contact = details?.get(order.id) ?? null;
  try {
    return await prisma.labCommunicationWorkflow.create({
      data: {
        orderId: order.id,
        labId: order.labId,
        status: shellConversationStatus(order.orderStatus),
        sourceOrderStatus: order.orderStatus,
        appointmentTime: order.appointmentTime,
        orderSnapshot: {
          orderId: order.id, labId: order.labId, patientName: order.patientName,
          appointmentTime: order.appointmentTime?.toISOString() ?? null,
          tests: contact?.tests ?? null, patientMobile: contact?.patientMobile ?? null,
          patientAddress: contact?.address ?? null, mapUrl: contact?.mapUrl ?? null,
          statusCheckOnly: true,
        },
        confirmationDeadline: now, reminderDeadline: now, escalationDeadline: now,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.labCommunicationWorkflow.findUniqueOrThrow({ where: { orderId: order.id } });
    }
    throw error;
  }
}

async function sendRuleMessage(
  rule: MessageRule, order: RuleOrder, occurrence: number, needsShell: boolean, config: ConfigRow, now: Date,
): Promise<"sent" | "skipped"> {
  let workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: order.id } });
  if (!workflow) {
    if (!needsShell) return "skipped";
    workflow = await createShellConversation(order, now);
  }
  // The conversation should know the appointment as LabStack has it now.
  if (order.appointmentTime && workflow.appointmentTime?.getTime() !== order.appointmentTime.getTime()) {
    workflow = await prisma.labCommunicationWorkflow.update({ where: { id: workflow.id }, data: { appointmentTime: order.appointmentTime } });
  }

  const outcome = await deliverWorkflowMessage({
    workflow,
    config,
    now,
    templateKey: templateFor(rule, config),
    isEscalation: rule.action === "ESCALATE",
    wantsManager: rule.recipient === "MANAGER",
    pollKey: rule.pollKey,
    ruleId: rule.id,
    ruleName: rule.name,
    escalationLevel: rule.priority,
    idempotencyKey: `rules:${rule.id}:${order.id}:${occurrence}`,
    eventPayload: { messageRuleId: rule.id, builtInKey: rule.builtInKey, occurrence, ruleVersion: rule.version },
    // The ledger row commits with the message: either both exist or neither,
    // so a crash between them can never cause a second send.
    inTransaction: async (tx, communicationId) => {
      await tx.providerMessageLedger.create({
        data: {
          ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER", entityId: order.id, labId: order.labId,
          occurrence, outcome: "SENT", shadow: false, communicationId, detail: null,
        },
      });
    },
  });
  if ("suppressed" in outcome) {
    await writeLedger(rule, order, occurrence, "SKIPPED", false, outcome.suppressed);
    return "skipped";
  }
  return "sent";
}

/**
 * Dry run of one rule against the open orders now, for the editor: how many
 * orders it matches, and what it would do with them.
 *   sendNow  — would go out on the next pass
 *   tooLate  — its moment passed longer ago than the catch-up window
 *   later    — the order is in scope and its moment is still ahead
 *   done     — already sent as many times as the rule allows
 */
export async function previewRule(rule: MessageRule, now = new Date()) {
  const labs = await loadLiveLabs();
  const orders = await fetchOpenOrders([...labs.keys()], now);
  const conversations = await loadConversations(orders.map((order) => order.id));
  const ledger = rule.id ? await loadLedger([rule.id], orders.map((order) => order.id), false) : new Map<string, LedgerState>();
  const counts = { checked: orders.length, sendNow: 0, tooLate: 0, later: 0, done: 0 };
  for (const order of orders) {
    const decision = decideRule({ ...rule, isActive: true }, order, {
      lab: labs.get(order.labId)?.lab,
      conversation: conversations.get(order.id)?.conversation,
      ledger: ledger.get(`${rule.id}:${order.id}`) ?? { count: 0, lastAt: null },
      now,
      timeZone: TIME_ZONE(),
    });
    if (decision.kind === "SEND") counts.sendNow += 1;
    else if (decision.kind === "MISS") counts.tooLate += 1;
    else if (decision.kind === "WAIT") counts.later += 1;
    else if (decision.reason === "all sends done") counts.done += 1;
    else if (
      labs.has(order.labId)
      && rule.triggerCondition.statusIn?.includes(order.orderStatus)
      && triggerMoment(rule.triggerCondition, order).getTime() > now.getTime()
    ) counts.later += 1;
  }
  return counts;
}
