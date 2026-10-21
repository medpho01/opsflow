/**
 * GET /api/agents/journeys — open journeys, worst first.
 *   ?health=BREACHED|AT_RISK|ON_TRACK  ?labId=  ?storeId=  ?closed=1  ?limit=
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const HEALTH_ORDER: Record<string, number> = { BREACHED: 0, AT_RISK: 1, ON_TRACK: 2 };

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const q = request.nextUrl.searchParams;
    const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 200)));
    const where = {
      ...(q.get("closed") === "1" ? { closedAt: { not: null } } : { closedAt: null }),
      ...(q.get("health") ? { health: q.get("health")! } : {}),
      ...(q.get("labId") ? { labId: Number(q.get("labId")) } : {}),
      ...(q.get("storeId") ? { storeId: Number(q.get("storeId")) } : {}),
    };
    const [rows, counts, actions] = await Promise.all([
      prisma.agentJourney.findMany({
        where, take: limit, orderBy: [{ dueAt: "asc" }],
        select: {
          id: true, orderId: true, orderType: true, labId: true, storeId: true, stage: true, subStates: true, waitingFor: true, dueAt: true,
          nextCheckAt: true, health: true, riskLevel: true, ownerUserId: true, pausedUntil: true, consoleSnapshot: true, openedAt: true, closedAt: true, closeReason: true,
        },
      }),
      prisma.agentJourney.groupBy({ by: ["health"], where: { closedAt: null }, _count: { _all: true } }),
      prisma.agentAction.groupBy({ by: ["outcome"], where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } }, _count: { _all: true } }),
    ]);
    const journeys = rows
      .map((r) => {
        const snap = (r.consoleSnapshot ?? {}) as Record<string, unknown>;
        return {
          id: r.id, orderId: r.orderId, orderType: r.orderType, labId: r.labId, storeId: r.storeId, stage: r.stage, subStates: r.subStates,
          waitingFor: r.waitingFor, dueAt: r.dueAt, nextCheckAt: r.nextCheckAt, health: r.health, riskLevel: r.riskLevel,
          owner: r.ownerUserId != null && r.pausedUntil && r.pausedUntil > new Date() ? { userId: r.ownerUserId, until: r.pausedUntil } : null,
          patientName: (snap.patientName as string | null) ?? null, labName: (snap.labName as string | null) ?? null, storeName: (snap.storeName as string | null) ?? null,
          appointmentTime: (snap.appointmentTime as string | null) ?? null, openedAt: r.openedAt, closedAt: r.closedAt, closeReason: r.closeReason,
        };
      })
      .sort((a, b) => (HEALTH_ORDER[a.health] ?? 3) - (HEALTH_ORDER[b.health] ?? 3) || (Date.parse(String(a.dueAt ?? "")) || 0) - (Date.parse(String(b.dueAt ?? "")) || 0));
    return NextResponse.json({
      journeys,
      counts: Object.fromEntries(counts.map((c) => [c.health, c._count._all])),
      actions24h: Object.fromEntries(actions.map((a) => [a.outcome, a._count._all])),
      timeZone: process.env.TIMEZONE || "Asia/Kolkata",
      requestId,
    });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "AgentsAPI.journeys", code: "AGENTS_LIST_FAILED", userMessage: "Could not load journeys", error }), { status: 500 });
  }
}
