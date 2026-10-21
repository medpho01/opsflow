/**
 * Closing the loop on tasks (FR-10.3): when a person marks an agent task
 * done, the agent checks the console shows the change, closes the task's
 * journey side (an event and, where asked, a store or lab message), or
 * reopens the task with "not seen in the console yet". Runs every 5 minutes
 * and on a task's completion.
 */
import { TaskStatus } from "@prisma/client";
import prisma from "@/lib/db/client";
import { fetchOrderSnapshots } from "../journey/window";
import { reached } from "../journey/policy";
import { AGENT_RULE_ID, type AgentTaskPayload } from "./tasks";
import { recordJourneyEvent } from "../journey/run";

export type VerifyResult = { checked: number; verified: number; reopened: number; waiting: number };

const REOPEN_AFTER_MIN = 20;

export async function verifyAgentTasks(now = new Date()): Promise<VerifyResult> {
  const result: VerifyResult = { checked: 0, verified: 0, reopened: 0, waiting: 0 };
  const tasks = await prisma.task.findMany({
    where: { taskRuleId: AGENT_RULE_ID, status: TaskStatus.COMPLETED, isArchived: false, metadata: { path: ["agent", "verifiedAt"], equals: "" } },
    select: { id: true, entityId: true, completedAt: true, metadata: true },
    take: 200,
  }).catch(() => []);
  // Prisma's JSON path filter cannot test "missing", so read completed agent tasks and filter in code.
  const candidates = tasks.length ? tasks : await prisma.task.findMany({
    where: { taskRuleId: AGENT_RULE_ID, status: TaskStatus.COMPLETED, isArchived: false, completedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
    select: { id: true, entityId: true, completedAt: true, metadata: true }, take: 300,
  });
  const open = candidates.filter((t) => { const a = (t.metadata as { agent?: { verifiedAt?: string; reopened?: boolean } } | null)?.agent; return a && !a.verifiedAt; });
  if (!open.length) return result;
  const snaps = await fetchOrderSnapshots(open.map((t) => t.entityId));
  for (const t of open) {
    result.checked += 1;
    const meta = t.metadata as { agent: AgentTaskPayload & { type?: string; idemKey?: string; reopened?: boolean; verifiedAt?: string } };
    const order = snaps.get(t.entityId);
    const verify = meta.agent.verify ?? { kind: "none" };
    let ok = false;
    if (!order) ok = verify.kind === "none";
    else switch (verify.kind) {
      case "none": ok = true; break;
      case "status_at_least": ok = reached(order.orderStatus, String(verify.value)) || (String(verify.value) === "PATIENT_MISSED" && order.orderStatus === "PATIENT_MISSED"); break;
      case "slot_equals": ok = !!order.appointmentTime && Math.abs(order.appointmentTime.getTime() - Date.parse(String(verify.value))) < 60_000; break;
      case "lab_not": ok = order.labId !== Number(verify.value); break;
      case "lab_is_real": ok = order.labId != null && order.labId !== 1; break;
      case "report_delivered": ok = order.orderStatus === "REPORT_DELIVERED"; break;
    }
    if (ok) {
      await prisma.task.update({ where: { id: t.id }, data: { metadata: { ...(t.metadata as object), agent: { ...meta.agent, verifiedAt: now.toISOString() } } } });
      await recordJourneyEvent(t.entityId, { kind: "task_verified", at: now, actor: "SYSTEM", payload: { taskId: t.id, type: meta.agent.type, cause: meta.agent.cause } }, true);
      result.verified += 1;
    } else if (t.completedAt && now.getTime() - t.completedAt.getTime() > REOPEN_AFTER_MIN * 60_000 && !meta.agent.reopened) {
      await prisma.task.update({
        where: { id: t.id },
        data: { status: TaskStatus.IN_PROGRESS, completedAt: null, metadata: { ...(t.metadata as object), agent: { ...meta.agent, reopened: true } }, history: { create: { status: TaskStatus.IN_PROGRESS, note: "Reopened by OpsFlow Agents: the console does not show the change yet" } } },
      });
      result.reopened += 1;
    } else result.waiting += 1;
  }
  return result;
}
