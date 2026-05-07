/**
 * Agent Assignment Info API
 * GET /api/assignments/agents/{id} - Get agent availability and assignment info
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { getAgentAvailability } from "@/lib/task-creation/roster-validator";

/**
 * GET /api/assignments/agents/{id}
 * Get agent availability and current assignment info
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionFromRequest(req);

    // OPS_HEAD or STORE_ADMIN can view agent info
    if (!user || ![UserRole.OPS_HEAD, UserRole.STORE_ADMIN].includes(user.role)) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const teamMemberId = Number(id);

    if (isNaN(teamMemberId)) {
      return NextResponse.json(
        { error: "Invalid team member ID", code: "INVALID_ID" },
        { status: 400 }
      );
    }

    // Get team member
    const member = await prisma.teamMember.findUnique({
      where: { id: teamMemberId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        assignedTasks: {
          where: {
            status: { notIn: ["COMPLETED", "CANCELLED"] },
          },
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            slaDeadline: true,
          },
          take: 10,
        },
        storeAssignments: {
          select: { storeId: true },
        },
      },
    });

    if (!member) {
      return NextResponse.json(
        { error: "Team member not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Get availability for today and next 7 days
    const availabilities = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);

      const availability = await getAgentAvailability(teamMemberId, date);
      availabilities.push({
        date: date.toISOString().split("T")[0],
        available: availability.available,
        status: availability.status,
        workingHours: availability.workingHours,
      });
    }

    return NextResponse.json({
      agent: {
        id: member.id,
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        role: member.user.role,
        isActive: member.isActive,
        maxConcurrentTasks: member.maxConcurrentTasks,
        storeIds: member.storeAssignments.map((s) => s.storeId),
      },
      workload: {
        currentTasks: member.assignedTasks.length,
        maxCapacity: member.maxConcurrentTasks,
        utilizationPercent: Math.round(
          (member.assignedTasks.length / member.maxConcurrentTasks) * 100
        ),
        overCapacity: member.assignedTasks.length > member.maxConcurrentTasks,
      },
      currentTasks: member.assignedTasks,
      availability: {
        next7Days: availabilities,
      },
    });
  } catch (error) {
    console.error("[AgentAssignmentAPI] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch agent info",
        code: "FETCH_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
