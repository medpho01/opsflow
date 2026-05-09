/**
 * GET /api/dashboard — aggregate stats for Ops Head command center
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { TaskStatus, UserRole } from "@prisma/client";
import { fetchAllActiveOrders } from "@/lib/engine/labstack";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const warningThreshold = new Date(now.getTime() + 10 * 60_000); // 10 min

  const [
    activeOrders,
    openTasksCount,
    breachedCount,
    warningCount,
    unassignedCount,
    totalDoneToday,
    totalBreachedToday,
    riskTasks,
    teamStatus,
    recentAlerts,
    lastPoll,
    sourceStats,
  ] = await Promise.all([
    // Active labstack orders count
    fetchAllActiveOrders().then((o) => o.length).catch(() => 0),

    // Open tasks
    prisma.task.count({
      where: {
        isArchived: false,
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
      },
    }),

    // Breached tasks
    prisma.task.count({ where: { isArchived: false, status: TaskStatus.BREACHED } }),

    // Warning: near SLA
    prisma.task.count({
      where: {
        isArchived: false,
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.BREACHED] },
        slaDeadline: { gt: now, lte: warningThreshold },
      },
    }),

    // Unassigned
    prisma.task.count({
      where: {
        isArchived: false,
        status: TaskStatus.CREATED,
        assignedToId: null,
      },
    }),

    // Completed today
    prisma.task.count({
      where: {
        isArchived: false,
        status: TaskStatus.COMPLETED,
        completedAt: { gte: new Date(now.setHours(0, 0, 0, 0)) },
      },
    }),

    // Breached today
    prisma.task.count({
      where: {
        isArchived: false,
        slaBreachedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),

    // Risk zone: breached or near-breach, with task + assignee
    prisma.task.findMany({
      where: {
        isArchived: false,
        status: { in: [TaskStatus.BREACHED, TaskStatus.CREATED, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] },
        OR: [
          { status: TaskStatus.BREACHED },
          { slaDeadline: { lte: warningThreshold } },
        ],
      },
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: [{ status: "asc" }, { slaDeadline: "asc" }],
      take: 20,
    }),

    // Team status
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        teamMember: {
          include: {
            storeAssignments: { select: { storeId: true } },
            dailyRosters: {
              where: {
                date: {
                  gte: new Date(new Date().setHours(0, 0, 0, 0)),
                  lt: new Date(new Date().setHours(23, 59, 59, 999)),
                },
              },
              take: 1,
            },
          },
        },
        assignedTasks: {
          where: {
            isArchived: false,
            status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
          },
          select: { id: true },
        },
      },
    }),

    // Recent unread alerts
    prisma.alert.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { task: { select: { id: true, title: true, entityId: true } } },
    }),

    // Last poll log
    prisma.pollingLog.findFirst({ orderBy: { startedAt: "desc" } }),

    // Per-source open task counts: walk DataSource → TaskRule[] → tasks.
    // (The legacy TaskRuleSourceScope join table is unused; rules now FK
    // directly to dataSources via TaskRule.dataSourceId.)
    prisma.dataSource.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        taskRules: {
          select: {
            _count: {
              select: {
                tasks: {
                  where: { isArchived: false, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const now2 = new Date();
  const slaHealth =
    openTasksCount > 0
      ? Math.round(((openTasksCount - breachedCount) / openTasksCount) * 100)
      : 100;

  // Shape risk items
  const riskItems = riskTasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    priority: t.priority,
    status: t.status,
    entityId: t.entityId,
    orderType: t.orderType,
    storeId: t.storeId,
    slaDeadline: t.slaDeadline,
    slaBreachedAt: t.slaBreachedAt,
    assignedTo: t.assignedTo ? { id: t.assignedTo.id, name: t.assignedTo.name } : null,
    metadata: t.metadata as Record<string, unknown>,
    minutesRemaining: Math.round((t.slaDeadline.getTime() - now2.getTime()) / 60_000),
  }));

  // Shape team status
  const team = teamStatus.map((u) => ({
    userId: u.id,
    name: u.name,
    role: u.role,
    rosterStatus: u.teamMember?.dailyRosters?.[0]?.status ?? "OFF",
    openTasks: u.assignedTasks.length,
    maxTasks: u.teamMember?.maxConcurrentTasks ?? 5,
    storeIds: u.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
  }));

  // Shape per-source stats — sum open-task counts across all rules tied to the source.
  const shapedSourceStats = sourceStats.map((ds) => ({
    sourceId: ds.sourceId,
    displayName: ds.displayName,
    openTasks: ds.taskRules.reduce(
      (sum, rule) => sum + (rule._count?.tasks ?? 0),
      0
    ),
  }));

  return NextResponse.json({
    stats: {
      activeOrders,
      openTasks: openTasksCount,
      breachedTasks: breachedCount,
      warningTasks: warningCount,
      slaHealthPercent: slaHealth,
      unassignedTasks: unassignedCount,
      completedToday: totalDoneToday,
      breachedToday: totalBreachedToday,
    },
    sourceStats: shapedSourceStats,
    riskItems,
    team,
    recentAlerts,
    lastPollAt: lastPoll?.finishedAt ?? null,
  });
}
