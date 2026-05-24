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

    // Aggregate counts over the last 24h for the "Polls: N total · ✓ · ✗"
    // widget. Three parallel COUNTs — no row materialisation.
    const since24h = new Date(Date.now() - 24 * 60 * 60_000);
    const [totalPolls, successfulPolls, failedPolls] = await Promise.all([
      prisma.dataSourcePollingLog.count({
        where: { dataSourceId: id, pollStartedAt: { gte: since24h } },
      }),
      prisma.dataSourcePollingLog.count({
        where: { dataSourceId: id, pollStartedAt: { gte: since24h }, status: "SUCCESS" },
      }),
      prisma.dataSourcePollingLog.count({
        where: { dataSourceId: id, pollStartedAt: { gte: since24h }, status: "ERROR" },
      }),
    ]);

    // Open SOURCE_HEALTH alerts for this source — used by the UI to render
    // a health badge alongside polling status. We can't query by entityId
    // (Alert.entityId is Int and DataSource.id is a cuid) so we filter in JS
    // using metadata.dataSourceId. Cheap because the alerts table is small.
    const openHealthAlerts = await prisma.alert.findMany({
      where: {
        alertType: "SOURCE_HEALTH",
        entityType: "DATA_SOURCE",
        status: { in: ["PENDING", "SENT"] },
      },
      select: {
        id: true,
        severity: true,
        message: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const healthAlertsForSource = openHealthAlerts.filter((a) => {
      const md = a.metadata as { dataSourceId?: string } | null;
      return md?.dataSourceId === id;
    });

    const status: PollingStatus & { health: { isHealthy: boolean; openAlerts: typeof healthAlertsForSource } } = {
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
      totalPolls,
      successfulPolls,
      failedPolls,
      health: {
        isHealthy: healthAlertsForSource.length === 0,
        openAlerts: healthAlertsForSource,
      },
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
