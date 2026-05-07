/**
 * GET /api/analytics/agents?range=today|week|month
 * Per-agent performance metrics for the Ops Head analytics dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";

function getRangeStart(range: string): Date {
  const now = new Date();
  if (range === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === "month") {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // today
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calculateRosterStatus(
  teamMember: any,
  now: Date
): string {
  // Check if there's an exception for today
  if (teamMember?.rosterExceptions && teamMember.rosterExceptions.length > 0) {
    return teamMember.rosterExceptions[0].status;
  }

  // Check weekly schedule for today
  if (!teamMember?.weeklySchedules || teamMember.weeklySchedules.length === 0) {
    return "OFF"; // No schedule configured
  }

  // Get day of week (0 = Sunday, 6 = Saturday)
  const dayOfWeek = now.getDay();
  const todaySchedule = teamMember.weeklySchedules.find(
    (s: any) => s.dayOfWeek === dayOfWeek
  );

  if (!todaySchedule || !todaySchedule.isWorking) {
    return "OFF";
  }

  // Parse times and check if current time is within working hours
  const [startHour, startMin] = todaySchedule.startTime.split(":").map(Number);
  const [endHour, endMin] = todaySchedule.endTime.split(":").map(Number);
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();

  const startTotalMin = startHour * 60 + startMin;
  const endTotalMin = endHour * 60 + endMin;
  const currentTotalMin = currentHour * 60 + currentMin;

  // Check if in break time
  if (todaySchedule.breakStartTime && todaySchedule.breakEndTime) {
    const [breakStartHour, breakStartMin] = todaySchedule.breakStartTime
      .split(":")
      .map(Number);
    const [breakEndHour, breakEndMin] = todaySchedule.breakEndTime
      .split(":")
      .map(Number);
    const breakStartTotalMin = breakStartHour * 60 + breakStartMin;
    const breakEndTotalMin = breakEndHour * 60 + breakEndMin;

    if (currentTotalMin >= breakStartTotalMin && currentTotalMin < breakEndTotalMin) {
      return "OFF"; // On break
    }
  }

  // Check if within working hours
  if (currentTotalMin >= startTotalMin && currentTotalMin < endTotalMin) {
    return "ACTIVE";
  }

  return "OFF";
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") ?? "today";
  const since = getRangeStart(range);
  const now = new Date();

  // Get all agents + store admins with their team member data
  const agents = await prisma.user.findMany({
    where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
    include: {
      teamMember: {
        include: {
          storeAssignments: { select: { storeId: true } },
          weeklySchedules: true,
          rosterExceptions: {
            where: {
              date: {
                gte: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
                lt: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1)),
              },
            },
          },
        },
      },
      assignedTasks: {
        where: {
          OR: [
            { completedAt: { gte: since } },
            { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
          ],
        },
        select: {
          id: true,
          status: true,
          priority: true,
          slaDeadline: true,
          slaBreachedAt: true,
          assignedAt: true,
          completedAt: true,
          createdAt: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const metrics = agents.map((agent) => {
    const tasks = agent.assignedTasks;

    const completedInRange = tasks.filter(
      (t) => t.status === TaskStatus.COMPLETED && t.completedAt && t.completedAt >= since
    );

    const openTasks = tasks.filter(
      (t) => t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.CANCELLED
    );

    const breachedInRange = tasks.filter(
      (t) => t.slaBreachedAt && t.slaBreachedAt >= since
    );

    // SLA compliance: completed in range without breach
    const compliantInRange = completedInRange.filter((t) => !t.slaBreachedAt);
    const slaCompliance =
      completedInRange.length > 0
        ? Math.round((compliantInRange.length / completedInRange.length) * 100)
        : 0;

    // Average completion time (minutes)
    const completionTimes = completedInRange
      .filter((t) => t.assignedAt && t.completedAt)
      .map((t) => (t.completedAt!.getTime() - t.assignedAt!.getTime()) / 60_000);
    const avgCompletionMinutes =
      completionTimes.length > 0
        ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length)
        : null;

    // Urgent/high breaches
    const urgentBreaches = breachedInRange.filter(
      (t) => t.priority === "URGENT" || t.priority === "HIGH"
    ).length;

    return {
      userId: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      rosterStatus: calculateRosterStatus(agent.teamMember, now),
      maxConcurrentTasks: agent.teamMember?.maxConcurrentTasks ?? 5,
      storeIds: agent.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
      // metrics
      completedCount: completedInRange.length,
      openCount: openTasks.length,
      breachedCount: breachedInRange.length,
      urgentBreaches,
      slaCompliance,
      avgCompletionMinutes,
      // load %
      loadPercent:
        (agent.teamMember?.maxConcurrentTasks ?? 5) > 0
          ? Math.round((openTasks.length / (agent.teamMember?.maxConcurrentTasks ?? 5)) * 100)
          : 0,
    };
  });

  // Sort by completed desc then sla compliance desc
  metrics.sort((a, b) => b.completedCount - a.completedCount || b.slaCompliance - a.slaCompliance);

  return NextResponse.json({ metrics, range, since: since.toISOString() });
}
