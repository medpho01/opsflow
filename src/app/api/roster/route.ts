/**
 * GET  /api/roster?date=YYYY-MM-DD  — all team members with roster status for a date
 * POST /api/roster                  — upsert a single member's roster entry
 *   body: { teamMemberId, date, status, note? }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, RosterStatus } from "@prisma/client";

/** Always returns a UTC-midnight Date to avoid timezone shift on @db.Date fields. */
function parseDateParam(dateStr: string | null): Date {
  if (dateStr) {
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const t = new Date();
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const date = parseDateParam(searchParams.get("date"));
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);

  const members = await prisma.user.findMany({
    where: { isActive: true, role: { not: UserRole.OPS_HEAD } },
    include: {
      teamMember: {
        include: {
          storeAssignments: { select: { storeId: true } },
          skills: { include: { skillTag: { select: { name: true, label: true } } } },
          dailyRosters: {
            where: { date: { gte: date, lt: nextDay } },
            take: 1,
          },
          _count: {
            select: {
              assignedTasks: {
                where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
              },
            },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const shaped = members.map((m) => ({
    userId: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    teamMemberId: m.teamMember?.id ?? null,
    maxConcurrentTasks: m.teamMember?.maxConcurrentTasks ?? 5,
    storeIds: m.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
    skills: m.teamMember?.skills.map((s) => s.skillTag.label) ?? [],
    rosterEntry: m.teamMember?.dailyRosters?.[0] ?? null,
    openTaskCount: m.teamMember?._count?.assignedTasks ?? 0,
  }));

  return NextResponse.json({ date: date.toISOString(), members: shaped });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { teamMemberId, date: dateStr, status, note } = body;

  if (!teamMemberId || !dateStr || !status) {
    return NextResponse.json({ error: "teamMemberId, date, status required" }, { status: 400 });
  }

  if (!Object.values(RosterStatus).includes(status)) {
    return NextResponse.json({ error: `status must be one of ${Object.values(RosterStatus).join(", ")}` }, { status: 400 });
  }

  const date = parseDateParam(dateStr);

  const entry = await prisma.dailyRoster.upsert({
    where: { teamMemberId_date: { teamMemberId, date } },
    create: { teamMemberId, date, status, note: note ?? null },
    update: { status, note: note ?? null },
  });

  return NextResponse.json({ entry });
}
