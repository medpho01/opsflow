/**
 * GET /api/agents/settings — kill switches and worker health.
 * PUT /api/agents/settings — { pausedAll?, pausedDesks?, pausedLabIds?, pausedStoreIds? } (OPS_HEAD), FR-13.5.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { agentsRoute, bad } from "@/lib/agents/api";

export const GET = agentsRoute("settings", async (_request, { requestId }) => {
  const [settings, lastSweep, queued, failed, gateway, portals, cost] = await Promise.all([
    prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } }),
    prisma.agentJourney.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.agentOutboxItem.count({ where: { status: "QUEUED" } }),
    prisma.agentOutboxItem.count({ where: { status: "FAILED", createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.waGateway.findUnique({ where: { id: "default" }, select: { status: true, connectedNumber: true, lastSeenAt: true, dryRun: true } }),
    prisma.agentPortalSession.findMany(),
    prisma.agentAction.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) }, costPaise: { not: null } }, _sum: { costPaise: true }, _count: { _all: true } }),
  ]);
  return NextResponse.json({
    settings, worker: { lastActivityAt: lastSweep?.updatedAt ?? null, alive: !!lastSweep && Date.now() - lastSweep.updatedAt.getTime() < 3 * 60_000 },
    outbox: { queued, failed24h: failed }, gateway, portals, cost24h: { paise: cost._sum.costPaise ?? 0, modelCalls: cost._count._all }, requestId,
  });
});

export const PUT = agentsRoute("settings", async (request, { requestId }) => {
  const body = await request.json().catch(() => ({})) as { pausedAll?: boolean; pausedDesks?: string[]; pausedLabIds?: number[]; pausedStoreIds?: number[] };
  if (body.pausedAll !== undefined && typeof body.pausedAll !== "boolean") return bad(requestId, "pausedAll must be a boolean");
  const settings = await prisma.agentSettings.upsert({
    where: { id: "default" },
    update: { ...(body.pausedAll !== undefined ? { pausedAll: body.pausedAll } : {}), ...(body.pausedDesks ? { pausedDesks: body.pausedDesks } : {}), ...(body.pausedLabIds ? { pausedLabIds: body.pausedLabIds.map(Number) } : {}), ...(body.pausedStoreIds ? { pausedStoreIds: body.pausedStoreIds.map(Number) } : {}) },
    create: { id: "default", pausedAll: body.pausedAll ?? false, pausedDesks: body.pausedDesks ?? [], pausedLabIds: body.pausedLabIds ?? [], pausedStoreIds: body.pausedStoreIds ?? [] },
  });
  return NextResponse.json({ ok: true, settings, requestId });
}, { headOnly: true });
