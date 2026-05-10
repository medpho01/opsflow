/**
 * Health Check Endpoint
 * GET /api/health
 *
 * Pure health check — DB connectivity + basic stats.
 * Does NOT start or manage any background services.
 * Background services (legacy poller, archive scheduler) are started
 * exclusively from instrumentation.ts when the server boots.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";

export async function GET(_req: NextRequest) {
  // Check database connectivity
  let dbConnected = false;
  let dbError: string | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  if (!dbConnected) {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        components: { database: { status: "unhealthy", error: dbError } },
      },
      { status: 503 }
    );
  }

  // Lightweight stats — no expensive joins
  const [sourcesCount, activeSources, pendingAlerts, openTasks] = await Promise.all([
    prisma.dataSource.count(),
    prisma.dataSource.count({ where: { isActive: true } }),
    prisma.alert.count({ where: { status: "PENDING" } }),
    prisma.task.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED", "BREACHED"] } } }),
  ]);

  return NextResponse.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    components: {
      database: { status: "healthy" },
      dataSources: { total: sourcesCount, active: activeSources },
      tasks: { open: openTasks },
      alerts: { pending: pendingAlerts },
    },
  });
}
