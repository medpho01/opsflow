/**
 * GET /api/engine/logs?page=1&limit=20
 * Recent polling log entries for the engine health dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "20", 10));

  const [logs, total] = await Promise.all([
    prisma.pollingLog.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pollingLog.count(),
  ]);

  // Aggregate stats for the header
  const last24h = new Date(Date.now() - 86_400_000);
  const recentStats = await prisma.pollingLog.aggregate({
    where: { startedAt: { gte: last24h } },
    _count: { id: true },
    _sum: { ordersFound: true, tasksCreated: true },
    _avg: { durationMs: true },
  });

  const errorCount24h = await prisma.pollingLog.count({
    where: { startedAt: { gte: last24h }, status: "ERROR" },
  });

  return NextResponse.json({
    logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    stats24h: {
      cycles: recentStats._count.id,
      errors: errorCount24h,
      ordersFound: recentStats._sum.ordersFound ?? 0,
      tasksCreated: recentStats._sum.tasksCreated ?? 0,
      avgDurationMs: Math.round(recentStats._avg.durationMs ?? 0),
    },
  });
}
