/**
 * Member Performance Metrics
 *
 * Queries the Task table to calculate:
 * - Tasks assigned/completed/cancelled
 * - SLA compliance percentage
 * - Average completion time
 *
 * Period support: week, month, alltime
 */

import prisma from "@/lib/db/client";
import { MemberPerformanceStats } from "@/types";

function formatCompletionTime(minutes: number): string {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

/**
 * Calculate performance stats for a single team member
 */
export async function getMemberStats(
  memberId: number,
  period: "week" | "month" | "alltime" = "month"
): Promise<MemberPerformanceStats | null> {
  try {
    // Get team member and user info
    const teamMember = await prisma.teamMember.findUnique({
      where: { id: memberId },
      include: { user: true },
    });

    if (!teamMember) {
      return null;
    }

    // Calculate date range based on period
    const now = new Date();
    const startDate = new Date();

    if (period === "week") {
      startDate.setDate(now.getDate() - 7);
    } else if (period === "month") {
      startDate.setMonth(now.getMonth() - 1);
    } else {
      // alltime: set to far past
      startDate.setFullYear(1900);
    }

    // Query tasks for this member in the period
    const tasks = await prisma.task.findMany({
      where: {
        assignedToId: teamMember.userId,
        createdAt: { gte: startDate },
      },
      select: {
        status: true,
        completedAt: true,
        assignedAt: true,
        slaDeadline: true,
      },
    });

    // Calculate metrics
    const completed = tasks.filter((t) => t.status === "COMPLETED");
    const cancelled = tasks.filter((t) => t.status === "CANCELLED");
    const assigned = tasks.length;

    let slaBreaches = 0;
    let totalCompletionTimeMs = 0;

    for (const task of completed) {
      // Count SLA breaches
      if (task.completedAt && task.slaDeadline) {
        if (task.completedAt > task.slaDeadline) {
          slaBreaches++;
        }
      }

      // Calculate total completion time
      if (task.assignedAt && task.completedAt) {
        totalCompletionTimeMs +=
          task.completedAt.getTime() - task.assignedAt.getTime();
      }
    }

    const avgCompletionTimeMinutes =
      completed.length > 0 ? totalCompletionTimeMs / completed.length / (1000 * 60) : 0;

    const slaCompliancePercent =
      completed.length > 0
        ? ((completed.length - slaBreaches) / completed.length) * 100
        : 0;

    const completionRate = assigned > 0 ? (completed.length / assigned) * 100 : 0;

    return {
      teamMemberId: memberId,
      memberName: teamMember.user.name,
      period,
      tasksAssigned: assigned,
      tasksCompleted: completed.length,
      tasksCancelled: cancelled.length,
      slaBreaches,
      slaCompliancePercent: Math.round(slaCompliancePercent * 10) / 10,
      avgCompletionTimeMinutes: Math.round(avgCompletionTimeMinutes * 10) / 10,
      avgCompletionTimeHours: formatCompletionTime(avgCompletionTimeMinutes),
      completionRate: Math.round(completionRate * 10) / 10,
    };
  } catch (error) {
    console.error(
      `Error calculating performance stats for member ${memberId}:`,
      error
    );
    throw error;
  }
}

/**
 * Get performance stats for multiple team members
 */
export async function getTeamStats(
  memberIds: number[],
  period: "week" | "month" | "alltime" = "month"
): Promise<MemberPerformanceStats[]> {
  const stats: MemberPerformanceStats[] = [];

  for (const memberId of memberIds) {
    const stat = await getMemberStats(memberId, period);
    if (stat) {
      stats.push(stat);
    }
  }

  return stats;
}
