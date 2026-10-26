/**
 * Reads the internal ops group (27 Oct 2026). A reply quoting one of the agent's
 * posts moves what the post was about:
 *   "on it" / "taking" / "will check"  → the task is IN_PROGRESS (the note says who)
 *   "done" / "completed" / "resolved"  → the task is COMPLETED
 * A reply to a post that carries no task (a question, an escalation, a thread
 * reminder) is recorded on the order's timeline as acknowledged. Nothing here
 * assigns a task to anyone: the group decides.
 */
import { TaskStatus } from "@prisma/client";
import prisma from "@/lib/db/client";
import { opsGroup } from "./group";

const TAKE = /\b(on it|taking|take it|i('|’)ll (take|do|handle|check)|will (do|check|handle|take)|checking|looking into)\b/i;
const DONE = /\b(done|completed|resolved|closed|sorted|fixed|updated|uploaded|rescheduled|cancelled)\b/i;
const FIRST_RUN_LOOKBACK_MS = 2 * 3_600_000;

export type OpsReaderResult = { read: number; taken: number; done: number };

export async function runOpsReader(now = new Date()): Promise<OpsReaderResult> {
  const result: OpsReaderResult = { read: 0, taken: 0, done: 0 };
  const group = await opsGroup();
  if (!group) return result;
  const settings = await prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  const since = settings.opsWatermark ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const messages = await prisma.waMessage.findMany({
    where: { groupId: group.id, direction: "IN", fromMe: false, ts: { gt: since, lte: now } },
    orderBy: { ts: "asc" }, take: 200,
    select: { id: true, ts: true, sender: true, text: true, replyToWaId: true },
  });
  if (!messages.length) return result;
  for (const m of messages) {
    result.read += 1;
    const text = (m.text ?? "").trim();
    if (!m.replyToWaId || !text) continue;
    try {
      const outbound = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: m.replyToWaId }, select: { id: true } });
      if (!outbound) continue;
      const item = await prisma.agentOutboxItem.findFirst({ where: { outboundId: outbound.id, counterparty: "OPS" }, select: { ask: true, orderId: true, journeyId: true, payload: true } });
      if (!item) continue;
      const taskId = (item.payload as { taskId?: number | null })?.taskId ?? null;
      const done = DONE.test(text); const take = !done && TAKE.test(text);
      if (taskId) {
        const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
        if (!task) continue;
        const open = !([TaskStatus.COMPLETED, TaskStatus.CANCELLED] as TaskStatus[]).includes(task.status);
        if (done && open) {
          await prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.COMPLETED, completedAt: m.ts, history: { create: { status: TaskStatus.COMPLETED, note: `${m.sender} in the ops group: "${text.slice(0, 120)}"` } } } });
          result.done += 1;
        } else if (take && (task.status === TaskStatus.CREATED || task.status === TaskStatus.ASSIGNED)) {
          await prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.IN_PROGRESS, lastStatusUpdate: m.ts, history: { create: { status: TaskStatus.IN_PROGRESS, note: `${m.sender} took it in the ops group: "${text.slice(0, 120)}"` } } } });
          result.taken += 1;
        }
      }
      if (item.journeyId && (done || take)) {
        await prisma.agentJourneyEvent.create({ data: { journeyId: item.journeyId, at: m.ts, kind: "ops_reply", actor: "OPS", applied: true, payload: { kind: item.ask, sender: m.sender, text: text.slice(0, 300), done, taskId } } }).catch(() => undefined);
      }
    } catch (error) {
      console.error(`[Ops] reading ${m.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  await prisma.agentSettings.update({ where: { id: "default" }, data: { opsWatermark: messages[messages.length - 1].ts } });
  return result;
}
