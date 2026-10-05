/**
 * Make sure every upcoming order gets its post-appointment status check.
 *
 * The check is normally planned when an order's workflow starts. Two kinds of
 * order never got one that way:
 *   - orders whose workflow started before the check existed, and
 *   - orders placed before their lab was configured — the poller deliberately
 *     never starts a workflow for those (no "new order" for an old order).
 *
 * So this sweep runs every few minutes and fills the gap: for each live
 * NON_API lab with the check switched on, every open home-collection order
 * whose appointment is coming up gets an APPT_STATUS_CHECK action. The
 * scheduler then sends it like any other, re-checking LabStack first.
 *
 * One rule matters above all: never create a workflow for an order the poller
 * is about to pick up. Its unique orderId would turn the poller's start into
 * "existing" and the lab would never get the new-order message. So a shell
 * workflow is only created for orders placed BEFORE the lab was configured;
 * newer orders without a workflow are left to the poller.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { STATUS_CHECK_RUNG } from "./ladder";
import { hasWhatsAppTarget } from "./target";
import { isAwaitingConfirmation, isPastCollection } from "./source-check";
import { fetchOrderContactDetails } from "./order-details";

const SWEEP_EVERY_MS = 10 * 60_000;
/** How far ahead to plan. Further out, the appointment is too likely to move. */
const LOOKAHEAD_HOURS = 72;
const CLOSED_WORKFLOW = new Set(["CANCELLED", "COMPLETED", "LAB_REJECTED"]);
const DEAD_ORDER = new Set(["CANCELED", "REPORT_DELIVERED", "PATIENT_MISSED"]);

let lastSweepAt = 0;

export type SweepOrder = {
  id: number;
  labId: number;
  orderStatus: string;
  appointmentTime: Date;
  createdAt: Date;
  patientName: string | null;
};

export type SweepWorkflow = { id: string; orderId: number; status: string; hasStatusCheck: boolean };

export type SweepPlan = {
  /** Existing workflows that only need the check added. */
  addTo: Array<{ workflowId: string; order: SweepOrder }>;
  /** Pre-configuration orders that need a check-only workflow. */
  shells: SweepOrder[];
};

/** Decide what to create. Pure, so the "never steal the poller's order" rule is testable. */
export function planStatusCheckSweep(
  orders: SweepOrder[],
  labConfiguredAt: Map<number, Date>,
  workflowsByOrder: Map<number, SweepWorkflow>,
  now: Date,
): SweepPlan {
  const plan: SweepPlan = { addTo: [], shells: [] };
  for (const order of orders) {
    const runAt = order.appointmentTime.getTime() + STATUS_CHECK_RUNG.offsetMinutes({} as never) * 60_000;
    if (runAt <= now.getTime()) continue;
    if (DEAD_ORDER.has(order.orderStatus) || isPastCollection(order.orderStatus)) continue;

    const workflow = workflowsByOrder.get(order.id);
    if (workflow) {
      if (!workflow.hasStatusCheck && !CLOSED_WORKFLOW.has(workflow.status)) {
        plan.addTo.push({ workflowId: workflow.id, order });
      }
      continue;
    }
    const configuredAt = labConfiguredAt.get(order.labId);
    if (configuredAt && order.createdAt.getTime() < configuredAt.getTime()) plan.shells.push(order);
  }
  return plan;
}

function statusCheckAction(workflowId: string, order: SweepOrder) {
  const offsetMinutes = STATUS_CHECK_RUNG.offsetMinutes({} as never);
  return {
    workflowId,
    type: STATUS_CHECK_RUNG.type,
    anchor: STATUS_CHECK_RUNG.anchor,
    offsetMinutes,
    priority: STATUS_CHECK_RUNG.priority,
    rungKey: STATUS_CHECK_RUNG.key,
    runAt: new Date(order.appointmentTime.getTime() + offsetMinutes * 60_000),
    // Same key planStatusCheck uses, so a check can never be scheduled twice.
    idempotencyKey: `non-api:${order.id}:${STATUS_CHECK_RUNG.key.toLowerCase()}`,
  };
}

export type SweepResult = { added: number; shells: number; skipped?: "not-due" | "no-labs" };

