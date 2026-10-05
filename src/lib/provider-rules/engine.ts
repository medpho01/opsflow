/**
 * The message-rules engine — the only thing that messages labs. One pass per
 * minute, from the non-API lab tick:
 *
 *   1. read the active rules and the configured labs;
 *   2. read the open orders of those labs from LabStack (bounded window);
 *   3. ORDER rules: for each order, decide each rule (evaluate.ts) against the
 *      order's CURRENT state, the ledger of what was already sent, and what
 *      the lab has told us (reply facts); send at most one message per order;
 *   4. SUMMARY rules: for each lab whose slot is open, send the day's list.
 *
 * Nothing is planned ahead, so a rule added, edited, paused or deleted applies
 * to every open order on the next pass. Every write takes `now`, so the local
 * harness can run the engine through simulated time.
 */
import type { NonApiLabConfig } from "@prisma/client";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { hasWhatsAppTarget } from "@/lib/non-api-labs/target";
import { fetchOrderContactDetails } from "@/lib/non-api-labs/order-details";
import { isAwaitingConfirmation } from "@/lib/non-api-labs/source-check";
import { decideRule, inScope, planOrder, summaryDue, summaryMatches, summaryOccurrence, triggerMoment, conditionMatches } from "./evaluate";
import { deliverOrderMessage, deliverSummary, type FactValues } from "./deliver";
import { buildEntries, summaryVariables } from "./summary";
import { ensureMigratedToRules } from "./migrate";
import { TIME_ZONE } from "./format";
import {
  EMPTY_LEDGER, toMessageRule,
  type IntegrationType, type LedgerState, type MessageRule, type RuleConversation, type RuleLab, type RuleOrder,
} from "./types";

/** Bounded LabStack read: orders around now. */
const LOOKBACK_HOURS = 48;
const LOOKAHEAD_HOURS = 72;
/** Reports can stay pending for days; collected orders are read further back. */
const REPORT_LOOKBACK_DAYS = 10;
/** Safety cap per pass; the rest go next minute. */
const MAX_SENDS_PER_PASS = 200;
const DEAD_STATUSES = ["CANCELED", "REPORT_DELIVERED", "PATIENT_MISSED"];
const POST_COLLECTION = ["PATIENT_VISITED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "SAMPLE_PROCESSED"];

type Facts = { kinds: Set<string>; values: FactValues };
const NO_FACTS: Facts = { kinds: new Set<string>(), values: {} };

// ── Reads ────────────────────────────────────────────────────────────────

export async function loadActiveRules(): Promise<MessageRule[]> {
  const rows = await prisma.providerMessageRule.findMany({ where: { isActive: true, sourceKey: "orders" } });
  return rows.map(toMessageRule);
}

export type LiveLab = { lab: RuleLab; config: NonApiLabConfig };

export async function loadLiveLabs(): Promise<Map<number, LiveLab>> {
  const configs = (await prisma.nonApiLabConfig.findMany({ where: { isActive: true } })).filter(hasWhatsAppTarget);
  const map = new Map<number, LiveLab>();
  for (const config of configs) {
    map.set(config.labId, {
      config,
      lab: {
        labId: config.labId,
        labName: config.labName,
        integrationType: config.integrationType as IntegrationType,
        createdAt: config.createdAt,
        quietWindowMinutes: config.quietWindowMinutes,
      },
    });
  }
  return map;
}

type OrderRow = {
  id: number; labId: number; orderType: string; orderStatus: string;
  createdAt: Date; statusUpdatedAt: Date | null; appointmentTime: Date | null;
  patientName: string | null; phleboName: string | null; phleboNumber: string | null;
  metadata: Record<string, unknown> | null;
};

/** `now` is passed in rather than read from the database, so a pass is about one instant. */
export async function fetchOpenOrders(labIds: number[], now = new Date()): Promise<RuleOrder[]> {
  if (labIds.length === 0) return [];
  const rows = await labstackWorkerQuery<OrderRow>(
    `SELECT o.id, o."labId", o."orderType"::text AS "orderType", o."orderStatus"::text AS "orderStatus",
            o."createdAt", o."statusUpdatedAt", o."appointmentTime",
            u.name AS "patientName",
            NULLIF(btrim(o."phleboName"), '') AS "phleboName",
            NULLIF(btrim(o."phleboNumber"), '') AS "phleboNumber",
            to_jsonb(o.*) AS metadata
       FROM public."Order" o
       LEFT JOIN public."User" u ON u.id = o."userId"
      WHERE o."labId" = ANY($1::int[])
        AND o."orderStatus"::text <> ALL($2::text[])
        AND (
              (o."appointmentTime" >= $5::timestamp - make_interval(hours => $3::int)
               AND o."appointmentTime" < $5::timestamp + make_interval(hours => $4::int))
           OR o."createdAt" >= $5::timestamp - make_interval(hours => $3::int)
           OR (o."orderStatus"::text = ANY($6::text[])
               AND o."appointmentTime" >= $5::timestamp - make_interval(days => $7::int))
        )`,
    // LabStack stores naive UTC, so compare against naive UTC.
    [labIds, DEAD_STATUSES, LOOKBACK_HOURS, LOOKAHEAD_HOURS,
      now.toISOString().replace("T", " ").replace("Z", ""), POST_COLLECTION, REPORT_LOOKBACK_DAYS],
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
    phleboName: row.phleboName,
    phleboNumber: row.phleboNumber,
    metadata: row.metadata ?? {},
  }));
}

