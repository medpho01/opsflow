/**
 * A store's request, tracked until it is closed (27 Oct 2026).
 *
 * Every store message that asks for something opens a thread: what was asked,
 * which order, who the next move is with (the lab, our ops team, or the store
 * itself). A thread closes when the console shows the change (a reschedule's
 * new time, a cancellation, the report), when the agent answered, when the
 * task a person took is done, or when a team member answered in the group.
 * While it is open and the store's desk is LIVE, the agent reminds whoever it
 * waits on — the lab with a fresh ask, the ops group with a post — and after
 * two reminders escalates to the ops group whatever it waits on.
 *
 * A nudge with no order id ("is this done?", "any update?", "@Veena") in a
 * store group lands on the thread it is about: the one it quotes, or the only
 * thread open in that group in the last few hours.
 */
import { TaskStatus } from "@prisma/client";
import prisma from "@/lib/db/client";
import type { OrderSnapshot } from "../journey/policy";
import { fetchOrderSnapshots } from "../journey/window";
import { loadGuardState } from "../guard/guard";
import { enqueueOutbox } from "../executors/dispatcher";
import { postToOps, orderLine } from "../ops/post";
import { AGENT_RULE_ID } from "../executors/tasks";
import { loadLiveSops, paramsFor } from "../sop/load";

/** The store desk's reminder timings for a store, from its SOP (params.storeRemindLabMin / storeRemindOpsMin). */
async function remindMinutes(storeId: number): Promise<{ lab: number; ops: number }> {
  const sops = await loadLiveSops().catch(() => new Map());
  const p = paramsFor(sops.get("STORE") ?? sops.get("LAB") ?? null, { labTier: null, labId: null, storeId, orderType: "HOME_SAMPLE" });
  return { lab: p?.storeRemindLabMin ?? 60, ops: p?.storeRemindOpsMin ?? 45 };
}

const MIN = 60_000;
const TZ = () => process.env.TIMEZONE || "Asia/Kolkata";
const hhmm = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: TZ(), hour: "numeric", minute: "2-digit" });

/** The requests worth tracking, by the reader's intent. Acks and noise open nothing. */
export const THREAD_KINDS = new Set(["status", "report", "slot", "reschedule", "cancel", "change_tests", "new_booking", "serviceability", "complaint", "other"]);

/** Who the next move is with. The agent answers status and chases the lab; a person acts on the rest. */
export function waitingOnFor(kind: string): "LAB" | "OPS" | "STORE" {
  if (kind === "status" || kind === "report" || kind === "slot") return "LAB";
  return "OPS";
}

/** First reminder: the lab gets an hour, our own team 45 minutes — the SOP's numbers when given. */
export function firstRemindAt(kind: string, openedAt: Date, minutes: { lab: number; ops: number } = { lab: 60, ops: 45 }): Date {
  return new Date(openedAt.getTime() + (waitingOnFor(kind) === "LAB" ? minutes.lab : minutes.ops) * MIN);
}

export type ThreadRow = { id: string; orderId: number; storeId: number; kind: string; waitingOn: string; openedAt: Date; snapshot: unknown; reminders: number };

/**
 * Does the console now show what the store asked for? Pure, so it is tested.
 *   reschedule → the visit moved after the thread opened
 *   cancel     → the order is cancelled
 *   report     → the report is delivered
 *   anything   → the order is cancelled or delivered (nothing left to ask)
 */
export function closedByConsole(thread: Pick<ThreadRow, "kind" | "snapshot">, order: Pick<OrderSnapshot, "orderStatus" | "appointmentTime">): string | null {
  const snap = (thread.snapshot ?? {}) as { appointmentTime?: string | null; status?: string | null };
  const cancelled = order.orderStatus === "CANCELLED" || order.orderStatus === "CANCELED";
  if (thread.kind === "reschedule") {
    const before = snap.appointmentTime ? new Date(snap.appointmentTime).getTime() : null;
    const after = order.appointmentTime?.getTime() ?? null;
    if (before != null && after != null && before !== after) return "rescheduled in the console";
    if (order.orderStatus === "RESCHEDULED" && snap.status !== "RESCHEDULED") return "rescheduled in the console";
  }
  if (thread.kind === "cancel" && cancelled) return "cancelled in the console";
  if (thread.kind === "report" && order.orderStatus === "REPORT_DELIVERED") return "report delivered";
  if (cancelled) return "order cancelled";
  if (order.orderStatus === "REPORT_DELIVERED" && thread.kind !== "complaint") return "order delivered";
  return null;
}

