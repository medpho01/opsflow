/**
 * GET /api/analytics/summary?date=YYYY-MM-DD
 * Daily operational summary — used by the summary panel and daily summary cron.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");

  let dayStart: Date;
  let dayEnd: Date;

  if (dateParam) {
    const m = dateParam.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      dayStart = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      dayEnd = new Date(dayStart.getTime() + 86_400_000);
    } else {
      const now = new Date();
      dayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      dayEnd = new Date(dayStart.getTime() + 86_400_000);
    }
  } else {
    const now = new Date();
    dayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    dayEnd = new Date(dayStart.getTime() + 86_400_000);
  }

  const [
    createdToday,
    completedToday,
    breachedToday,
    openCarryover,
    agentStats,
    pollStats,
  ] = await Promise.all([
    // tasks created today
    prisma.task.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),

    // tasks completed today
    prisma.task.count({ where: { status: TaskStatus.COMPLETED, completedAt: { gte: dayStart, lt: dayEnd } } }),

    // tasks breached today
    prisma.task.count({ where: { slaBreachedAt: { gte: dayStart, lt: dayEnd } } }),

    // open (non-terminal) tasks at end of day
    prisma.task.count({
      where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
    }),

    // per-agent completed today
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        assignedTasks: {
          where: {
            status: TaskStatus.COMPLETED,
            completedAt: { gte: dayStart, lt: dayEnd },
          },
          select: { id: true, slaBreachedAt: true },
        },
      },
      orderBy: { name: "asc" },
    }),

    // polling cycles today
    prisma.pollingLog.findMany({
      where: { startedAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { startedAt: "desc" },
      select: { status: true, ordersFound: true, tasksCreated: true, durationMs: true },
    }),
  ]);

  const totalCompleted = completedToday;
  const slaHealth =
    totalCompleted > 0
      ? Math.round(
          (agentStats.reduce(
            (sum, a) => sum + a.assignedTasks.filter((t) => !t.slaBreachedAt).length,
            0
          ) /
            totalCompleted) *
            100
        )
      : 0;

  const agentBreakdown = agentStats
    .map((a) => ({
      name: a.name,
      completed: a.assignedTasks.length,
      slaCompliant: a.assignedTasks.filter((t) => !t.slaBreachedAt).length,
    }))
    .filter((a) => a.completed > 0)
    .sort((a, b) => b.completed - a.completed);

  const pollSummary = {
    cycles: pollStats.length,
    errors: pollStats.filter((p) => p.status === "ERROR").length,
    totalOrders: pollStats.reduce((s, p) => s + p.ordersFound, 0),
    totalTasksCreated: pollStats.reduce((s, p) => s + p.tasksCreated, 0),
    avgDurationMs:
      pollStats.length > 0
        ? Math.round(pollStats.reduce((s, p) => s + (p.durationMs ?? 0), 0) / pollStats.length)
        : 0,
  };

  return NextResponse.json({
    date: dayStart.toISOString().split("T")[0],
    summary: {
      createdToday,
      completedToday,
      breachedToday,
      openCarryover,
      slaHealthPercent: slaHealth,
    },
    agentBreakdown,
    pollSummary,
  });
}
