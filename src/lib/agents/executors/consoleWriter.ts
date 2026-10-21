/**
 * Status writes (FR-3): through the console write API with an idempotency key
 * and an appended internal note. Until the API exists (CONSOLE_API_BASE and
 * CONSOLE_API_KEY unset), the same write becomes a one-click task for a person
 * with the evidence and the exact status to set (DESIGN.md §1 item 12).
 */
import prisma from "@/lib/db/client";
import type { ProposedAction } from "../journey/step";
import type { ExecuteContext, ExecuteResult } from "./index";
import { createAgentTask } from "./tasks";
import { consoleClient, type ConsoleEvidence } from "../console/client";

const TRANSITION_LABEL: Record<string, string> = {
  PHLEBO_STARTED: "Phlebo Started", SAMPLE_COLLECTED: "Sample Collected", SAMPLE_DELIVERED: "Sample Delivered", PHLEBO_NO_SHOW: "Phlebo No Show", PATIENT_MISSED: "Patient Missed",
};

export async function writeStatus(action: ProposedAction, ctx: ExecuteContext): Promise<ExecuteResult> {
  const to = String(action.params.to);
  const ev = (action.params.evidence ?? {}) as { kind?: string; source?: string; value?: string; confidence?: number; factId?: string | null; at?: string | Date };
  const at = ev.at ? new Date(ev.at) : new Date();
  const when = at.toLocaleString("en-IN", { timeZone: process.env.TIMEZONE || "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const note = `${new Date().toLocaleString("en-IN", { timeZone: process.env.TIMEZONE || "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}: ${ev.source?.replace("_", " ") ?? "evidence"} (${when}): "${(ev.value ?? "").slice(0, 120)}". Moved #${ctx.orderId} to ${TRANSITION_LABEL[to] ?? to}. OpsFlow agent, SOP ${ctx.sopVersionId ?? "n/a"}.`;
  const idemKey = `console:${ctx.orderId}:${to}:${ev.factId ?? at.getTime()}`;

  const existing = await prisma.agentConsoleWrite.findUnique({ where: { idemKey } });
  if (existing && existing.status !== "FAILED") return { outcome: "RECORDED", note: `already ${existing.status.toLowerCase()}` };

  const client = consoleClient();
  const evidence: ConsoleEvidence = { kind: ev.source ?? "lab_reply", ref: ev.factId ?? null, at: at.toISOString(), text: ev.value ?? "" };
  if (client) {
    const write = await prisma.agentConsoleWrite.upsert({ where: { idemKey }, update: { status: "PENDING" }, create: { orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: ctx.actionId, transition: to, evidenceId: ev.factId ?? null, idemKey, status: "PENDING", note } });
    try {
      const response = await client.updateStatus(ctx.orderId, { to, idempotencyKey: idemKey, evidence, sopVersion: ctx.sopVersionId ?? null, note });
      await prisma.agentConsoleWrite.update({ where: { id: write.id }, data: { status: "DONE", response: response as object } });
      if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "write", actor: "AGENT", applied: true, payload: { to, note, via: "console_api" } } });
      return { outcome: "EXECUTED", note: `console: ${TRANSITION_LABEL[to] ?? to}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.agentConsoleWrite.update({ where: { id: write.id }, data: { status: "FAILED", response: { error: message } } });
      return { outcome: "FAILED", note: `console API: ${message}` };
    }
  }

  // No API yet: a one-click task carries the exact change and the evidence.
  const task = await createAgentTask({
    orderId: ctx.orderId, orderType: ctx.orderType ?? "HOME_SAMPLE", storeId: ctx.storeId, type: "AGENT_STATUS_WRITE",
    title: `#${ctx.orderId}: mark ${TRANSITION_LABEL[to] ?? to}`,
    payload: { journeyId: ctx.journeyId, cause: `STATUS_${to}`, evidence: [{ kind: ev.source ?? "lab_reply", at: at.toISOString(), text: ev.value ?? "" }], action: `Set #${ctx.orderId} to ${TRANSITION_LABEL[to] ?? to} in the console. Note to add: ${note}`, labId: ctx.labId, verify: { kind: "status_at_least", value: to } },
    appointmentTime: ctx.appointmentTime ?? null, idemKey: `task:${idemKey}`, dueInMinutes: 15,
  });
  await prisma.agentConsoleWrite.upsert({ where: { idemKey }, update: { status: "TASKED", taskId: task.taskId }, create: { orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: ctx.actionId, transition: to, evidenceId: ev.factId ?? null, idemKey, status: "TASKED", note, taskId: task.taskId } });
  if (ctx.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: ctx.journeyId, at: new Date(), kind: "write", actor: "AGENT", applied: true, payload: { to, note, via: "task", taskId: task.taskId } } });
  return { outcome: "EXECUTED", note: `no console API yet: task #${task.taskId} for a person` };
}

/** Revert a write that turned out wrong (FR-3.5): a note, and it counts against autonomy. */
export async function revertWrite(writeId: string, userId: number, reason: string) {
  const write = await prisma.agentConsoleWrite.findUnique({ where: { id: writeId } });
  if (!write) throw new Error("write not found");
  const client = consoleClient();
  if (client && write.status === "DONE") await client.appendNote(write.orderId, `Reverted by ops (${reason}). OpsFlow agent write ${write.idemKey}.`, `${write.idemKey}:revert`);
  await prisma.agentConsoleWrite.update({ where: { id: writeId }, data: { status: "REVERTED", revertedById: userId } });
  if (write.actionId) await prisma.agentAction.update({ where: { id: write.actionId }, data: { outcome: "REVERTED", blockedBy: reason.slice(0, 300) } });
  if (write.journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId: write.journeyId, at: new Date(), kind: "person_action", actor: `PERSON:${userId}`, applied: false, payload: { reverted: write.transition, reason } } });
}
