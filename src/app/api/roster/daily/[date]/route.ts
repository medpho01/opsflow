/**
 * GET /api/roster/daily/:date  — Get daily roster for a specific date
 *                                 Shows scheduled times + exception overrides
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

function parseDateParam(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}

function getDayOfWeek(date: Date): number {
  return date.getUTCDay(); // 0=Sunday, 1=Monday, etc.
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ date: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { date } = await params;

  // Parse date
  const dateObj = parseDateParam(date);
  if (!dateObj) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  const dayOfWeek = getDayOfWeek(dateObj);

  // Get all active team members
  const members = await prisma.teamMember.findMany({
    where: { isActive: true },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      weeklySchedules: { where: { dayOfWeek } },
    },
  });

  // Get all exceptions for this date
  const exceptions = await prisma.rosterException.findMany({
    where: { date: dateObj },
  });
  const exceptionMap = new Map(exceptions.map((e) => [e.teamMemberId, e]));

  // Build roster
  const roster = members.map((member) => {
    const schedule = member.weeklySchedules[0]; // Should be exactly 1
    const exception = exceptionMap.get(member.id);

    let status = "ACTIVE";
    if (exception) {
      status = exception.status; // ON_LEAVE, SICK, OFF
    } else if (!schedule || !schedule.isWorking) {
      status = "OFF";
    }

    return {
      userId: member.user.id,
      teamMemberId: member.id,
      name: member.user.name,
      email: member.user.email,
      role: member.user.role,
      scheduled: schedule
        ? {
            isWorking: schedule.isWorking,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            breakStart: schedule.breakStart,
            breakEnd: schedule.breakEnd,
          }
        : { isWorking: false },
      exception: exception
        ? {
            status: exception.status,
            note: exception.note,
            createdBy: exception.createdBy,
            createdAt: exception.createdAt,
          }
        : null,
      status,
    };
  });

  return NextResponse.json({
    date: dateObj.toISOString().split("T")[0],
    dayOfWeek,
    roster: roster.sort((a, b) => a.name.localeCompare(b.name)),
    count: roster.length,
  });
}
