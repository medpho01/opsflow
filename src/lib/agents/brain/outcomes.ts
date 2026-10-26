/**
 * What came of each action (27 Oct 2026): the learning loop's raw material.
 * Scored a couple of hours after the action, once the answer window has
 * passed, and written to agent_actions.effect:
 *
 *   ask / reminder / manager_whatsapp  { answered, minutes }   a fact or a lab message on the order within 2 h of the send
 *   store_reply / store_alert / ack    { settled, nudges }     no further store message on the order within 1 h
 *   create_task                        { done, minutes }       the task completed, and how long it took
 *   ops_post                           { acknowledged, minutes } someone replied "on it" / "done" in the ops group
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";

const MIN = 60_000;
const ANSWER_WINDOW_MIN = 120;
const SETTLE_WINDOW_MIN = 60;

export type OutcomeResult = { scored: number; asksAnswered: number; asks: number; settled: number; storeMessages: number; tasksDone: number; tasks: number };

export async function scoreOutcomes(now = new Date(), lookbackHours = 48): Promise<OutcomeResult> {
  const result: OutcomeResult = { scored: 0, asksAnswered: 0, asks: 0, settled: 0, storeMessages: 0, tasksDone: 0, tasks: 0 };
  const actions = await prisma.agentAction.findMany({
    where: { outcome: "EXECUTED", effectAt: null, createdAt: { gte: new Date(now.getTime() - lookbackHours * 3_600_000), lte: new Date(now.getTime() - ANSWER_WINDOW_MIN * MIN) }, action: { in: ["ask", "reminder", "manager_whatsapp", "store_reply", "store_alert", "ack", "create_task", "ops_post"] } },
    select: { id: true, action: true, orderId: true, journeyId: true, createdAt: true },
    take: 2000,
  });
  for (const a of actions) {
    if (a.orderId == null) continue;
    let effect: Record<string, unknown> | null = null;
    if (a.action === "ask" || a.action === "reminder" || a.action === "manager_whatsapp") {
      const item = await prisma.agentOutboxItem.findFirst({ where: { actionId: a.id, status: "SENT" }, select: { sentAt: true } });
      const sentAt = item?.sentAt ?? a.createdAt;
      const until = new Date(sentAt.getTime() + ANSWER_WINDOW_MIN * MIN);
      const fact = await prisma.providerOrderFact.findFirst({ where: { orderId: a.orderId, createdAt: { gt: sentAt, lte: until } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      const msg = fact ? null : await prisma.waMessage.findFirst({ where: { orderIds: { has: a.orderId }, direction: "IN", fromMe: false, ts: { gt: sentAt, lte: until } }, orderBy: { ts: "asc" }, select: { ts: true } });
      const at = fact?.createdAt ?? msg?.ts ?? null;
      effect = { answered: !!at, minutes: at ? Math.round((at.getTime() - sentAt.getTime()) / MIN) : null };
      result.asks += 1; if (at) result.asksAnswered += 1;
    } else if (a.action === "store_reply" || a.action === "store_alert" || a.action === "ack") {
      const item = await prisma.agentOutboxItem.findFirst({ where: { actionId: a.id, status: "SENT" }, select: { sentAt: true } });
      const sentAt = item?.sentAt ?? a.createdAt;
      const nudges = a.journeyId ? await prisma.agentJourneyEvent.count({ where: { journeyId: a.journeyId, kind: "store_message", actor: "STORE", at: { gt: sentAt, lte: new Date(sentAt.getTime() + SETTLE_WINDOW_MIN * MIN) } } }) : 0;
      effect = { settled: nudges === 0, nudges };
      result.storeMessages += 1; if (nudges === 0) result.settled += 1;
    } else if (a.action === "create_task") {
      const ev = a.journeyId ? await prisma.agentJourneyEvent.findFirst({ where: { journeyId: a.journeyId, kind: "task", at: { gte: new Date(a.createdAt.getTime() - MIN) } }, orderBy: { at: "asc" }, select: { payload: true } }) : null;
      const taskId = (ev?.payload as { taskId?: number } | null)?.taskId ?? null;
      const task = taskId ? await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, completedAt: true } }) : null;
      const done = task?.status === "COMPLETED";
      effect = { done, minutes: done && task?.completedAt ? Math.round((task.completedAt.getTime() - a.createdAt.getTime()) / MIN) : null, taskId };
      result.tasks += 1; if (done) result.tasksDone += 1;
    } else if (a.action === "ops_post") {
      const reply = a.journeyId ? await prisma.agentJourneyEvent.findFirst({ where: { journeyId: a.journeyId, kind: "ops_reply", at: { gt: a.createdAt } }, orderBy: { at: "asc" }, select: { at: true } }) : null;
      effect = { acknowledged: !!reply, minutes: reply ? Math.round((reply.at.getTime() - a.createdAt.getTime()) / MIN) : null };
    }
    if (!effect) continue;
    await prisma.agentAction.update({ where: { id: a.id }, data: { effect: effect as Prisma.InputJsonValue, effectAt: now } }).catch(() => undefined);
    result.scored += 1;
  }
  return result;
}