export async function openThread(input: { orderId: number; storeId: number; groupId: string; kind: string; messageId: string; waMsgId: string | null; text: string; at: Date; order: Pick<OrderSnapshot, "orderStatus" | "appointmentTime"> | null }): Promise<string | null> {
  if (!THREAD_KINDS.has(input.kind)) return null;
  // A second request of the same kind on an open thread joins it rather than opening another.
  const open = await prisma.agentThread.findFirst({ where: { orderId: input.orderId, storeId: input.storeId, kind: input.kind, status: "OPEN" }, select: { id: true } });
  if (open) return open.id;
  const row = await prisma.agentThread.create({
    data: {
      orderId: input.orderId, storeId: input.storeId, groupId: input.groupId, kind: input.kind, waitingOn: waitingOnFor(input.kind),
      openedAt: input.at, messageId: input.messageId, waMsgId: input.waMsgId, text: input.text.slice(0, 500),
      snapshot: input.order ? { status: input.order.orderStatus, appointmentTime: input.order.appointmentTime?.toISOString() ?? null } : undefined,
      nextRemindAt: firstRemindAt(input.kind, input.at, await remindMinutes(input.storeId)),
    },
    select: { id: true },
  }).catch(() => null);
  return row?.id ?? null;
}

export async function closeThread(id: string, reason: string, at = new Date()) {
  await prisma.agentThread.updateMany({ where: { id, status: "OPEN" }, data: { status: "CLOSED", closedAt: at, closeReason: reason, nextRemindAt: null } });
}

/** A team member answered in the store group: the threads that message is about are closed. */
export async function teamAnswered(input: { storeId: number; groupId: string; orderIds: number[]; replyToWaId: string | null; at: Date; sender: string }): Promise<number> {
  const open = await prisma.agentThread.findMany({ where: { storeId: input.storeId, status: "OPEN" }, select: { id: true, orderId: true, waMsgId: true, openedAt: true } });
  if (!open.length) return 0;
  let ids = open.filter((t) => (input.replyToWaId && t.waMsgId === input.replyToWaId) || input.orderIds.includes(t.orderId)).map((t) => t.id);
  // No id and no quote: an answer within 30 minutes of the only open thread is for that thread.
  if (!ids.length && !input.orderIds.length) {
    const recent = open.filter((t) => input.at.getTime() - t.openedAt.getTime() <= 30 * MIN);
    if (recent.length === 1) ids = [recent[0].id];
  }
  for (const id of ids) await closeThread(id, `${input.sender} answered in the group`, input.at);
  return ids.length;
}

/** The thread a nudge without an order id is about, if there is exactly one it can mean. */
export async function threadForNudge(input: { storeId: number; replyToWaId: string | null; at: Date }): Promise<{ id: string; orderId: number; kind: string; waitingOn: string; openedAt: Date } | null> {
  const select = { id: true, orderId: true, kind: true, waitingOn: true, openedAt: true };
  if (input.replyToWaId) {
    const quoted = await prisma.agentThread.findFirst({ where: { storeId: input.storeId, waMsgId: input.replyToWaId }, orderBy: { openedAt: "desc" }, select });
    if (quoted) return quoted;
    // Quoting one of our replies about an order: that order's open thread.
    const ours = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: input.replyToWaId }, select: { id: true } });
    if (ours) {
      const item = await prisma.agentOutboxItem.findFirst({ where: { outboundId: ours.id }, select: { orderId: true } });
      if (item?.orderId) {
        const t = await prisma.agentThread.findFirst({ where: { storeId: input.storeId, orderId: item.orderId, status: "OPEN" }, orderBy: { openedAt: "desc" }, select });
        if (t) return t;
      }
    }
  }
  const open = await prisma.agentThread.findMany({ where: { storeId: input.storeId, status: "OPEN", openedAt: { gte: new Date(input.at.getTime() - 4 * 3_600_000) } }, select });
  const orders = new Set(open.map((t) => t.orderId));
  return orders.size === 1 ? open[0] : null;
}

export type ThreadSweepResult = { open: number; closed: number; reminded: number; escalated: number };

