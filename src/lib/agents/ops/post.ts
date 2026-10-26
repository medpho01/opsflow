/**
 * Posting to the internal ops group (see group.ts). Every post is an outbox
 * item for counterparty OPS: sent at once in the day, held overnight like
 * everything else, never twice for the same idemKey. A post that carries a
 * task remembers its id, so "on it" / "done" replies in the group move the task.
 */
import { enqueueOutbox } from "../executors/dispatcher";
import { storeWindowTo } from "../executors/storeReply";
import { opsGroup } from "./group";

export type OpsPostKind = "OPS_TASK" | "OPS_ESCALATION" | "OPS_QUESTION" | "OPS_CANCEL" | "OPS_THREAD";

export type OpsPost = {
  kind: OpsPostKind;
  orderId: number;
  text: string;
  idemKey: string;
  journeyId?: string | null;
  actionId?: string | null;
  taskId?: number | null;
  quotedWaId?: string | null;
  now?: Date;
};

export async function postToOps(input: OpsPost): Promise<{ queued: boolean; id: string }> {
  const group = await opsGroup();
  if (!group) {
    console.warn(`[Ops] no internal ops group connected — not posted: ${input.text.slice(0, 80)}`);
    return { queued: false, id: "" };
  }
  const now = input.now ?? new Date();
  return enqueueOutbox({
    counterparty: "OPS", ask: input.kind, orderId: input.orderId, journeyId: input.journeyId ?? null, actionId: input.actionId ?? null,
    windowFrom: now, windowTo: storeWindowTo(now), urgent: true, immediate: true, idemKey: `ops:${input.idemKey}`,
    line: { orderId: input.orderId, patientName: null, appointment: null }, text: input.text,
    extra: { taskId: input.taskId ?? null, quotedWaId: input.quotedWaId ?? null },
  });
}

/** "#93412 · Shivam · Thiruvananthapuram · visit Sat 24 Oct 8:00 am" — the order in one line for a post. */
export function orderLine(o: { id: number; patientName?: string | null; area?: string | null; labRef?: string | null; appointmentTime?: Date | null; labName?: string | null }, tz = process.env.TIMEZONE || "Asia/Kolkata"): string {
  const when = o.appointmentTime ? o.appointmentTime.toLocaleString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
  const first = (o.patientName ?? "").trim().split(/\s+/)[0] || null;
  return [`#${o.id}`, o.labRef ?? null, first, o.area ?? null, o.labName ?? null, when ? `visit ${when}` : null].filter(Boolean).join(" · ");
}
