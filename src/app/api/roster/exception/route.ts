/**
 * GET  /api/roster/exception?userId=...&start=...&end=...  — Get exceptions for user(s)
 * POST /api/roster/exception                                — Create new exception
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

const VALID_STATUSES = ["ACTIVE", "ON_LEAVE", "SICK", "OFF"];

function parseDateParam(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const userIdStr = searchParams.get("userId");
  const startStr = searchParams.get("start");
  const endStr = searchParams.get("end");

  let where: any = {};

  // If userId provided, filter to that user
  if (userIdStr) {
    const userIdNum = parseInt(userIdStr, 10);

    // Authorization check: OPS_AGENT can only see own exceptions
    if (user.role === UserRole.OPS_AGENT && user.id !== userIdNum) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get team member ID for this user
    const teamMember = await prisma.teamMember.findFirst({ where: { userId: userIdNum } });
    if (!teamMember) {
      return NextResponse.json({ error: "Team member not found" }, { status: 404 });
    }
    where.teamMemberId = teamMember.id;
  }

  // Filter by date range if provided
  if (startStr || endStr) {
    where.date = {};
    if (startStr) {
      const start = parseDateParam(startStr);
      if (start) where.date.gte = start;
    }
    if (endStr) {
      const end = parseDateParam(endStr);
      if (end) where.date.lte = end;
    }
  }

  const exceptions = await prisma.rosterException.findMany({
    where,
    orderBy: [{ date: "desc" }, { teamMemberId: "asc" }],
    include: { teamMember: { include: { user: { select: { name: true, email: true } } } } },
  });

  return NextResponse.json({
    exceptions: exceptions.map((e) => ({
      id: e.id,
      teamMemberId: e.teamMemberId,
      userId: e.teamMember.userId,
      name: e.teamMember.user.name,
      date: e.date.toISOString().split("T")[0],
      status: e.status,
      note: e.note,
      createdBy: e.createdBy,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
    count: exceptions.length,
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Any role can create exceptions
  if (!["OPS_HEAD", "STORE_ADMIN", "OPS_AGENT"].includes(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { userId, date, status, note } = body;

  if (!userId || !date || !status) {
    return NextResponse.json({ error: "userId, date, status required" }, { status: 400 });
  }

  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // Parse and validate date
  const dateObj = parseDateParam(date);
  if (!dateObj) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  // Get team member for this user
  const userIdNum = parseInt(userId, 10);
  const teamMember = await prisma.teamMember.findFirst({ where: { userId: userIdNum } });
  if (!teamMember) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  // Check if exception already exists (409 Conflict)
  const existing = await prisma.rosterException.findUnique({
    where: { teamMemberId_date: { teamMemberId: teamMember.id, date: dateObj } },
  });

  if (existing) {
    return NextResponse.json(
      { error: "Exception already exists for this date", code: "DUPLICATE_ASSIGNMENT" },
      { status: 409 }
    );
  }

  // Create exception
  const exception = await prisma.rosterException.create({
    data: {
      teamMemberId: teamMember.id,
      date: dateObj,
      status,
      note: note ?? null,
      createdBy: user.id,
    },
    include: { teamMember: { include: { user: { select: { name: true, email: true } } } } },
  });

  return NextResponse.json(
    {
      id: exception.id,
      teamMemberId: exception.teamMemberId,
      userId: exception.teamMember.userId,
      name: exception.teamMember.user.name,
      date: exception.date.toISOString().split("T")[0],
      status: exception.status,
      note: exception.note,
      createdBy: exception.createdBy,
      createdAt: exception.createdAt,
    },
    { status: 201 }
  );
}
