/** GET /api/agents/risk?day=today|tomorrow — the at-risk list (FR-16.5, 16.6), sorted by slot. */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, tz } from "@/lib/agents/api";

export const GET = agentsRoute("risk", async (request, { requestId }) => {
  const day = request.nextUrl.searchParams.get("day") === "tomorrow" ? 1 : 0;
  const now = new Date();
  const dayKey = new Date(now.getTime() + day * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz() });
  const journeys = await prisma.agentJourney.findMany({ where: { closedAt: null, riskLevel: { in: ["MEDIUM", "HIGH"] } }, select: { id: true, orderId: true, labId: true, storeId: true, health: true, riskLevel: true, riskReasons: true, waitingFor: true, dueAt: true, consoleSnapshot: true, actions: { where: { action: { in: ["ask", "reminder", "manager_whatsapp", "create_task", "store_warning", "call"] } }, orderBy: { createdAt: "desc" }, take: 3, select: { action: true, outcome: true, createdAt: true, blockedBy: true } } } });
  const items = journeys
    .map((j) => { const s = (j.consoleSnapshot ?? {}) as Record<string, unknown>; return { ...j, snap: s, slot: s.appointmentTime ? new Date(String(s.appointmentTime)) : null }; })
    .filter((j) => j.slot && j.slot.toLocaleDateString("en-CA", { timeZone: tz() }) === dayKey)
    .sort((a, b) => (a.slot!.getTime() - b.slot!.getTime()) || (a.riskLevel === "HIGH" ? -1 : 1))
    .map((j) => ({
      orderId: j.orderId, patientName: (j.snap.patientName as string | null) ?? null, storeName: (j.snap.storeName as string | null) ?? null, labName: (j.snap.labName as string | null) ?? null,
      slot: j.slot, riskLevel: j.riskLevel, reasons: j.riskReasons, health: j.health, waitingFor: j.waitingFor,
      did: j.actions.map((a) => `${a.action.replace("_", " ")} ${a.outcome === "EXECUTED" ? "" : `(${a.outcome.toLowerCase()}${a.blockedBy ? `: ${a.blockedBy}` : ""})`}`.trim()),
    }));
  return NextResponse.json({ day: dayKey, items, counts: { high: items.filter((i) => i.riskLevel === "HIGH").length, medium: items.filter((i) => i.riskLevel === "MEDIUM").length }, timeZone: tz(), requestId });
});
