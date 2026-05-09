/**
 * GET /api/roster/exception/:userId
 * Returns all roster exceptions for a team member.
 * Supports optional ?start=YYYY-MM-DD&end=YYYY-MM-DD query params.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId } = await params;
  const userIdNum = parseInt(userId, 10);
  if (isNaN(userIdNum)) {
    return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
  }

  // Authorization: OPS_HEAD can view anyone, agents can only view their own
  if (user.role === "OPS_AGENT" && user.id !== userIdNum) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  // Build optional date range filter
  const dateFilter: Record<string, Date> = {};
  if (start) {
    const d = new Date(start);
    if (!isNaN(d.getTime())) dateFilter.gte = d;
  }
  if (end) {
    const d = new Date(end);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      dateFilter.lte = d;
    }
  }

  // Find the team member record
  const teamMember = await prisma.teamMember.findFirst({
    where: { userId: userIdNum },
  });

  if (!teamMember) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  const exceptions = await prisma.rosterException.findMany({
    where: {
      teamMemberId: teamMember.id,
      ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
    },
    orderBy: { date: "asc" },
  });

  return NextResponse.json({ exceptions, count: exceptions.length });
}