export async function loadConversations(orderIds: number[]): Promise<Map<number, RuleConversation>> {
  const workflows = orderIds.length === 0 ? [] : await prisma.labCommunicationWorkflow.findMany({ where: { orderId: { in: orderIds } } });
  const last = workflows.length === 0 ? [] : await prisma.labCommunication.groupBy({
    by: ["workflowId"],
    where: { workflowId: { in: workflows.map((w) => w.id) } },
    _max: { createdAt: true },
  });
  const lastByWorkflow = new Map(last.map((row) => [row.workflowId, row._max.createdAt]));
  const map = new Map<number, RuleConversation>();
  for (const workflow of workflows) {
    const snapshot = (workflow.orderSnapshot ?? {}) as { statusCheckOnly?: boolean };
    map.set(workflow.orderId, {
      id: workflow.id,
      status: workflow.status,
      introduced: !snapshot.statusCheckOnly,
      lastMessageAt: lastByWorkflow.get(workflow.id) ?? null,
    });
  }
  return map;
}

/** Ledger per (rule, order): sends counted from occurrence 1; occurrence 0 = the lab answered. */
export async function loadLedger(ruleIds: string[], orderIds: number[]): Promise<Map<string, LedgerState>> {
  const rows = ruleIds.length === 0 || orderIds.length === 0 ? [] : await prisma.providerMessageLedger.findMany({
    where: { ruleId: { in: ruleIds }, entityType: "ORDER", entityId: { in: orderIds }, shadow: false },
    select: { ruleId: true, entityId: true, occurrence: true, createdAt: true },
  });
  const map = new Map<string, LedgerState>();
  for (const row of rows) {
    const key = `${row.ruleId}:${row.entityId}`;
    const state: LedgerState = map.get(key) ?? { count: 0, lastAt: null, answered: false };
    if (row.occurrence === 0) state.answered = true;
    else {
      state.count += 1;
      if (!state.lastAt || row.createdAt > state.lastAt) state.lastAt = row.createdAt;
    }
    map.set(key, state);
  }
  return map;
}

