/**
 * Manual Polling Trigger Endpoint
 * POST /api/data-sources/{id}/manual-poll
 *
 * Allows OPS_HEAD to manually trigger polling for a source
 * Useful for testing or forcing immediate sync
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { triggerManualPolling } from "@/lib/polling/polling-scheduler";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getSessionFromRequest(req);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Get data source
    const dataSource = await prisma.dataSource.findUnique({
      where: { id },
    });

    if (!dataSource) {
      return NextResponse.json({ error: "Data source not found" }, { status: 404 });
    }

    if (!dataSource.isActive) {
      return NextResponse.json({ error: "Data source is inactive" }, { status: 400 });
    }

    console.log(`[ManualPoll] Triggering manual polling for source: ${dataSource.sourceId}`);

    // Trigger manual polling
    await triggerManualPolling(dataSource.sourceId);

    return NextResponse.json({
      success: true,
      message: `Manual polling triggered for ${dataSource.displayName}`,
      sourceId: dataSource.sourceId,
    });
  } catch (error) {
    console.error("[ManualPoll] Error triggering manual poll:", error);
    return NextResponse.json(
      {
        error: "Failed to trigger manual polling",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
