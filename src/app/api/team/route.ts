/**
 * GET  /api/team  — list team members with today's roster status, capabilities, and stats
 * POST /api/team  — create a new team member (OPS_HEAD only)
 *
 * Validation lives in lib/validation/team.ts so POST and PATCH share the
 * same parser (W1.1 — closes the role-enum priv-escalation: previously POST
 * accepted any string for `role`, including "OPS_HEAD").
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { UserRole } from "@prisma/client";
import { computeRosterStatus } from "@/lib/roster/availability";
import { createTeamMemberSchema, zodErrorToTeamResponse } from "@/lib/validation/team";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

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
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });

  // W1.3 — restrict to OPS_HEAD. Was open to any authenticated user; an
  // OPS_AGENT could enumerate peer emails, performance stats, store
  // assignments, current load. Read-only data leak.
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  // W2 — store-first lens: ?storeId=N filters to members assigned to that store.
  const url = new URL(request.url);
  const storeIdParam = url.searchParams.get("storeId");
  const storeIdFilter = storeIdParam ? parseInt(storeIdParam, 10) : null;
  const storeIdFilterValid = storeIdFilter !== null && !isNaN(storeIdFilter) && storeIdFilter > 0;

  // W1.6 — IST midnight edge case. The day-of-week needs to reflect the
  // operator's local calendar, not the UTC calendar. At 04:00 IST Monday,
  // UTC is Sunday 22:30 — we'd lookup Sunday's schedule when the user
  // expects Monday's. Compute day-of-week from local components, then
  // anchor "today" as a UTC midnight for stable DATE-column comparisons.
  const now = new Date();
  const todayDayOfWeek = now.getDay();          // local day-of-week 0–6
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const tomorrowUTC = new Date(todayUTC);
  tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);

  const members = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { not: UserRole.OPS_HEAD },
      // W2 — store filter applied as a relation-some on the join when present
      ...(storeIdFilterValid
        ? { teamMember: { storeAssignments: { some: { storeId: storeIdFilter } } } }
        : {}),
    },
    include: {
      teamMember: {
        include: {
          storeAssignments: { select: { storeId: true } },
          capabilities: { include: { dataSource: { select: { id: true, sourceId: true, displayName: true } } } },
          skills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
          weeklySchedules: { where: { dayOfWeek: todayDayOfWeek } },
          rosterExceptions: {
            where: { date: { gte: todayUTC, lt: tomorrowUTC } },
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

  // W1.5 — restore the actual hasException query. The previous TODO had
  // it commented out and `hasException` was always false; the team UI
  // depends on this for "needs schedule" hints.
  const todayExceptions = await prisma.rosterException.findMany({
    where: { date: { gte: todayUTC, lt: tomorrowUTC } },
    select: { teamMemberId: true },
  });
  const exceptionTeamMemberIds = new Set(todayExceptions.map((e) => e.teamMemberId));

  const enrichedMembers = await Promise.all(
    members.map(async (member) => {
      const thisMonthStats = await calculateTaskStats(member.id, "month");
      const thisWeekStats = await calculateTaskStats(member.id, "week");

      const schedule = member.teamMember?.weeklySchedules?.[0] ?? null;
      const exception = member.teamMember?.rosterExceptions?.[0] ?? null;
      const rosterStatus = computeRosterStatus(schedule, exception, now);

      // W1.7 — surface a head-visible warning when a member has neither a
      // schedule for today's day-of-week nor any exception. computeRosterStatus
      // returns "OFF" in that case (correct), but the head needs a hint that
      // the member is unscheduled rather than affirmatively off.
      const hasSchedule = !!schedule;
      const hasExceptionToday = !!exception;
      const isSilentlyOff = !hasSchedule && !hasExceptionToday && rosterStatus === "OFF";

      return {
        id: member.teamMember?.id || 0,
        userId: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        // W1.4 — return the full storeIds array (not flatten-to-first).
        // Legacy `storeId` retained for old callers but now reflects the
        // first assignment as a string-or-null instead of `0` so it can't
        // collide with a real storeId of 0.
        stores: member.teamMember?.storeAssignments?.map((sa) => sa.storeId) ?? [],
        storeIds: member.teamMember?.storeAssignments?.map((sa) => sa.storeId) ?? [],
        storeCount: member.teamMember?.storeAssignments?.length || 0,
        primaryStoreId: member.teamMember?.storeAssignments?.[0]?.storeId ?? null,
        // Deprecated: kept until UI consumers migrate to primaryStoreId / storeIds[].
        storeId: member.teamMember?.storeAssignments?.[0]?.storeId ?? 0,
        maxConcurrentTasks: member.teamMember?.maxConcurrentTasks || 5,
        isActive: member.isActive,
        createdAt: member.createdAt,
        capabilities: (member.teamMember?.capabilities || []).map((c) => ({
          dataSourceId: c.dataSourceId,
          dataSource: c.dataSource,
          assignedAt: c.assignedAt,
        })),
        capabilityCount: member.teamMember?.capabilities?.length || 0,
        skills: (member.teamMember?.skills || []).map((s) => s.skillTag),
        skillCount: member.teamMember?.skills?.length || 0,
        currentLoad: member.assignedTasks?.length || 0,
        taskStats: {
          thisMonth: thisMonthStats,
          thisWeek: thisWeekStats,
        },
        hasException: exceptionTeamMemberIds.has(member.teamMember?.id || -1),
        rosterStatus,
        isSilentlyOff,
        rosterUpdatedAt: member.teamMember?.rosterExceptions?.[0]?.createdAt,
      };
    })
  );

  return NextResponse.json({
    members: enrichedMembers,
    filters: storeIdFilterValid ? { storeId: storeIdFilter } : undefined,
  });
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  let parsed: import("@/lib/validation/team").CreateTeamMemberInput;
  try {
    parsed = createTeamMemberSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ ...zodErrorToTeamResponse(err), requestId }, { status: 400 });
    }
    throw err;
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: parsed.email } });
    if (existing) {
      return NextResponse.json({ error: "Email already exists", code: "CONFLICT", requestId }, { status: 409 });
    }

    const passwordHash = await hashPassword(parsed.password);

    const newUser = await prisma.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        passwordHash,
        role: parsed.role as UserRole,
        phone: parsed.phone ?? null,
        isActive: true,
        teamMember: {
          create: {
            maxConcurrentTasks: parsed.maxConcurrentTasks,
            storeAssignments: parsed.storeIds.length
              ? { create: parsed.storeIds.map((sid) => ({ storeId: sid })) }
              : undefined,
            skills: parsed.skillTagIds.length
              ? { create: parsed.skillTagIds.map((tid) => ({ skillTagId: tid })) }
              : undefined,
            capabilities: parsed.capabilityDataSourceIds.length
              ? { create: parsed.capabilityDataSourceIds.map((dsid) => ({ dataSourceId: dsid, assignedBy: user.id })) }
              : undefined,
          },
        },
      },
      include: { teamMember: true },
    });

    return NextResponse.json(
      { user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role }, requestId },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TeamAPI.POST",
        code: "CREATION_ERROR",
        userMessage: "Failed to create team member",
        error,
      }),
      { status: 500 }
    );
  }
}
