/**
 * GET /api/agents/inbox — the exception inbox (FR-10.4): review items waiting
 * for a decision, open agent tasks, and FYIs (actions the agent took on its
 * own at "act and notify"), sorted by time to breach × store weight.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, tz } from "@/lib/agents/api";
import { openAgentTasks } from "@/lib/agents/executors/tasks";
import { loadDirectory } from "@/lib/agents/directory";

export const GET = agentsRoute("inbox", async (request, { requestId }) => {
  const now = Date.now();
  const dir = await loadDirectory();
  const weightOf = (storeId: number | null | undefined) => (storeId != null ? dir.stores.get(storeId)?.weight ?? 1 : 1);
  const [reviews, tasks, fyis] = await Promise.all([
    prisma.agentReviewItem.findMany({ where: { decision: null }, orderBy: { createdAt: "asc" }, take: 200 }),
    openAgentTasks(200),
    prisma.agentAction.findMany({ where: { level: "ACT_NOTIFY", outcome: "EXECUTED", createdAt: { gte: new Date(now - 24 * 3_600_000) } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, orderId: true, desk: true, action: true, params: true, reason: true, blockedBy: true, createdAt: true } }),
  ]);
  const journeyIds = [...new Set([...reviews.map((r) => r.orderId), ...tasks.map((t) => t.entityId), ...fyis.map((f) => f.orderId)].filter((x): x is number => x != null))];
  const journeys = journeyIds.length ? await prisma.agentJourney.findMany({ where: { orderId: { in: journeyIds } }, select: { orderId: true, labId: true, storeId: true, dueAt: true, health: true, riskLevel: true, consoleSnapshot: true } }) : [];
  const jBy = new Map(journeys.map((j) => [j.orderId, j]));
  const snap = (orderId: number | null) => { const j = orderId != null ? jBy.get(orderId) : undefined; const s = (j?.consoleSnapshot ?? {}) as Record<string, unknown>; return { patientName: (s.patientName as string | null) ?? null, labName: (s.labName as string | null) ?? null, storeName: (s.storeName as string | null) ?? null, appointmentTime: (s.appointmentTime as string | null) ?? null, health: j?.health ?? null, riskLevel: j?.riskLevel ?? null, dueAt: j?.dueAt ?? null, storeId: j?.storeId ?? null }; };

  type Item = { id: string; kind: "REVIEW" | "TASK" | "FYI"; subkind: string; orderId: number | null; title: string; what: string; action: string; evidence: Array<{ at?: string; text: string }>; dueAt: string | null; minutesToBreach: number | null; weight: number; order: ReturnType<typeof snap>; proposal?: unknown; taskId?: number; assignee?: string | null; consoleUrl?: string | null };
  const items: Item[] = [];
  for (const r of reviews) {
    const o = snap(r.orderId); const p = r.proposal as Record<string, unknown>;
    const dueAt = r.dueAt ?? o.dueAt;
    const title = r.kind === "status_write" ? `Mark #${r.orderId} ${String(p.to ?? "").replace("_", " ").toLowerCase()}?` : r.kind === "store_warning" ? `Warn ${o.storeName ?? "the store"} about #${r.orderId}?` : r.kind === "case_choice" ? `Decide for #${r.orderId}` : `${r.kind.replace("_", " ")} for #${r.orderId}`;
    const ev = p.evidence as { source?: string; value?: string; at?: string } | undefined;
    items.push({ id: r.id, kind: "REVIEW", subkind: r.kind, orderId: r.orderId, title, what: String(p.reason ?? ""), action: r.kind === "status_write" ? `Set ${String(p.to)} in the console` : r.kind === "store_warning" ? "Send the warning to the store group" : "Approve the agent's proposal", evidence: ev ? [{ at: ev.at, text: `${ev.source ?? "evidence"}: "${ev.value ?? ""}"` }] : [], dueAt: dueAt ? new Date(dueAt).toISOString() : null, minutesToBreach: dueAt ? Math.round((new Date(dueAt).getTime() - now) / 60_000) : null, weight: weightOf(r.storeId ?? o.storeId), order: o, proposal: p });
  }
  for (const t of tasks) {
    const o = snap(t.entityId); const a = (t.metadata as { agent?: { cause?: string; evidence?: Array<{ at?: string; text: string }>; action?: string; consoleUrl?: string | null } } | null)?.agent ?? {};
    items.push({ id: `task-${t.id}`, kind: "TASK", subkind: t.taskType?.name ?? "task", orderId: t.entityId, title: t.title, what: (a.cause ?? "").replace(/_/g, " ").toLowerCase(), action: a.action ?? t.title, evidence: a.evidence ?? [], dueAt: t.slaDeadline.toISOString(), minutesToBreach: Math.round((t.slaDeadline.getTime() - now) / 60_000), weight: weightOf(t.storeId ?? o.storeId), order: o, taskId: t.id, assignee: t.assignedTo?.name ?? null, consoleUrl: a.consoleUrl ?? null });
  }
  for (const f of fyis) {
    const o = snap(f.orderId);
    items.push({ id: `fyi-${f.id}`, kind: "FYI", subkind: f.action, orderId: f.orderId, title: `${f.action.replace("_", " ")} on #${f.orderId}`, what: f.reason, action: f.blockedBy ?? "done", evidence: [], dueAt: f.createdAt.toISOString(), minutesToBreach: null, weight: weightOf(o.storeId), order: o });
  }
  items.sort((a, b) => {
    const ka = (a.kind === "FYI" ? 1e9 : (a.minutesToBreach ?? 1e6)) / a.weight;
    const kb = (b.kind === "FYI" ? 1e9 : (b.minutesToBreach ?? 1e6)) / b.weight;
    return ka - kb;
  });
  return NextResponse.json({ items, counts: { review: reviews.length, tasks: tasks.length, fyi: fyis.length, breachSoon: items.filter((i) => i.kind !== "FYI" && i.minutesToBreach != null && i.minutesToBreach <= 30).length }, timeZone: tz(), requestId });
});
