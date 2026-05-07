/**
 * Data Source Polling Status API
 * GET /api/data-sources/{id}/polling-status - Get polling status for a data source
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { PollingStatus } from "@/types/multi-source";

/**
 * GET /api/data-sources/{id}/polling-status
 * Get polling status and recent polling history for a data source
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionFromRequest(req);

    // Only OPS_HEAD can view polling status
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Get data source
    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!dataSource) {
      return NextResponse.json(
        { error: "Data source not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Get last poll
    const lastPoll = await prisma.dataSourcePollingLog.findFirst({
      where: { dataSourceId: id },
      orderBy: { pollCompletedAt: "desc" },
    });

    // Get recent polls (last 10)
    const recentPolls = await prisma.dataSourcePollingLog.findMany({
      where: { dataSourceId: id },
      orderBy: { pollStartedAt: "desc" },
      take: 10,
    });

    const status: PollingStatus = {
      sourceId: dataSource.sourceId,
      displayName: dataSource.displayName,
      isActive: dataSource.isActive,
      pollingIntervalMinutes: dataSource.pollingIntervalMinutes,
      lastPoll: lastPoll
        ? {
            startedAt: lastPoll.pollStartedAt,
            completedAt: lastPoll.pollCompletedAt ?? undefined,
            status: lastPoll.status,
            entitiesFound: lastPoll.entitiesFound,
            tasksCreated: lastPoll.tasksCreated,
            errorMessage: lastPoll.errorMessage ?? undefined,
          }
        : undefined,
      recentPolls: recentPolls.map((poll) => ({
        startedAt: poll.pollStartedAt,
        status: poll.status,
        tasksCreated: poll.tasksCreated,
      })),
    };

    return NextResponse.json(status);
  } catch (error) {
    console.error("[PollingStatusAPI] GET error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch polling status",
        code: "FETCH_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
