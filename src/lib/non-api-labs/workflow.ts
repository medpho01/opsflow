import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { hasWhatsAppTarget, resolveLabTarget } from "./target";
import type { RawOrder } from "@/lib/engine/labstack";
import {
  getActiveNewOrderTemplate,
  NON_API_NEW_ORDER_TEMPLATE,
  ensureTemplate,
  isNonApiTemplateKey,
  renderLabTemplate,
  type TemplateVariables,
} from "./templates";
import { buildLadder, planStatusCheck, tokenExpiryFor } from "./ladder";
import { confirmationUrl } from "./confirmation-link";
import { contactVariables, fetchOrderContactDetails } from "./order-details";
import { loadActiveCommunicationRules } from "./rule-store";
import { planRuleActions, selectRulesFor } from "./rules";

type WorkflowStartResult = "started" | "existing" | "skipped" | "failed";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  // Hex is URL-safe and has the same 256 bits of entropy as the 32 random
  // bytes; no Node Buffer or crypto-module import is needed by Webpack.
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

function actionUrl(token: string) {
  return `${appUrl()}/provider/action/${token}`;
}

function asText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => asText(item, "")).filter(Boolean).join(", ") || fallback;
  return fallback;
}

function testsFor(order: RawOrder) {
  const metadata = order.metadata ?? {};
  return asText(metadata.tests ?? metadata.testNames ?? metadata.testName ?? metadata.packageName, "Order details available in LabStack");
}

function locationFor(order: RawOrder) {
  const metadata = order.metadata ?? {};
  return asText(metadata.location ?? metadata.address ?? metadata.patientAddress ?? order.storeName, "Location shared in LabStack");
}

// The workflow column is DateTime? and LabStack can hand us a null appointment,
// so these tolerate null rather than throwing before the transaction and
// reporting the order as merely "failed".
function formatDate(value: Date | null) {
  if (!value) return "Scheduled appointment";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: process.env.TIMEZONE || "Asia/Kolkata" }).format(value);
}

function formatTime(value: Date | null) {
  if (!value) return "scheduled time";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: process.env.TIMEZONE || "Asia/Kolkata" }).format(value);
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

/**
 * Starts exactly one workflow per external order. It is safe to call from
 * every poll: the unique workflow.orderId boundary turns duplicate source
 * events, retries, and concurrent pollers into harmless "existing" results.
 */
