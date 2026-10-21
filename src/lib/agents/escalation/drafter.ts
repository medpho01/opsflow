/**
 * The Escalation desk's drafter (FR-9.5): for a complaint or an RCA request,
 * the agent builds the order's timeline and drafts the reply and the RCA on
 * the task. A person always sends it. With no model key, the draft is the
 * timeline alone, which is still most of the work.
 */
import prisma from "@/lib/db/client";
import { askModel } from "../llm";

const tz = () => process.env.TIMEZONE || "Asia/Kolkata";

export async function buildTimelineText(orderId: number): Promise<string> {
  const j = await prisma.agentJourney.findUnique({ where: { orderId }, include: { events: { orderBy: { at: "asc" }, take: 200 }, checkpoints: { orderBy: { dueAt: "asc" } }, actions: { orderBy: { createdAt: "asc" }, take: 100, select: { createdAt: true, action: true, outcome: true, reason: true, blockedBy: true } } } });
  if (!j) return `#${orderId}: no journey on record.`;
  const fmt = (d: Date) => d.toLocaleString("en-IN", { timeZone: tz(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const snap = (j.consoleSnapshot ?? {}) as Record<string, unknown>;
  const lines = [`#${orderId} · ${String(snap.storeName ?? "")} · ${String(snap.labName ?? "")} · slot ${snap.appointmentTime ? fmt(new Date(String(snap.appointmentTime))) : "—"} · console ${j.stage}`];
  for (const c of j.checkpoints) lines.push(`checkpoint ${c.name.replace("_", " ")}: ${c.status.toLowerCase()}${c.metAt ? ` at ${fmt(c.metAt)}` : ` (due ${fmt(c.dueAt)})`}`);
  const rows: Array<{ at: Date; text: string }> = [];
  for (const e of j.events) {
    const p = e.payload as Record<string, unknown>;
    const text = e.kind === "console_change" ? `console: ${((p.changes as string[]) ?? []).join(", ").toLowerCase()} → ${String((p.to as { status?: string })?.status ?? "")}` : e.kind === "fact" ? `lab: "${String(p.value ?? "")}" (${String(p.kind)})` : e.kind === "store_message" ? `store: "${String(p.text ?? "")}"` : e.kind === "promise" ? `lab promised ${String(p.kind)} by ${fmt(new Date(String(p.dueAt)))}` : e.kind === "promise_broken" ? `promise broken (${String(p.checkpoint)})` : e.kind === "ask" ? `agent asked the lab (${String(p.ask)})` : e.kind === "task" ? `task #${String(p.taskId)} for a person (${String(p.cause)})` : e.kind;
    rows.push({ at: e.at, text });
  }
  for (const a of j.actions) rows.push({ at: a.createdAt, text: `agent ${a.action.replace("_", " ")}: ${a.outcome.toLowerCase()}${a.blockedBy ? ` (${a.blockedBy})` : ""} — ${a.reason}` });
  rows.sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const r of rows) lines.push(`${fmt(r.at)}  ${r.text}`);
  return lines.join("\n");
}

export async function draftComplaintReply(taskId: number, orderId: number, journeyId: string | null, complaint: string): Promise<void> {
  const timeline = await buildTimelineText(orderId);
  let reply: string | null = null; let rca: string | null = null;
  const answer = await askModel({
    purpose: "drafter", maxTokens: 700, journeyId,
    system: "You draft, for an ops person to review and send, (1) a short, factual, apologetic reply to a client store's complaint about a diagnostics order and (2) a 4-line root-cause note. Use only the timeline given; never invent. Return ONLY JSON {\"reply\":\"...\",\"rca\":\"...\"}.",
    user: `Complaint: """${complaint.slice(0, 600)}"""\n\nTimeline:\n${timeline.slice(0, 4000)}`,
  });
  if (answer) { try { const p = JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1)) as { reply?: string; rca?: string }; reply = p.reply ?? null; rca = p.rca ?? null; } catch { /* keep timeline only */ } }
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { metadata: true } });
  const meta = (task?.metadata ?? {}) as { agent?: Record<string, unknown> };
  await prisma.task.update({ where: { id: taskId }, data: { metadata: { ...meta, agent: { ...(meta.agent ?? {}), draft: { timeline, reply, rca, draftedAt: new Date().toISOString() } } } } });
  if (journeyId) await prisma.agentJourneyEvent.create({ data: { journeyId, at: new Date(), kind: "note", actor: "AGENT", applied: true, payload: { draft: true, taskId, hasReply: !!reply } } });
}