/** What each lab told us about each order (reply understanding): kinds present and latest values. */
export async function loadFacts(orderIds: number[]): Promise<Map<number, Facts>> {
  const rows = orderIds.length === 0 ? [] : await prisma.providerOrderFact.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { createdAt: "asc" },
    select: { orderId: true, kind: true, value: true },
  });
  const map = new Map<number, Facts>();
  for (const row of rows) {
    const entry = map.get(row.orderId) ?? { kinds: new Set<string>(), values: {} };
    entry.kinds.add(row.kind);
    entry.values[row.kind] = row.value;
    map.set(row.orderId, entry);
  }
  return map;
}

// ── The pass ─────────────────────────────────────────────────────────────

export type RulesPassResult = { orders: number; sent: number; summaries: number; missed: number; skipped: number; confirmed: number; failed: number };

export async function runMessageRulesPass(now = new Date()): Promise<RulesPassResult> {
  const result: RulesPassResult = { orders: 0, sent: 0, summaries: 0, missed: 0, skipped: 0, confirmed: 0, failed: 0 };
  await ensureMigratedToRules();
  const [rules, labs] = await Promise.all([loadActiveRules(), loadLiveLabs()]);
  if (rules.length === 0 || labs.size === 0) return result;

  const orders = await fetchOpenOrders([...labs.keys()], now);
  result.orders = orders.length;
  const orderIds = orders.map((order) => order.id);
  const [conversations, ledger, facts] = await Promise.all([
    loadConversations(orderIds),
    loadLedger(rules.map((rule) => rule.id), orderIds),
    loadFacts(orderIds),
  ]);

  await recordConfirmations(orders, conversations, now, result);

  const timeZone = TIME_ZONE();
  const orderRules = rules.filter((rule) => rule.kind === "ORDER");
  const sends: Array<{ order: RuleOrder; rule: MessageRule; occurrence: number; moment: Date }> = [];
  for (const order of orders) {
    const live = labs.get(order.labId);
    const plan = planOrder(orderRules, order, {
      lab: live?.lab,
      conversation: conversations.get(order.id),
      facts: (facts.get(order.id) ?? NO_FACTS).kinds,
      now,
      timeZone,
      ledgerFor: (ruleId) => ledger.get(`${ruleId}:${order.id}`) ?? EMPTY_LEDGER,
    });
    for (const { rule, decision } of plan.misses) {
      await writeLedger(rule, "ORDER", order.id, order.labId, decision.occurrence, "MISSED", decision.reason, now);
      result.missed += 1;
    }
    if (plan.send && live && sends.length < MAX_SENDS_PER_PASS) {
      sends.push({ order, rule: plan.send.rule, occurrence: plan.send.decision.occurrence, moment: plan.send.decision.moment });
    }
  }

  if (sends.length > 0) {
    const details = await fetchOrderContactDetails(sends.map((s) => s.order.id)).catch(() => null);
    for (const send of sends) {
      try {
        const outcome = await deliverOrderMessage({
          ...send,
          config: labs.get(send.order.labId)!.config,
          contact: details?.get(send.order.id) ?? null,
          facts: (facts.get(send.order.id) ?? NO_FACTS).values,
          now,
        });
        if (outcome.sent) result.sent += 1;
        else {
          await writeLedger(send.rule, "ORDER", send.order.id, send.order.labId, send.occurrence, "SKIPPED", outcome.reason, now);
          result.skipped += 1;
        }
      } catch (error) {
        result.failed += 1;
        console.error(`[MessageRules] "${send.rule.name}" on order ${send.order.id} failed:`, error instanceof Error ? error.message : error);
      }
    }
  }

  result.summaries = await runSummaries(rules.filter((rule) => rule.kind === "SUMMARY"), labs, orders, facts, now, result);
  return result;
}

