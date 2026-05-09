/**
 * GET  /api/team  — list team members with today's roster status, order types, and performance stats
 * POST /api/team  — create a new team member (OPS_HEAD only)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { UserRole, TaskStatus } from "@prisma/client";
import { computeRosterStatus } from "@/lib/roster/availability";

async function calculateTaskStats(
  userId: number,
  period: "week" | "month"
): Promise<{ assigned: number; completed: number; slaCompliance: number }> {
  const now = new Date();
  const startDate = new Date();

  if (period === "month") {
    startDate.setMonth(now.getMonth() - 1);
  } else {
    startDate.setDate(now.getDate() - 7);
  }

  const tasks = await prisma.task.findMany({
    where: {
      assignedToId: userId,
      createdAt: { gte: startDate },
      status: { in: ["COMPLETED", "CANCELLED"] },
    },
    select: {
      status: true,
      slaDeadline: true,
      completedAt: true,
    },
  });

  const completed = tasks.filter((t) => t.status === "COMPLETED");
  const assigned = tasks.length;

  let slaBreaches = 0;
  for (const task of completed) {
    if (task.completedAt && task.slaDeadline && task.completedAt > task.slaDeadline) {
      slaBreaches++;
    }
  }

  const slaCompliance =
    completed.length > 0 ? ((completed.length - slaBreaches) / completed.length) * 100 : 0;

  return {
    assigned,
    completed: completed.length,
    slaCompliance: Math.round(slaCompliance * 10) / 10,
  };
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get today's date in local timezone
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const todayString = `${year}-${month}-${day}`;

  // Parse as UTC to get day of week (matching daily roster endpoint)
  const m = todayString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const todayUTC = new Date(Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3])));
  const todayDayOfWeek = todayUTC.getUTCDay(); // 0=Sunday, 1=Monday, etc.

  // Use UTC date for consistent exception matching
  const today = new Date(Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3])));
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const members = await prisma.user.findMany({
    where: { isActive: true, role: { not: UserRole.OPS_HEAD } },
    include: {
      teamMember: {
        include: {
          storeAssignments: { select: { storeId: true } },
          capabilities: { include: { dataSource: { select: { id: true, sourceId: true, displayName: true } } } },
          weeklySchedules: {
            where: { dayOfWeek: todayDayOfWeek },
          },
          rosterExceptions: {
            where: { date: { gte: today, lt: tomorrow } },
            take: 1,
          },
        },
      },
      assignedTasks: {
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { id: true, status: true, priority: true },
      },
    },
    orderBy: { name: "asc" },
  });

  // Fetch today's exceptions separately for frontend button logic
  // TODO: Uncomment when roster_exceptions table is created
  // const todayExceptions = await prisma.rosterException.findMany({
  //   where: { date: { gte: today, lt: tomorrow } },
  //   select: { teamMemberId: true },
  // });
  const exceptionTeamMemberIds = new Set();

  // Enrich response with order types and stats
  const enrichedMembers = await Promise.all(
    members.map(async (member) => {
      const thisMonthStats = await calculateTaskStats(member.id, "month");
      const thisWeekStats = await calculateTaskStats(member.id, "week");

      return {
        id: member.teamMember?.id || 0,
        userId: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        storeId: member.teamMember?.storeAssignments?.[0]?.storeId || 0,
        maxConcurrentTasks: member.teamMember?.maxConcurrentTasks || 5,
        isActive: member.isActive,
        createdAt: member.createdAt,
        capabilities: (member.teamMember?.capabilities || []).map((c) => ({
          dataSourceId: c.dataSourceId,
          dataSource: c.dataSource,
          assignedAt: c.assignedAt,
        })),
        capabilityCount: member.teamMember?.capabilities?.length || 0,
        skills: [],
        skillCount: 0,
        stores: member.teamMember?.storeAssignments?.map((sa) => sa.storeId) || [],
        storeCount: member.teamMember?.storeAssignments?.length || 0,
        currentLoad: member.assignedTasks?.length || 0,
        taskStats: {
          thisMonth: thisMonthStats,
          thisWeek: thisWeekStats,
        },
        hasException: exceptionTeamMemberIds.has(member.teamMember?.id || 0),
        // Roster status — single source of truth: lib/roster/availability.ts
        // (same logic used by pickAssignee for auto-assignment)
        rosterStatus: computeRosterStatus(
          member.teamMember?.weeklySchedules?.[0] ?? null,
          member.teamMember?.rosterExceptions?.[0] ?? null,
          now
        ),
        rosterUpdatedAt: member.teamMember?.rosterExceptions?.[0]?.createdAt,
      };
    })
  );

  return NextResponse.json({ members: enrichedMembers });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { name, email, password, role, storeIds, skillTagIds, maxConcurrentTasks } = body;

  if (!name || !email || !password || !role) {
    return NextResponse.json({ error: "name, email, password, role required" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return NextResponse.json({ error: "Email already exists" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  const newUser = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash,
      role,
      isActive: true,
      teamMember: {
        create: {
          maxConcurrentTasks: maxConcurrentTasks ?? 5,
          storeAssignments: storeIds?.length
            ? { create: storeIds.map((sid: number) => ({ storeId: sid })) }
            : undefined,
          skills: skillTagIds?.length
            ? { create: skillTagIds.map((tid: number) => ({ skillTagId: tid })) }
            : undefined,
        },
      },
    },
    include: { teamMember: true },
  });

  return NextResponse.json({ user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role } }, { status: 201 });
}
