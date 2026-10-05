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
import { ensureTemplate, renderLabTemplate, type TemplateVariables } from "@/lib/non-api-labs/templates";
import { confirmationUrl } from "@/lib/non-api-labs/confirmation-link";
import { contactVariables, type OrderContactDetails } from "@/lib/non-api-labs/order-details";
import { newConversationStatus } from "./evaluate";
import { durationText, formatDate, formatDateTime, formatTime } from "./format";
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

export async function deliverOrderMessage(input: DeliverOrderInput): Promise<DeliverOutcome> {
  const { rule, order, config, contact, facts, occurrence, moment, now } = input;

  const template = await ensureTemplate(rule.templateKey);
  if (!template.isActive) return { sent: false, reason: `Message "${template.name}" is paused` };

  const toManager = rule.recipient === "MANAGER";
  const managerMissing = toManager && !config.managerWhatsapp;
  const target = await resolveLabTarget(config, toManager ? config.managerWhatsapp : null);

  // The conversation: found, or opened now. Its snapshot keeps the details the
  // lab was sent, for the timeline and for poll acknowledgements.
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

  const tokenExpiry = new Date(Math.max(
    (order.appointmentTime?.getTime() ?? now.getTime()) + TOKEN_GRACE_MINUTES * 60_000,
    now.getTime() + 24 * 3_600_000,
  ));
  const tokens = await Promise.all((["ACCEPT", "RESCHEDULE", "REJECT"] as const).map(async (action) => {
    const token = bearerToken();
    return { action, token, tokenHash: await sha256(token) };
  }));

  const variables: TemplateVariables = {
    ...orderVariables(order, config, contact, facts, rule, occurrence, moment, now),
    accept_url: actionUrl(tokens[0].token),
    reschedule_url: actionUrl(tokens[1].token),
    reject_url: actionUrl(tokens[2].token),
  };
  // Rendered with the link but stored without it (a fresh token per message).
  const text = renderLabTemplate(template.body, { ...variables, confirm_url: await confirmationUrl(order.id) });
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
      // groupId arms the gateway's per-group sendEnabled guard.
      // No polls: labs answer in their own words (replies.ts reads them).
      data: { targetJid: target.targetJid, text, groupId: target.groupId, createdAt: now },
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
