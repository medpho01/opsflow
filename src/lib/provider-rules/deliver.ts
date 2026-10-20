/**
 * The one send path for message rules.
 *
 * deliverOrderMessage  — a message about one order: opens the conversation if
 *                        needed, renders the template from the order's CURRENT
 *                        LabStack data (plus what the lab told us in replies),
 *                        queues it for WhatsApp, and records it — ledger row,
 *                        message log, timeline event — in one transaction.
 * deliverSummary       — one summary message to a lab.
 *
 * Every write takes the pass's `now`, so a pass is about one instant and the
 * local test harness can drive the engine through simulated time.
 *
 * PROVIDER_MESSAGES_TRANSPORT=log also prints each message as a transcript
 * line ("Message 3 → Lab X group: …") — for local runs without a gateway.
 */
import { Prisma, type NonApiLabConfig } from "@prisma/client";
import prisma from "@/lib/db/client";
import { resolveLabTarget } from "@/lib/non-api-labs/target";
import { BATCH_FOLLOW_UP_FIRM_TEMPLATE, BATCH_FOLLOW_UP_TEMPLATE, BATCH_GENERIC_TEMPLATE, BATCH_TEMPLATE_BY_INTENT, ensureTemplate, renderLabTemplate, type TemplateVariables } from "@/lib/non-api-labs/templates";
import { confirmationUrl } from "@/lib/non-api-labs/confirmation-link";
import { contactVariables, type OrderContactDetails } from "@/lib/non-api-labs/order-details";
import { newConversationStatus } from "./evaluate";
import { TIME_ZONE, durationText, formatDate, formatDateTime, formatTime } from "./format";
import { NEW_ORDER_INTENT, currentSlot, itemLine, releaseAt } from "./batching";
import { coordinatorsFor } from "@/lib/wa/coordinators";
import type { MessageRule, RuleOrder } from "./types";

/** Latest value the lab gave for each fact kind, for this order. */
export type FactValues = Record<string, string>;