/** LabStack shows the order past PENDING/CREATED: the lab confirmed. Say so on the conversation. */
async function recordConfirmations(orders: RuleOrder[], conversations: Map<number, RuleConversation>, now: Date, result: RulesPassResult) {
  for (const order of orders) {
    const conversation = conversations.get(order.id);
    if (!conversation || isAwaitingConfirmation(order.orderStatus)) continue;
    if (conversation.status !== "WAITING_FOR_LAB_CONFIRMATION" && conversation.status !== "ESCALATED") continue;
    const moved = await prisma.labCommunicationWorkflow.updateMany({
      where: { id: conversation.id, status: { in: ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED"] } },
      data: { status: "LAB_ACCEPTED", acceptedAt: now },
    });
    if (moved.count > 0) {
      await prisma.labCommunicationOrderEvent.create({
        data: { workflowId: conversation.id, type: "LAB_ACCEPTED", actorType: "LAB", payload: { source: "LABSTACK", orderStatus: order.orderStatus }, occurredAt: now },
      });
      conversation.status = "LAB_ACCEPTED";
      result.confirmed += 1;
    }
  }
}

async function runSummaries(
  rules: MessageRule[], labs: Map<number, LiveLab>, orders: RuleOrder[], facts: Map<number, Facts>, now: Date, result: RulesPassResult,
): Promise<number> {
  if (rules.length === 0) return 0;
  const timeZone = TIME_ZONE();
  const occurrence = summaryOccurrence(now, timeZone);
  const sent = await prisma.providerMessageLedger.findMany({
    where: { ruleId: { in: rules.map((r) => r.id) }, entityType: "LAB_SUMMARY", occurrence },
    select: { ruleId: true, entityId: true },
  });
  const done = new Set(sent.map((row) => `${row.ruleId}:${row.entityId}`));
  let count = 0;
  for (const rule of rules) {
    for (const { lab, config } of labs.values()) {
      if (inScope(rule, lab.labId, lab)) continue;
      if (!summaryDue(rule, now, timeZone, done.has(`${rule.id}:${lab.labId}`))) continue;
      try {
        const outcome = await sendSummary(rule, config, orders.filter((o) => o.labId === lab.labId), facts, now, occurrence);
        if (outcome === "sent") count += 1;
        else await writeLedger(rule, "LAB_SUMMARY", lab.labId, lab.labId, occurrence, "SKIPPED", outcome, now);
      } catch (error) {
        result.failed += 1;
        console.error(`[MessageRules] summary "${rule.name}" for lab ${lab.labId} failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return count;
}

async function summaryText(rule: MessageRule, config: NonApiLabConfig, labOrders: RuleOrder[], facts: Map<number, Facts>, now: Date) {
  const timeZone = TIME_ZONE();
  const matched = labOrders.filter((order) => summaryMatches(rule, order, (facts.get(order.id) ?? NO_FACTS).kinds, now, timeZone));
  const details = matched.length ? await fetchOrderContactDetails(matched.map((o) => o.id)).catch(() => null) : null;
  const entries = await buildEntries(matched, details);
  return { matched, variables: summaryVariables(config.labName, rule, entries, now, timeZone) };
}

async function sendSummary(rule: MessageRule, config: NonApiLabConfig, labOrders: RuleOrder[], facts: Map<number, Facts>, now: Date, occurrence: number): Promise<"sent" | string> {
  const { matched, variables } = await summaryText(rule, config, labOrders, facts, now);
  if (matched.length === 0 && rule.skipWhenEmpty) return "nothing to list";
  const outcome = await deliverSummary({ rule, config, variables, occurrence, now });
  return outcome.sent ? "sent" : outcome.reason;
}

async function writeLedger(rule: MessageRule, entityType: string, entityId: number, labId: number, occurrence: number, outcome: string, detail: string, now: Date) {
  // Already recorded (another pass, or the lab answered twice) is fine — that is what the unique key is for.
  await prisma.providerMessageLedger.createMany({
    data: [{ ruleId: rule.id, ruleVersion: rule.version, entityType, entityId, labId, occurrence, outcome, shadow: false, detail, createdAt: now }],
    skipDuplicates: true,
  });
}

/** Stop a rule's repeats for an order: the lab answered. */
export async function recordAnswered(ruleId: string, orderId: number, labId: number, detail: string, now = new Date()) {
  const rule = await prisma.providerMessageRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;
  await writeLedger(toMessageRule(rule), "ORDER", orderId, labId, 0, "ANSWERED", detail, now);
}

// ── For the pages ────────────────────────────────────────────────────────

/**
 * Dry run of one rule against the open orders now. ORDER rules: how many
 * orders it would message on the next pass, later, never (too late), or
 * already has. SUMMARY rules: how many labs and orders the list would cover.
 */
export async function previewRule(rule: MessageRule, now = new Date()) {
  const labs = await loadLiveLabs();
  const orders = await fetchOpenOrders([...labs.keys()], now);
  const ids = orders.map((o) => o.id);
  const [conversations, ledger, facts] = await Promise.all([
    loadConversations(ids),
    rule.id ? loadLedger([rule.id], ids) : Promise.resolve(new Map<string, LedgerState>()),
    loadFacts(ids),
  ]);
  const counts = { checked: orders.length, sendNow: 0, tooLate: 0, later: 0, done: 0, summaryLabs: 0, summaryOrders: 0 };
  const timeZone = TIME_ZONE();
  if (rule.kind === "SUMMARY") {
    for (const { lab } of labs.values()) {
      if (inScope({ ...rule, isActive: true }, lab.labId, lab)) continue;
      counts.summaryLabs += 1;
      counts.summaryOrders += orders.filter((o) => o.labId === lab.labId && summaryMatches(rule, o, (facts.get(o.id) ?? NO_FACTS).kinds, now, timeZone)).length;
    }
    return counts;
  }
  const untimed = { ...rule.triggerCondition, minutesSinceCreated: undefined, minutesSinceStatusUpdated: undefined, minutesAfterAppointment: undefined, minutesBeforeAppointment: undefined };
  for (const order of orders) {
    const decision = decideRule({ ...rule, isActive: true }, order, {
      lab: labs.get(order.labId)?.lab,
      conversation: conversations.get(order.id),
      ledger: ledger.get(`${rule.id}:${order.id}`) ?? EMPTY_LEDGER,
      facts: (facts.get(order.id) ?? NO_FACTS).kinds,
      now,
      timeZone,
    });
    if (decision.kind === "SEND") counts.sendNow += 1;
    else if (decision.kind === "MISS") counts.tooLate += 1;
    else if (decision.kind === "WAIT") counts.later += 1;
    else if (decision.reason === "all sends done") counts.done += 1;
    else if (labs.has(order.labId) && conditionMatches(untimed, order, now).matches && triggerMoment(rule.triggerCondition, order).getTime() > now.getTime()) {
      counts.later += 1;
    }
  }
  return counts;
}

/** The summary a lab would get from a rule right now — to preview, or to send immediately. */
export async function summaryForLab(ruleId: string, labId: number, options: { send?: boolean } = {}, now = new Date()) {
  const row = await prisma.providerMessageRule.findUnique({ where: { id: ruleId } });
  if (!row || row.kind !== "SUMMARY") throw new Error("Not a summary rule");
  const rule = toMessageRule(row);
  const live = (await loadLiveLabs()).get(labId);
  if (!live) throw new Error("This lab is not configured, active and reachable");
  const orders = await fetchOpenOrders([labId], now);
  const facts = await loadFacts(orders.map((o) => o.id));
  const { matched, variables } = await summaryText(rule, live.config, orders, facts, now);
  if (!options.send) {
    const preview = await deliverSummary({ rule, config: live.config, variables, occurrence: 0, now, previewOnly: true });
    return { text: preview.text ?? null, orders: matched.length, sent: false };
  }
  // A manual send is its own occurrence, so it never uses up the day's slot.
  const outcome = await deliverSummary({ rule, config: live.config, variables, occurrence: -Math.floor(now.getTime() / 1000), now });
  return { text: outcome.text ?? null, orders: matched.length, sent: outcome.sent };
}
