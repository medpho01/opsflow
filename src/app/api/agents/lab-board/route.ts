/** GET /api/agents/lab-board — per lab: today's orders by checkpoint, open asks, promises due, coordinator silence, portal session (DESIGN.md §7.4). */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, tz } from "@/lib/agents/api";
import { loadDirectory } from "@/lib/agents/directory";
import { labSilence } from "@/lib/agents/journey/detector";

const COLS = ["confirmed", "phlebo_assigned", "sample_collected", "sample_at_lab", "report_delivered"] as const;

export const GET = agentsRoute("lab-board", async (_request, { requestId }) => {
  const now = new Date();
  const dayKey = now.toLocaleDateString("en-CA", { timeZone: tz() });
  const dir = await loadDirectory();
  const journeys = await prisma.agentJourney.findMany({ where: { closedAt: null, labId: { not: null } }, select: { orderId: true, labId: true, health: true, riskLevel: true, consoleSnapshot: true, checkpoints: { select: { name: true, status: true, dueAt: true } } } });
  const today = journeys.filter((j) => { const t = (j.consoleSnapshot as { appointmentTime?: string } | null)?.appointmentTime; return t && new Date(t).toLocaleDateString("en-CA", { timeZone: tz() }) === dayKey; });
  const labIds = [...new Set(today.map((j) => j.labId!))];
  const [asks, promises, portals, silence] = await Promise.all([
    prisma.agentOutboxItem.groupBy({ by: ["counterparty"], where: { status: { in: ["QUEUED", "SENT"] }, sentAt: { gte: new Date(now.getTime() - 3 * 3_600_000) } }, _count: { _all: true } }),
    prisma.agentPromise.groupBy({ by: ["labId"], where: { status: "OPEN", dueAt: { lte: new Date(now.getTime() + 3 * 3_600_000) } }, _count: { _all: true } }),
    prisma.agentPortalSession.findMany(),
    labSilence(labIds, now),
  ]);
  const rows = labIds.map((labId) => {
    const lab = dir.labs.get(labId);
    const mine = today.filter((j) => j.labId === labId);
    const cell = (name: string) => {
      const states = mine.map((j) => j.checkpoints.find((c) => c.name === name || (name === "confirmed" && c.name === "visit_confirmed") || (name === "sample_collected" && c.name === "patient_visited")));
      return { met: states.filter((c) => c?.status === "MET" || c?.status === "WAIVED").length, atRisk: states.filter((c) => c && c.status === "PENDING" && c.dueAt.getTime() - now.getTime() <= 15 * 60_000).length, breached: states.filter((c) => c?.status === "BREACHED").length, pending: states.filter((c) => c && c.status === "PENDING" && c.dueAt.getTime() - now.getTime() > 15 * 60_000).length };
    };
    const portal = portals.find((p) => p.labId === labId);
    return {
      labId, labName: lab?.labName ?? String(labId), tier: lab?.tier ?? "C", today: mine.length,
      columns: Object.fromEntries(COLS.map((c) => [c, cell(c)])),
      openAsks: asks.find((a) => a.counterparty === `LAB:${labId}`)?._count._all ?? 0,
      promisesDue: promises.find((p) => p.labId === labId)?._count._all ?? 0,
      silentHours: silence.get(labId) ?? null,
      portal: lab?.hasPortal ? portal?.status ?? "NOT_SET" : null,
      atRisk: mine.filter((j) => j.riskLevel !== "LOW").length,
    };
  }).sort((a, b) => b.today - a.today);
  return NextResponse.json({ day: dayKey, labs: rows, columns: COLS, timeZone: tz(), requestId });
});