/** Every few minutes: close what the console, a reply or a task settled; remind whoever the rest waits on. */
export async function sweepThreads(now = new Date()): Promise<ThreadSweepResult> {
  const result: ThreadSweepResult = { open: 0, closed: 0, reminded: 0, escalated: 0 };
  const open = await prisma.agentThread.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "asc" }, take: 300 });
  result.open = open.length;
  if (!open.length) return result;
  const snaps = await fetchOrderSnapshots([...new Set(open.map((t) => t.orderId))]).catch(() => new Map<number, OrderSnapshot>());
  const state = await loadGuardState();
  const tasks = await prisma.task.findMany({ where: { taskRuleId: AGENT_RULE_ID, entityId: { in: [...new Set(open.map((t) => t.orderId))] } }, select: { entityId: true, status: true, completedAt: true } });
  const answered = await prisma.agentAction.findMany({
    where: { orderId: { in: [...new Set(open.map((t) => t.orderId))] }, desk: "STORE", action: { in: ["store_reply", "store_alert"] }, outcome: { in: ["EXECUTED", "RECORDED"] }, createdAt: { gte: new Date(Math.min(...open.map((t) => t.openedAt.getTime()))) } },
    select: { orderId: true, createdAt: true, params: true },
  });

  for (const t of open) {
    const order = snaps.get(t.orderId) ?? null;
    // 1. Closed by the console.
    const byConsole = order ? closedByConsole(t, order) : null;
    if (byConsole) { await closeThread(t.id, byConsole, now); result.closed += 1; continue; }
    // 2. Closed by a task a person finished.
    const task = tasks.find((x) => x.entityId === t.orderId);
    if (t.waitingOn === "OPS" && task?.status === TaskStatus.COMPLETED && task.completedAt && task.completedAt > t.openedAt) {
      await closeThread(t.id, "task done", now); result.closed += 1; continue;
    }
    // 3. Closed by the agent's own answer: a status answer with substance (not "checking", not "noted").
    if (t.waitingOn === "LAB") {
      const a = answered.find((x) => x.orderId === t.orderId && x.createdAt > t.openedAt && !/checking with|noted, we'll confirm/i.test(String((x.params as { text?: string; statusLine?: string })?.text ?? (x.params as { statusLine?: string })?.statusLine ?? "")));
      if (a) { await closeThread(t.id, "answered", now); result.closed += 1; continue; }
    }
    // 4. Still open: remind, if due and the store's desk is LIVE.
    if (!t.nextRemindAt || t.nextRemindAt > now) continue;
    if (state.desks.get(`STORE:STORE:${t.storeId}`) !== "LIVE") { await prisma.agentThread.update({ where: { id: t.id }, data: { nextRemindAt: new Date(now.getTime() + 60 * MIN) } }); continue; }
    if (t.reminders >= 3) { await prisma.agentThread.update({ where: { id: t.id }, data: { nextRemindAt: null } }); continue; }
    const line = order ? orderLine({ id: order.id, patientName: order.patientName, labRef: order.labRef, area: order.area, labName: order.labName, appointmentTime: order.appointmentTime }) : `#${t.orderId}`;
    const since = `${t.kind.replace("_", " ")} asked at ${hhmm(t.openedAt)}`;
    const escalate = t.reminders >= 1 || t.waitingOn === "OPS";
    if (t.waitingOn === "LAB" && order?.labId != null) {
      await enqueueOutbox({
        counterparty: `LAB:${order.labId}`, ask: "STATUS", orderId: t.orderId, journeyId: null, actionId: null, windowFrom: now, windowTo: new Date(now.getTime() + 4 * 3_600_000),
        urgent: true, immediate: true, idemKey: `thread:${t.id}:remind:${t.reminders + 1}`,
        line: { orderId: t.orderId, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef, mobile: order.mobile, area: order.area, note: `the store is waiting — ${since}` },
      }).catch(() => undefined);
    }
    if (escalate) {
      await postToOps({
        kind: "OPS_THREAD", orderId: t.orderId, idemKey: `thread:${t.id}:${t.reminders + 1}`, now,
        text: `${t.reminders >= 2 ? "🔴" : "⏳"} *Store still waiting* — ${since}\n${line}\n"${t.text.slice(0, 160)}"\n${t.waitingOn === "LAB" ? `${order?.labName ?? "The lab"} has not answered; asked again now.` : "Needs someone from our side."}\n\nReply *on it* to take it, *done* when closed.`,
      }).catch(() => undefined);
      result.escalated += 1;
    }
    result.reminded += 1;
    const minutes = await remindMinutes(t.storeId);
    await prisma.agentThread.update({ where: { id: t.id }, data: { reminders: t.reminders + 1, lastRemindAt: now, nextRemindAt: new Date(now.getTime() + (t.waitingOn === "LAB" ? minutes.lab : minutes.ops) * MIN) } });
  }
  return result;
}