const TOKEN_GRACE_MINUTES = 120;

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken() {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function actionUrl(token: string) {
  return `${(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/provider/action/${token}`;
}

let transcriptCounter = 0;
function transcript(line: string) {
  if (process.env.PROVIDER_MESSAGES_TRANSPORT !== "log") return;
  transcriptCounter += 1;
  console.log(`[ProviderMessage] Message ${transcriptCounter} → ${line}`);
}

function destinationLabel(config: NonApiLabConfig, targetKind: string, toManager: boolean) {
  if (toManager && config.managerWhatsapp) return `${config.labName} manager (${config.managerName ?? "manager"})`;
  return `${config.labName} ${targetKind === "GROUP" ? "group" : "number"}`;
}

/** The variables every order message can use. */
export function orderVariables(
  order: RuleOrder,
  config: NonApiLabConfig,
  contact: OrderContactDetails | null,
  facts: FactValues,
  rule: MessageRule,
  occurrence: number,
  moment: Date,
  now: Date,
): TemplateVariables {
  const appointment = order.appointmentTime;
  const sinceAppointment = appointment ? (now.getTime() - appointment.getTime()) / 60_000 : 0;
  const limit = rule.repeatEveryMinutes ? rule.maxSends : 1;
  return {
    order_id: String(order.id),
    lab_name: config.labName,
    manager_name: config.managerName || "team",
    patient_name: order.patientName || "Patient",
    appointment_date: appointment ? formatDate(appointment) : "Scheduled appointment",
    appointment_time: appointment ? formatTime(appointment) : "scheduled time",
    location: contact?.area || contact?.storeName || "Location shared in LabStack",
    tests: contact?.tests || "Order details available in LabStack",
    sla_deadline: formatDateTime(moment),
    phlebo_name: order.phleboName?.trim() || facts.phlebo_name || "not assigned yet",
    phlebo_phone: order.phleboNumber?.trim() || facts.phlebo_phone || "number not shared",
    since_appointment: appointment ? durationText(sinceAppointment) : "a while",
    sla_milestone: rule.milestoneLabel || rule.name,
    sla_overdue_by: durationText((now.getTime() - moment.getTime()) / 60_000),
    sla_attempt_no: String(occurrence),
    sla_attempts_remaining: String(Math.max(0, limit - occurrence)),
    ...contactVariables(contact),
  };
}

export type DeliverOrderInput = {
  rule: MessageRule;
  order: RuleOrder;
  config: NonApiLabConfig;
  contact: OrderContactDetails | null;
  facts: FactValues;
  occurrence: number;
  moment: Date;
  now: Date;
};

export type DeliverOutcome = { sent: true; communicationId: string } | { sent: false; reason: string };

/**
 * The order's conversation: found, or opened now. Its snapshot keeps the details
 * the lab was sent, for the timeline. An introduction refreshes the snapshot.
 */
export async function ensureConversation(order: RuleOrder, rule: MessageRule, contact: OrderContactDetails | null, now: Date) {
  const snapshot = {
    orderId: order.id, labId: order.labId, patientName: order.patientName,
    appointmentTime: order.appointmentTime?.toISOString() ?? null,
    location: contact?.area ?? null, tests: contact?.tests ?? null,
    patientMobile: contact?.patientMobile ?? null, patientAddress: contact?.address ?? null, mapUrl: contact?.mapUrl ?? null,
  };
  let workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: order.id } });
  if (!workflow) {
    try {
      workflow = await prisma.labCommunicationWorkflow.create({
        data: {
          orderId: order.id, labId: order.labId,
          status: newConversationStatus(order.orderStatus),
          sourceOrderStatus: order.orderStatus,
          appointmentTime: order.appointmentTime,
          orderSnapshot: { ...snapshot, statusCheckOnly: !rule.introduces },
          confirmationDeadline: now, reminderDeadline: now, escalationDeadline: now,
          createdAt: now,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      workflow = await prisma.labCommunicationWorkflow.findUniqueOrThrow({ where: { orderId: order.id } });
    }
  } else if (rule.introduces || workflow.appointmentTime?.getTime() !== order.appointmentTime?.getTime()) {
    workflow = await prisma.labCommunicationWorkflow.update({
      where: { id: workflow.id },
      data: {
        appointmentTime: order.appointmentTime,
        ...(rule.introduces ? { orderSnapshot: { ...snapshot, statusCheckOnly: false } } : {}),
      },
    });
  }
  return workflow;
}

type ActionToken = { action: "ACCEPT" | "RESCHEDULE" | "REJECT"; token: string; tokenHash: string };
type SingleRender = { text: string; variables: TemplateVariables; tokens: ActionToken[]; tokenExpiry: Date };

/**
 * One order message from its template: the order's variables, fresh action
 * tokens, the confirm link, and the coordinator @mention. An introduction
 * (the new-order message) always opens with the mention — people answer
 * people — even when an Ops-edited body left {{coordinator}} out.
 */
async function renderSingle(body: string, item: Omit<DeliverOrderInput, "config"> & { config: NonApiLabConfig }, coordinator: string): Promise<SingleRender> {
  const { rule, order, config, contact, facts, occurrence, moment, now } = item;
  const tokenExpiry = new Date(Math.max(
    (order.appointmentTime?.getTime() ?? now.getTime()) + TOKEN_GRACE_MINUTES * 60_000,
    now.getTime() + 24 * 3_600_000,
  ));
  const tokens: ActionToken[] = await Promise.all((["ACCEPT", "RESCHEDULE", "REJECT"] as const).map(async (action) => {
    const token = bearerToken();
    return { action, token, tokenHash: await sha256(token) };
  }));
  const variables: TemplateVariables = {
    ...orderVariables(order, config, contact, facts, rule, occurrence, moment, now),
    accept_url: actionUrl(tokens[0].token),
    reschedule_url: actionUrl(tokens[1].token),
    reject_url: actionUrl(tokens[2].token),
    coordinator,
  };
  // Rendered with the link but stored without it (a fresh token per message).
  let text = renderLabTemplate(body, { ...variables, confirm_url: await confirmationUrl(order.id) });
  if (rule.introduces && !body.includes("{{coordinator}}")) text = `${coordinator} ${text}`;
  return { text, variables, tokens, tokenExpiry };
}

export async function deliverOrderMessage(input: DeliverOrderInput): Promise<DeliverOutcome> {
  const { rule, order, config, occurrence, now } = input;

  const template = await ensureTemplate(rule.templateKey);
  if (!template.isActive) return { sent: false, reason: `Message "${template.name}" is paused` };

  const toManager = rule.recipient === "MANAGER";
  const managerMissing = toManager && !config.managerWhatsapp;
  const target = await resolveLabTarget(config, toManager ? config.managerWhatsapp : null);
  const workflow = await ensureConversation(order, rule, input.contact, now);

  // A manager DM is a personal chat: nobody to @mention there.
  const mention = toManager ? { text: "Team", jids: [] as string[] } : await coordinatorMentions(config, now);
  const { text, variables, tokens, tokenExpiry } = await renderSingle(template.body, input, mention.text);
  const type = rule.introduces ? "INITIAL_NOTIFICATION" : rule.action === "ESCALATE" ? "ESCALATION" : "REMINDER";
  const conversationId = workflow.id;

  let communicationId = "";
  await prisma.$transaction(async (tx) => {
    await tx.labProviderActionToken.createMany({
      data: tokens.map((entry) => ({ workflowId: conversationId, action: entry.action, tokenHash: entry.tokenHash, expiresAt: tokenExpiry })),
    });
    const communication = await tx.labCommunication.create({
      data: {
        workflowId: conversationId, labId: order.labId, orderId: order.id, type,
        recipient: target.targetJid, templateKey: rule.templateKey, templateVariables: variables,
        ruleId: rule.id, idempotencyKey: `rules:${rule.id}:${order.id}:${occurrence}`, createdAt: now,
      },
    });
    communicationId = communication.id;
    const outbound = await tx.waOutbound.create({
      // No polls: labs answer in their own words (replies.ts reads them).
      data: {
        targetJid: target.targetJid, text, groupId: target.groupId, createdAt: now,
        ...(mention.jids.length && text.includes(mention.text) ? { mentions: mention.jids } : {}),
      },
    });
    await tx.labCommunication.update({ where: { id: communication.id }, data: { waOutboundId: outbound.id, status: "QUEUED" } });
    // The ledger row commits with the message: both or neither, so a crash
    // between them can never cause a second send.
    await tx.providerMessageLedger.create({
      data: {
        ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER", entityId: order.id, labId: order.labId,
        occurrence, outcome: "SENT", shadow: false, communicationId: communication.id, createdAt: now,
      },
    });
    if (rule.action === "ESCALATE") {
      await tx.labCommunicationWorkflow.update({ where: { id: conversationId }, data: { status: "ESCALATED" } });
      await tx.labCommunicationEscalation.upsert({
        where: { workflowId_level: { workflowId: conversationId, level: rule.priority } },
        create: {
          workflowId: conversationId, level: rule.priority, status: "NOTIFIED", recipient: target.targetJid, notifiedAt: now,
          reason: `Rule "${rule.name}" escalated; ${managerMissing ? "no manager on file, notified the lab" : toManager ? "notified the lab manager" : "notified the lab"}`,
        },
        update: { notifiedAt: now, recipient: target.targetJid, status: "NOTIFIED" },
      });
    }
    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId: conversationId,
        type: rule.introduces ? "MESSAGE_QUEUED" : rule.action === "ESCALATE" ? "ESCALATION_TRIGGERED" : "REMINDER_SENT",
        actorType: "SYSTEM",
        payload: { ruleId: rule.id, ruleName: rule.name, occurrence, communicationId: communication.id, outboundId: outbound.id, recipient: target.targetJid } as Prisma.InputJsonValue,
        occurredAt: now,
      },
    });
  });

  if (managerMissing) {
    await prisma.alert.create({
      data: {
        alertType: "ESCALATION", severity: "URGENT", channel: "IN_APP", status: "PENDING",
        entityType: "non_api_lab", entityId: config.labId,
        message: `${config.labName} has no manager WhatsApp configured — rule "${rule.name}" for order #${order.id} went to the lab instead.`,
        metadata: { ruleId: rule.id, orderId: order.id },
      },
    }).catch(() => undefined);
  }

  transcript(`${destinationLabel(config, target.kind, toManager)}: ${template.name} — order ${order.id}${occurrence > 1 ? ` (#${occurrence})` : ""}`);
  return { sent: true, communicationId };
}

export type DeliverSummaryInput = {
  rule: MessageRule;
  config: NonApiLabConfig;
  variables: TemplateVariables;
  occurrence: number;
  now: Date;
  /** Render only — write nothing. */
  previewOnly?: boolean;
};

export async function deliverSummary(input: DeliverSummaryInput): Promise<DeliverOutcome & { text?: string }> {
  const { rule, config, variables, occurrence, now } = input;
  const template = await ensureTemplate(rule.templateKey);
  if (!template.isActive) return { sent: false, reason: `Message "${template.name}" is paused` };
  const text = renderLabTemplate(template.body, variables);
  if (input.previewOnly) return { sent: false, reason: "preview", text };

  const target = await resolveLabTarget(config, rule.recipient === "MANAGER" ? config.managerWhatsapp : null);
  let communicationId = "";
  await prisma.$transaction(async (tx) => {
    const communication = await tx.labCommunication.create({
      data: {
        workflowId: null, orderId: null, labId: config.labId, type: "DAILY_DIGEST",
        recipient: target.targetJid, templateKey: rule.templateKey, templateVariables: variables,
        ruleId: rule.id, idempotencyKey: `rules:${rule.id}:lab-${config.labId}:${occurrence}`, createdAt: now,
      },
    });
    communicationId = communication.id;
    const outbound = await tx.waOutbound.create({ data: { targetJid: target.targetJid, text, groupId: target.groupId, createdAt: now } });
    await tx.labCommunication.update({ where: { id: communication.id }, data: { waOutboundId: outbound.id, status: "QUEUED" } });
    await tx.providerMessageLedger.create({
      data: {
        ruleId: rule.id, ruleVersion: rule.version, entityType: "LAB_SUMMARY", entityId: config.labId, labId: config.labId,
        occurrence, outcome: "SENT", shadow: false, communicationId: communication.id, createdAt: now,
      },
    });
  });
  transcript(`${destinationLabel(config, target.kind, false)}: ${template.name} — ${variables.order_count ?? "?"} order(s)`);
  return { sent: true, communicationId, text };
}

// ── Combined messages ────────────────────────────────────────────────────

export type BatchItemInput = {
  rule: MessageRule;
  order: RuleOrder;
  contact: OrderContactDetails | null;
  facts: FactValues;
  occurrence: number;
  moment: Date;
};

type StoredBatchItem = { n: number; orderId: number; ruleId: string; occurrence: number; communicationId: string | null; line: string };

const ordersWord = (count: number) => (count === 1 ? "order" : "orders");

async function batchLine(intent: string, n: number, item: BatchItemInput, now: Date): Promise<string> {
  const { order, contact, facts, rule, moment } = item;
  const phleboName = order.phleboName?.trim() || facts.phlebo_name;
  const phleboPhone = order.phleboNumber?.trim() || facts.phlebo_phone;
  const needsLink = intent === "UNCONFIRMED" || intent === "ESCALATION" || intent === NEW_ORDER_INTENT;
  return itemLine(intent, {
    n, orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime,
    area: contact?.area ?? null,
    phlebo: [phleboName, phleboPhone].filter(Boolean).join(" ") || null,
    confirmUrl: needsLink ? await confirmationUrl(order.id) : null,
    createdAt: order.createdAt, milestone: rule.milestoneLabel, dueAt: moment,
    mobile: contact?.patientMobile ?? null, address: contact?.address ?? null, mapUrl: contact?.mapUrl ?? null, tests: contact?.tests ?? null,
  }, now, TIME_ZONE());
}

/**
 * The lab's coordinators — named on Lab Config, else the most active lab-side
 * writer in its group — as "@<number>" tokens (the gateway turns them into real
 * mentions) and their jids. Nobody to mention: "Team".
 */
async function coordinatorMentions(config: NonApiLabConfig, now: Date): Promise<{ text: string; jids: string[] }> {
  const people = await coordinatorsFor(config, now);
  return { text: people.map((c) => `@${c.jid.split("@")[0]}`).join(" ") || "Team", jids: people.map((c) => c.jid) };
}

function batchVariables(config: NonApiLabConfig, lines: string[], title: string, coordinator: string): TemplateVariables {
  return {
    lab_name: config.labName, manager_name: config.managerName || "team", coordinator,
    count: String(lines.length), orders_word: ordersWord(lines.length),
    items: lines.join("\n"), batch_title: title,
  };
}

type FollowUp = { rootId: string; quotedWaId: string; attempt: number; items: StoredBatchItem[]; since: Date };

/**
 * Is this a follow-up? Yes when every order was in one combined message to this
 * lab, for this ask, in the last 24 h, and WhatsApp has accepted it (so it can
 * be quoted). The follow-up quotes that ORIGINAL message and keeps its numbers,
 * so "1 done" still means the same order.
 */
async function findFollowUp(labId: number, intent: string, orderIds: number[], now: Date): Promise<FollowUp | null> {
  const recent = await prisma.providerBatch.findMany({
    where: { labId, intent, shadow: false, outboundId: { not: null }, createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000), lt: now } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  for (const candidate of recent) {
    const root = candidate.followUpOf ? await prisma.providerBatch.findUnique({ where: { id: candidate.followUpOf } }) : candidate;
    if (!root?.outboundId) continue;
    const rootItems = root.items as unknown as StoredBatchItem[];
    if (!orderIds.every((id) => rootItems.some((item) => item.orderId === id))) continue;
    const outbound = await prisma.waOutbound.findUnique({ where: { id: root.outboundId }, select: { sentWaMsgId: true } });
    if (!outbound?.sentWaMsgId) return null; // not delivered yet: send a fresh message instead
    const attempt = (await prisma.providerBatch.count({ where: { followUpOf: root.id } })) + 1;
    return { rootId: root.id, quotedWaId: outbound.sentWaMsgId, attempt, items: rootItems, since: root.createdAt };
  }
  return null;
}

export type DeliverBatchInput = { config: NonApiLabConfig; intent: string; items: BatchItemInput[]; now: Date };
export type BatchOutcome =
  | { sent: true; batchId: string; communicationIds: string[] }
  | { sent: false; reason: string; /** Send the items as single messages instead (the combined template is paused). */ sendSingly?: boolean };

/**
 * One combined message about several orders of one lab. Every order still gets
 * its own message-log row, ledger row and timeline event (so repeats, "stop
 * when answered" and the order timeline work exactly as for single messages);
 * they share one WhatsApp outbound, numbered in the order listed.
 *
 * New orders (intent NEW_ORDER) are introductions: one order renders from the
 * single new-order template (Ops-editable, with its action tokens); several
 * render as "new orders (N)" with the full detail block per order. Either way
 * it is recorded as a ProviderBatch, so a numbered reply lands on the right
 * order and the message counts in the lab's day.
 */
export async function deliverBatch(input: DeliverBatchInput): Promise<BatchOutcome> {
  const { config, intent, now } = input;
  const items = [...input.items].sort((a, b) =>
    (a.order.appointmentTime?.getTime() ?? 0) - (b.order.appointmentTime?.getTime() ?? 0) || a.order.id - b.order.id);
  const introduction = intent === NEW_ORDER_INTENT;
  const loneIntroduction = introduction && items.length === 1;
  const templateKey = loneIntroduction ? items[0].rule.templateKey : BATCH_TEMPLATE_BY_INTENT[intent] ?? BATCH_GENERIC_TEMPLATE;
  const template = await ensureTemplate(templateKey);
  if (!template.isActive) return { sent: false, reason: `Message "${template.name}" is paused`, sendSingly: true };

  const toManager = intent === "ESCALATION";
  const managerMissing = toManager && !config.managerWhatsapp;
  const target = await resolveLabTarget(config, toManager ? config.managerWhatsapp : null);
  const conversations = new Map<number, string>();
  for (const item of items) conversations.set(item.order.id, (await ensureConversation(item.order, item.rule, item.contact, now)).id);
  // A manager escalation goes to a personal chat: no coordinator mention, no quoting.
  // A new order is told once: never a follow-up of an earlier message.
  const followUp = toManager || introduction ? null : await findFollowUp(config.labId, intent, items.map((i) => i.order.id), now);
  const mention = await coordinatorMentions(config, now);
  let numbers: number[];
  let lines: string[];
  let text: string;
  let single: SingleRender | null = null;
  if (loneIntroduction) {
    numbers = [1];
    lines = [await batchLine(intent, 1, items[0], now)];
    single = await renderSingle(template.body, { ...items[0], config, now }, mention.text);
    text = single.text;
  } else if (followUp) {
    const original = new Map(followUp.items.map((item) => [item.orderId, item]));
    numbers = items.map((item) => original.get(item.order.id)!.n);
    lines = items.map((item) => original.get(item.order.id)!.line);
    const followTemplate = await ensureTemplate(followUp.attempt === 1 ? BATCH_FOLLOW_UP_TEMPLATE : BATCH_FOLLOW_UP_FIRM_TEMPLATE);
    text = renderLabTemplate(followTemplate.isActive ? followTemplate.body : "{{coordinator}} still open: {{numbers}}", {
      lab_name: config.labName, coordinator: mention.text, count: String(items.length),
      numbers: [...numbers].sort((a, b) => a - b).join(", "), since: formatTime(followUp.since),
    });
  } else {
    numbers = items.map((_, index) => index + 1);
    lines = await Promise.all(items.map((item, index) => batchLine(intent, index + 1, item, now)));
    text = renderLabTemplate(template.body, batchVariables(config, lines, items[0].rule.name, mention.text));
  }
  const slotAt = currentSlot(now, TIME_ZONE());

  const stored: StoredBatchItem[] = [];
  let batchId = "";
  await prisma.$transaction(async (tx) => {
    const outbound = await tx.waOutbound.create({
      data: {
        targetJid: target.targetJid, text, groupId: target.groupId, createdAt: now,
        // Quote the original combined message, as a person would; @mention the coordinators.
        ...(followUp ? { quotedWaId: followUp.quotedWaId } : {}),
        ...(!toManager && mention.jids.length ? { mentions: mention.jids } : {}),
      },
    });
    if (single) {
      await tx.labProviderActionToken.createMany({
        data: single.tokens.map((entry) => ({ workflowId: conversations.get(items[0].order.id)!, action: entry.action, tokenHash: entry.tokenHash, expiresAt: single!.tokenExpiry })),
      });
    }
    for (const [index, item] of items.entries()) {
      const { rule, order, occurrence } = item;
      const conversationId = conversations.get(order.id)!;
      const type = rule.introduces ? "INITIAL_NOTIFICATION" : rule.action === "ESCALATE" ? "ESCALATION" : "REMINDER";
      const communication = await tx.labCommunication.create({
        data: {
          workflowId: conversationId, labId: order.labId, orderId: order.id, type, status: "QUEUED",
          recipient: target.targetJid, templateKey, batchOutboundId: outbound.id,
          templateVariables: single
            ? single.variables
            : { order_id: String(order.id), combined: intent, item: String(numbers[index]), of: String(items.length), ...(followUp ? { followUpOf: followUp.rootId } : {}) },
          ruleId: rule.id, idempotencyKey: `rules:${rule.id}:${order.id}:${occurrence}`, createdAt: now,
        },
      });
      stored.push({ n: numbers[index], orderId: order.id, ruleId: rule.id, occurrence, communicationId: communication.id, line: lines[index] });
      await tx.providerMessageLedger.create({
        data: {
          ruleId: rule.id, ruleVersion: rule.version, entityType: "ORDER", entityId: order.id, labId: order.labId,
          occurrence, outcome: "SENT", shadow: false, communicationId: communication.id, createdAt: now,
        },
      });
      if (rule.action === "ESCALATE") {
        await tx.labCommunicationWorkflow.update({ where: { id: conversationId }, data: { status: "ESCALATED" } });
        await tx.labCommunicationEscalation.upsert({
          where: { workflowId_level: { workflowId: conversationId, level: rule.priority } },
          create: {
            workflowId: conversationId, level: rule.priority, status: "NOTIFIED", recipient: target.targetJid, notifiedAt: now,
            reason: `Rule "${rule.name}" escalated in a combined message; ${managerMissing ? "no manager on file, notified the lab" : "notified the lab manager"}`,
          },
          update: { notifiedAt: now, recipient: target.targetJid, status: "NOTIFIED" },
        });
      }
      await tx.labCommunicationOrderEvent.create({
        data: {
          workflowId: conversationId,
          type: rule.introduces ? "MESSAGE_QUEUED" : rule.action === "ESCALATE" ? "ESCALATION_TRIGGERED" : "REMINDER_SENT",
          actorType: "SYSTEM",
          payload: {
            ruleId: rule.id, ruleName: rule.name, occurrence, communicationId: communication.id, outboundId: outbound.id,
            recipient: target.targetJid, combined: { intent, item: numbers[index], of: items.length, followUp: followUp?.attempt ?? 0 },
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
    }
    const batch = await tx.providerBatch.create({
      data: {
        labId: config.labId, intent, slotAt, shadow: false, outboundId: outbound.id, recipient: target.targetJid,
        followUpOf: followUp?.rootId ?? null,
        itemCount: items.length, items: stored as unknown as Prisma.InputJsonValue, text, createdAt: now,
      },
    });
    batchId = batch.id;
  });

  if (managerMissing) {
    await prisma.alert.create({
      data: {
        alertType: "ESCALATION", severity: "URGENT", channel: "IN_APP", status: "PENDING",
        entityType: "non_api_lab", entityId: config.labId,
        message: `${config.labName} has no manager WhatsApp configured — ${items.length} escalation(s) went to the lab instead.`,
        metadata: { orderIds: items.map((i) => i.order.id) },
      },
    }).catch(() => undefined);
  }
  transcript(`${destinationLabel(config, target.kind, toManager)}: ${template.name} — ${items.length} ${ordersWord(items.length)} (${items.map((i) => i.order.id).join(", ")})`);
  return { sent: true, batchId, communicationIds: stored.map((s) => s.communicationId!) };
}

/**
 * SHADOW: the lab still got a message per order; record the combined message
 * those would have made, so ops can compare before switching the lab LIVE.
 * Grouped by the slot the item would have gone out in.
 */
export async function recordShadowBatch(config: NonApiLabConfig, intent: string, item: BatchItemInput, communicationId: string, now: Date) {
  const slotAt = releaseAt(intent, now, TIME_ZONE());
  const existing = await prisma.providerBatch.findFirst({ where: { labId: config.labId, intent, slotAt, shadow: true } });
  const items = ((existing?.items ?? []) as unknown as StoredBatchItem[]).filter((stored) => stored.orderId !== item.order.id);
  const n = items.length + 1;
  items.push({ n, orderId: item.order.id, ruleId: item.rule.id, occurrence: item.occurrence, communicationId, line: await batchLine(intent, n, item, now) });
  const template = await ensureTemplate(BATCH_TEMPLATE_BY_INTENT[intent] ?? BATCH_GENERIC_TEMPLATE);
  const text = renderLabTemplate(template.body, batchVariables(config, items.map((stored) => stored.line), item.rule.name, (await coordinatorMentions(config, now)).text));
  const data = { itemCount: items.length, items: items as unknown as Prisma.InputJsonValue, text };
  if (existing) await prisma.providerBatch.update({ where: { id: existing.id }, data });
  else await prisma.providerBatch.create({ data: { ...data, labId: config.labId, intent, slotAt, shadow: true, recipient: "", createdAt: now } });
}
