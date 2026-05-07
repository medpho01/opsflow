/**
 * GET  /api/roster/schedule/:userId  — Get weekly schedule for a team member
 * POST /api/roster/schedule/:userId  — Create/upsert weekly schedule (all 7 days)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

// Validation utilities
function isValidTimeFormat(time: string): boolean {
  const pattern = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
  return pattern.test(time);
}

function isTimeAfter(time1: string, time2: string): boolean {
  const [h1, m1] = time1.split(":").map(Number);
  const [h2, m2] = time2.split(":").map(Number);
  const mins1 = h1 * 60 + m1;
  const mins2 = h2 * 60 + m2;
  return mins1 > mins2;
}

function isTimeWithin(time: string, start: string, end: string): boolean {
  const [h, m] = time.split(":").map(Number);
  const [hs, ms] = start.split(":").map(Number);
  const [he, me] = end.split(":").map(Number);
  const mins = h * 60 + m;
  const minsStart = hs * 60 + ms;
  const minsEnd = he * 60 + me;
  return mins >= minsStart && mins <= minsEnd;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId } = await params;
  const userIdNum = parseInt(userId, 10);

  // Authorization: OPS_HEAD can access anyone, OPS_AGENT can access own
  if (user.role === "OPS_AGENT" && user.id !== userIdNum) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Check if user exists and has team member record
  const teamMember = await prisma.teamMember.findFirst({
    where: { userId: userIdNum },
    include: { weeklySchedules: { orderBy: { dayOfWeek: "asc" } } },
  });

  if (!teamMember) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  // Ensure all 7 days are represented
  const scheduleMap = new Map(teamMember.weeklySchedules.map((s) => [s.dayOfWeek, s]));
  const schedule = [];
  for (let day = 0; day < 7; day++) {
    if (scheduleMap.has(day)) {
      schedule.push(scheduleMap.get(day));
    } else {
      // Return empty schedule for day if not found
      schedule.push({
        id: 0,
        teamMemberId: teamMember.id,
        dayOfWeek: day,
        isWorking: false,
        startTime: null,
        endTime: null,
        breakStart: null,
        breakEnd: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  return NextResponse.json({
    schedule,
    userId: userIdNum,
    teamMemberId: teamMember.id,
    name: user.name,
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId } = await params;
  const userIdNum = parseInt(userId, 10);

  // Authorization: OPS_HEAD only
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden - only OPS_HEAD can manage schedules" }, { status: 403 });
  }

  // Check if user exists and has team member record
  const teamMember = await prisma.teamMember.findFirst({ where: { userId: userIdNum } });
  if (!teamMember) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  const body = await request.json();
  const { schedule } = body;

  if (!Array.isArray(schedule) || schedule.length === 0) {
    return NextResponse.json({ error: "schedule must be a non-empty array" }, { status: 400 });
  }

  // Validate each day
  for (const day of schedule) {
    if (day.dayOfWeek === undefined || day.isWorking === undefined) {
      return NextResponse.json(
        { error: "Each schedule entry must have dayOfWeek and isWorking" },
        { status: 400 }
      );
    }

    if (day.dayOfWeek < 0 || day.dayOfWeek > 6) {
      return NextResponse.json({ error: "dayOfWeek must be 0-6" }, { status: 400 });
    }

    if (day.isWorking) {
      if (!day.startTime || !day.endTime) {
        return NextResponse.json(
          { error: "startTime and endTime required when isWorking=true" },
          { status: 400 }
        );
      }

      if (!isValidTimeFormat(day.startTime) || !isValidTimeFormat(day.endTime)) {
        return NextResponse.json({ error: "Invalid time format. Use HH:MM (24-hour)" }, { status: 400 });
      }

      if (!isTimeAfter(day.endTime, day.startTime)) {
        return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });
      }

      // Validate break times if present
      if (day.breakStart || day.breakEnd) {
        if (!day.breakStart || !day.breakEnd) {
          return NextResponse.json(
            { error: "Both breakStart and breakEnd required if either is provided" },
            { status: 400 }
          );
        }

        if (!isValidTimeFormat(day.breakStart) || !isValidTimeFormat(day.breakEnd)) {
          return NextResponse.json({ error: "Invalid break time format. Use HH:MM" }, { status: 400 });
        }

        if (!isTimeAfter(day.breakEnd, day.breakStart)) {
          return NextResponse.json(
            { error: "Break end time must be after break start time" },
            { status: 400 }
          );
        }

        if (!isTimeWithin(day.breakStart, day.startTime, day.endTime)) {
          return NextResponse.json(
            { error: "Break start time must be within work hours" },
            { status: 400 }
          );
        }

        if (!isTimeWithin(day.breakEnd, day.startTime, day.endTime)) {
          return NextResponse.json(
            { error: "Break end time must be within work hours" },
            { status: 400 }
          );
        }
      }
    }
  }

  // Delete existing schedules for this member and recreate
  await prisma.weeklySchedule.deleteMany({ where: { teamMemberId: teamMember.id } });

  // Create new schedules
  const created = await prisma.weeklySchedule.createMany({
    data: schedule.map((day) => ({
      teamMemberId: teamMember.id,
      dayOfWeek: day.dayOfWeek,
      isWorking: day.isWorking,
      startTime: day.startTime ?? null,
      endTime: day.endTime ?? null,
      breakStart: day.breakStart ?? null,
      breakEnd: day.breakEnd ?? null,
    })),
  });

  // Fetch created schedules
  const saved = await prisma.weeklySchedule.findMany({
    where: { teamMemberId: teamMember.id },
    orderBy: { dayOfWeek: "asc" },
  });

  return NextResponse.json({
    schedule: saved,
    userId: userIdNum,
    teamMemberId: teamMember.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
