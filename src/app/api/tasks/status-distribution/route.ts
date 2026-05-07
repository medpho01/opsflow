/**
 * GET /api/tasks/status-distribution
 * Returns count of tasks by status
 * Used by Foundation Feature: Status Distribution Widget
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Get task counts by status
    const counts = await prisma.task.groupBy({
      by: ["status"],
      where: {
        isArchived: false,
        ...(user.role === UserRole.OPS_AGENT ? { assignedToId: user.id } : {}),
      },
      _count: { id: true },
    });

    // Build response with all statuses (0 if none)
    const distribution = {
      CREATED: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      BREACHED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };

    for (const count of counts) {
      distribution[count.status as keyof typeof distribution] = count._count.id;
    }

    return NextResponse.json(distribution);
  } catch (err) {
    console.error("[StatusDistribution] Error:", err);
    return NextResponse.json({ error: "Failed to fetch status distribution" }, { status: 500 });
  }
}