export async function startNonApiLabWorkflow(order: RawOrder): Promise<WorkflowStartResult> {
  if (!order.labId) return "skipped";

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: order.labId } });
  if (!config || !config.isActive || config.integrationType !== "NON_API" || !hasWhatsAppTarget(config)) return "skipped";

  // Only orders that arrived AFTER this lab was onboarded. Without this, adding
  // a lab's config (or a poller checkpoint reset) sent "new order — please
  // confirm" plus a poll for every order the lab already had open.
  if (order.createdAt && config.createdAt && new Date(order.createdAt).getTime() < config.createdAt.getTime()) {
    return "skipped";
  }

  const templateKey = isNonApiTemplateKey(config.initialTemplateKey) ? config.initialTemplateKey : NON_API_NEW_ORDER_TEMPLATE;
  const template = templateKey === NON_API_NEW_ORDER_TEMPLATE ? await getActiveNewOrderTemplate() : await ensureTemplate(templateKey);
  if (!template.isActive) {
    console.warn(`[NonApiWorkflow] Template ${templateKey} is inactive; order ${order.id} was not started.`);
    return "skipped";
  }

  const now = new Date();
  const appointmentTime: Date | null = order.appointmentTime ?? null;

  // The order-clock deadlines stay: they are what the lab agreed to, and they
  // still drive {{sla_deadline}}. What changed is that they no longer decide
  // when anything is actually sent — buildLadder does, using both clocks.
  const confirmationDeadline = new Date(now.getTime() + config.confirmationSlaMinutes * 60_000);
  const reminderDeadline = new Date(now.getTime() + config.reminderSlaMinutes * 60_000);
  const escalationDeadline = new Date(now.getTime() + config.escalationSlaMinutes * 60_000);

  // Authored rules replace the built-in ladder — but only the ones that
  // actually cover this lab and order type. A rule scoped to the imaging labs
  // must not silence the default ladder for every other provider, which is
  // what an unscoped "any rule exists" check used to do.
  const scopedRules = selectRulesFor(await loadActiveCommunicationRules(), {
    labId: order.labId,
    orderType: order.orderType,
  });
  const ruleActions = scopedRules.length > 0
    ? planRuleActions({
      orderId: order.id,
      labId: order.labId,
      orderType: order.orderType,
      createdAt: now,
      appointmentTime,
      rules: scopedRules,
      appointmentRemindersEnabled: config.appointmentRemindersEnabled,
      now,
    })
    : [];
  const ladder = scopedRules.length > 0
    ? ruleActions.map((action) => ({
      rungKey: null as string | null,
      ruleId: action.ruleId,
      anchor: action.anchor,
      type: action.type,
      priority: action.priority,
      offsetMinutes: action.offsetMinutes,
      runAt: action.runAt,
      idempotencyKey: action.idempotencyKey,
    }))
    : buildLadder({
      orderId: order.id,
      createdAt: now,
      appointmentTime,
      config,
      now,
    }).map((rung) => ({
      rungKey: rung.rungKey as string | null,
      ruleId: null as string | null,
      anchor: rung.anchor,
      type: rung.type,
      priority: rung.priority,
      offsetMinutes: rung.offsetMinutes,
      runAt: rung.runAt,
      idempotencyKey: rung.idempotencyKey,
    }));
  // Authored rules only describe how to chase a confirmation; the status check
  // after the appointment still applies to those labs.
  const statusCheck = scopedRules.length > 0 && config.postAppointmentCheckEnabled
    ? planStatusCheck({ orderId: order.id, appointmentTime, now })
    : null;
  if (statusCheck) {
    ladder.push({
      rungKey: statusCheck.rungKey,
      ruleId: null,
      anchor: statusCheck.anchor,
      type: statusCheck.type,
      priority: statusCheck.priority,
      offsetMinutes: statusCheck.offsetMinutes,
      runAt: statusCheck.runAt,
      idempotencyKey: statusCheck.idempotencyKey,
    });
  }
  // Action links must outlive the appointment; they used to die on
  // escalationDeadline, which could fall before the patient was even due.
  const tokenExpiry = tokenExpiryFor(appointmentTime, escalationDeadline);

  // Who, where and which tests. A failed read is "unknown", not "no details":
  // report the start as failed so the next poll retries it, rather than send
  // a confirmation request with the address missing.
  const detailsById = await fetchOrderContactDetails([order.id]).catch(() => null);
  if (!detailsById) {
    console.warn(`[NonApiWorkflow] LabStack details unavailable for order ${order.id}; will retry next poll.`);
    return "failed";
  }
  const details = detailsById.get(order.id) ?? null;

  const acceptToken = bearerToken();
  const rescheduleToken = bearerToken();
  const rejectToken = bearerToken();
  const [acceptTokenHash, rescheduleTokenHash, rejectTokenHash] = await Promise.all([
    sha256(acceptToken), sha256(rescheduleToken), sha256(rejectToken),
  ]);
  const safeVariables = {
    lab_name: config.labName,
    manager_name: config.managerName || "team",
    order_id: String(order.id),
    patient_name: order.patientName || "Patient",
    appointment_date: formatDate(appointmentTime),
    appointment_time: formatTime(appointmentTime),
    location: locationFor(order),
    tests: details?.tests || testsFor(order),
    sla_deadline: `${formatDate(confirmationDeadline)} ${formatTime(confirmationDeadline)}`,
    ...contactVariables(details),
  };
  try {
    // Resolved before the transaction below: for a group target this may
    // register the wa_groups row, and that lookup does not belong inside the
    // workflow's write transaction. It is inside this try (not above it, as
    // it used to be) because it now does a DB write of its own and can throw
    // — and this function's contract is to never throw, only ever return a
    // WorkflowStartResult, so its caller's batch loop can process every
    // order in a poll cycle even when one lookup fails.
    const target = await resolveLabTarget(config);
    // The provider confirms on the LabStack confirmation page, which moves the
    // order to ORDER_SCHEDULED — that is what stops the reminders. No poll:
    // one message, one action (agreed Oct 2026). Minted per message (fresh IV)
    // and deliberately NOT stored with the template variables.
    const rendered = renderLabTemplate(template.body, {
      ...safeVariables,
      confirm_url: confirmationUrl(order.id),
      accept_url: actionUrl(acceptToken),
      reschedule_url: actionUrl(rescheduleToken),
      reject_url: actionUrl(rejectToken),
    } satisfies TemplateVariables);

    await prisma.$transaction(async (tx) => {
      const workflow = await tx.labCommunicationWorkflow.create({
        data: {
          orderId: order.id,
          labId: order.labId!,
          sourceOrderStatus: order.orderStatus,
          appointmentTime,
          orderSnapshot: {
            orderId: order.id,
            labId: order.labId,
            labName: order.labName ?? config.labName,
            patientName: order.patientName,
            appointmentTime: appointmentTime ? appointmentTime.toISOString() : null,
            location: safeVariables.location,
            tests: safeVariables.tests,
            patientMobile: details?.patientMobile ?? null,
            patientAddress: details?.address ?? null,
            mapUrl: details?.mapUrl ?? null,
          },
          confirmationDeadline,
          reminderDeadline,
          escalationDeadline,
          actionTokens: {
            create: [
              { action: "ACCEPT", tokenHash: acceptTokenHash, expiresAt: tokenExpiry },
              { action: "RESCHEDULE", tokenHash: rescheduleTokenHash, expiresAt: tokenExpiry },
              { action: "REJECT", tokenHash: rejectTokenHash, expiresAt: tokenExpiry },
            ],
          },
        },
      });

      const communication = await tx.labCommunication.create({
        data: {
          workflowId: workflow.id,
          // Denormalized from the order, exactly as the ladder's messages do.
          // Without them this row was reachable only through workflowId, so
          // per-lab history and anything counting messages for an order — the
          // breach path's per-order cap included — silently skipped the one
          // message every order definitely gets.
          labId: order.labId,
          orderId: order.id,
          type: "INITIAL_NOTIFICATION",
          recipient: target.targetJid,
          templateKey: template.key,
          templateVariables: safeVariables,
          idempotencyKey: `non-api:${order.id}:initial-notification`,
        },
      });
      const outbound = await tx.waOutbound.create({
        // Group targets must carry groupId — that is what the gateway's
        // per-group sendEnabled guard keys off.
        //
        data: {
          targetJid: target.targetJid,
          text: rendered,
          groupId: target.groupId,
        },
      });
      await tx.labCommunication.update({ where: { id: communication.id }, data: { waOutboundId: outbound.id } });

      await tx.labScheduledAction.createMany({
        data: ladder.map((rung) => ({
          workflowId: workflow.id,
          type: rung.type,
          anchor: rung.anchor,
          offsetMinutes: rung.offsetMinutes,
          priority: rung.priority,
          rungKey: rung.rungKey,
          ruleId: rung.ruleId,
          runAt: rung.runAt,
          idempotencyKey: rung.idempotencyKey,
        })),
      });
      await tx.labCommunicationOrderEvent.createMany({
        data: [
          { workflowId: workflow.id, type: "ORDER_DETECTED", actorType: "SYSTEM", payload: { sourceOrderStatus: order.orderStatus } },
          { workflowId: workflow.id, type: "WORKFLOW_STARTED", actorType: "SYSTEM" },
          { workflowId: workflow.id, type: "MESSAGE_QUEUED", actorType: "SYSTEM", payload: { communicationId: communication.id, outboundId: outbound.id } },
          {
            workflowId: workflow.id,
            type: "REMINDER_SCHEDULED",
            actorType: "SYSTEM",
            payload: {
              confirmationDeadline: confirmationDeadline.toISOString(),
              reminderDeadline: reminderDeadline.toISOString(),
              escalationDeadline: escalationDeadline.toISOString(),
              appointmentTime: appointmentTime ? appointmentTime.toISOString() : null,
              // Which policy produced this plan, so the timeline can say
              // "these four messages came from your rules" rather than
              // leaving Ops to infer it from the offsets.
              plannedBy: scopedRules.length > 0 ? "RULES" : "DEFAULT_LADDER",
              ladder: ladder.map((rung) => ({
                rungKey: rung.rungKey,
                ruleId: rung.ruleId,
                anchor: rung.anchor,
                offsetMinutes: rung.offsetMinutes,
                priority: rung.priority,
                runAt: rung.runAt.toISOString(),
              })),
            },
          },
        ],
      });
      await tx.labCommunicationAuditLog.create({
        data: { workflowId: workflow.id, action: "WORKFLOW_CREATED", actorType: "SYSTEM", metadata: { orderId: order.id, labId: order.labId } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    console.info(`[NonApiWorkflow] Started workflow for order ${order.id}, lab ${order.labId}.`);
    return "started";
  } catch (error) {
    if (isUniqueViolation(error)) return "existing";
    console.error(`[NonApiWorkflow] Failed to start workflow for order ${order.id}:`, error);
    return "failed";
  }
}

export async function startDetectedNonApiLabWorkflows(orders: RawOrder[]) {
  const result = { started: 0, existing: 0, skipped: 0, failed: 0 };
  // Serial execution keeps a large first poll from taking a burst of database
  // connections while preserving each workflow's transaction boundary.
  //
  // Per-order try/catch is a deliberate second layer, not trust that
  // startNonApiLabWorkflow never throws: its contract is to always resolve to
  // a WorkflowStartResult, but this loop must still survive a future change
  // that breaks that contract for one order without silently dropping every
  // order after it in the same poll cycle.
  for (const order of orders) {
    try {
      result[await startNonApiLabWorkflow(order)] += 1;
    } catch (error) {
      console.error(`[NonApiWorkflow] Unexpected error starting workflow for order ${order.id}:`, error);
      result.failed += 1;
    }
  }
  return result;
}