export async function runStatusCheckSweep(now = new Date(), force = false): Promise<SweepResult> {
  if (!force && now.getTime() - lastSweepAt < SWEEP_EVERY_MS) return { added: 0, shells: 0, skipped: "not-due" };
  lastSweepAt = now.getTime();

  const configs = (await prisma.nonApiLabConfig.findMany({
    where: { isActive: true, integrationType: "NON_API", postAppointmentCheckEnabled: true },
  })).filter(hasWhatsAppTarget);
  if (configs.length === 0) return { added: 0, shells: 0, skipped: "no-labs" };

  // Bounded on the indexed appointmentTime and on these labs only.
  const orders = (await labstackWorkerQuery<SweepOrder>(
    `SELECT o.id, o."labId", o."orderStatus"::text AS "orderStatus", o."appointmentTime", o."createdAt",
            u.name AS "patientName"
       FROM public."Order" o
       LEFT JOIN public."User" u ON u.id = o."userId"
      WHERE o."labId" = ANY($1::int[])
        AND o."orderType" = 'HOME_SAMPLE'
        AND o."appointmentTime" >= now() - interval '1 hour'
        AND o."appointmentTime" <  now() + make_interval(hours => $2::int)`,
    [configs.map((config) => config.labId), LOOKAHEAD_HOURS],
  )).map((order) => ({ ...order, appointmentTime: new Date(order.appointmentTime), createdAt: new Date(order.createdAt) }));
  if (orders.length === 0) return { added: 0, shells: 0 };

  const workflows = await prisma.labCommunicationWorkflow.findMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
    select: {
      id: true, orderId: true, status: true,
      scheduledActions: { where: { rungKey: STATUS_CHECK_RUNG.key }, select: { id: true } },
    },
  });
  const plan = planStatusCheckSweep(
    orders,
    new Map(configs.map((config) => [config.labId, config.createdAt])),
    new Map(workflows.map((w) => [w.orderId, { id: w.id, orderId: w.orderId, status: w.status, hasStatusCheck: w.scheduledActions.length > 0 }])),
    now,
  );

  return applyStatusCheckPlan(plan, now);
}

/** Write a plan: add checks to existing workflows, create check-only shells. */
export async function applyStatusCheckPlan(plan: SweepPlan, now = new Date()): Promise<SweepResult> {
  let added = 0;
  if (plan.addTo.length > 0) {
    const created = await prisma.labScheduledAction.createMany({
      data: plan.addTo.map(({ workflowId, order }) => statusCheckAction(workflowId, order)),
      skipDuplicates: true,
    });
    added = created.count;
  }

  let shells = 0;
  if (plan.shells.length > 0) {
    // The message names the patient and tests, so the shell carries the same
    // snapshot a normal workflow would. Unknown details fall back at send time.
    const details = await fetchOrderContactDetails(plan.shells.map((order) => order.id)).catch(() => null);
    for (const order of plan.shells) {
      const contact = details?.get(order.id) ?? null;
      try {
        await prisma.$transaction(async (tx) => {
          const workflow = await tx.labCommunicationWorkflow.create({
            data: {
              orderId: order.id,
              labId: order.labId,
              // Mirrors LabStack: an order already scheduled there needs no chasing.
              status: isAwaitingConfirmation(order.orderStatus) ? "WAITING_FOR_LAB_CONFIRMATION" : "LAB_ACCEPTED",
              sourceOrderStatus: order.orderStatus,
              appointmentTime: order.appointmentTime,
              orderSnapshot: {
                orderId: order.id,
                labId: order.labId,
                patientName: order.patientName,
                appointmentTime: order.appointmentTime.toISOString(),
                tests: contact?.tests ?? null,
                patientMobile: contact?.patientMobile ?? null,
                patientAddress: contact?.address ?? null,
                mapUrl: contact?.mapUrl ?? null,
                statusCheckOnly: true,
              },
              // Required columns; nothing is chased on this workflow.
              confirmationDeadline: now,
              reminderDeadline: now,
              escalationDeadline: now,
            },
          });
          await tx.labScheduledAction.create({ data: statusCheckAction(workflow.id, order) });
          await tx.labCommunicationOrderEvent.create({
            data: {
              workflowId: workflow.id,
              type: "REMINDER_SCHEDULED",
              actorType: "SYSTEM",
              payload: { source: "STATUS_CHECK_SWEEP", reason: "Order placed before the lab was configured" },
            },
          });
        });
        shells += 1;
      } catch (error) {
        // P2002: the poller (or another sweep) created it first — fine.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      }
    }
  }
  return { added, shells };
}
