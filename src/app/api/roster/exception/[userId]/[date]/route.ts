/**
 * DELETE /api/roster/exception/:userId/:date  — Remove exception
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string; date: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId, date } = await params;
  const userIdNum = parseInt(userId, 10);

  console.log("DELETE exception - userId:", userId, "userIdNum:", userIdNum, "date:", date);

  // Authorization: OPS_HEAD can delete any, others need special permission
  if (user.role !== UserRole.OPS_HEAD) {
    console.log("Authorization failed - user role:", user.role);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parse date
  const dateObj = parseDateParam(date);
  console.log("Parsed date:", date, "->", dateObj);

  if (!dateObj) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  // Get team member for this user
  const teamMember = await prisma.teamMember.findFirst({ where: { userId: userIdNum } });
  console.log("Team member found:", teamMember?.id, "for userId:", userIdNum);

  if (!teamMember) {
    return NextResponse.json({ error: "Team member not found", code: "NO_TEAM_MEMBER", userId: userIdNum }, { status: 404 });
  }

  try {
    // Check if exception exists
    console.log("Looking for exception - teamMemberId:", teamMember.id, "date:", dateObj);

    const exception = await prisma.rosterException.findUnique({
      where: { teamMemberId_date: { teamMemberId: teamMember.id, date: dateObj } },
    });

    console.log("Exception found:", exception?.id, exception?.status);

    if (!exception) {
      // List all exceptions for this team member for debugging
      const allExceptions = await prisma.rosterException.findMany({
        where: { teamMemberId: teamMember.id },
        orderBy: { date: "desc" },
        take: 5,
      });
      console.log("All exceptions for teamMemberId", teamMember.id, ":", allExceptions.map(e => ({ date: e.date, status: e.status })));

      return NextResponse.json(
        {
          error: "No exception found for this date",
          code: "NOT_FOUND",
          details: {
            teamMemberId: teamMember.id,
            userId: userIdNum,
            date: dateObj.toISOString().split('T')[0],
            recentExceptions: allExceptions.map(e => ({ date: e.date.toISOString().split('T')[0], status: e.status }))
          }
        },
        { status: 404 }
      );
    }

    // Delete exception
    await prisma.rosterException.delete({
      where: { teamMemberId_date: { teamMemberId: teamMember.id, date: dateObj } },
    });

    console.log("Exception deleted successfully");
    return NextResponse.json({ success: true, message: "Exception removed" });
  } catch (err) {
    console.error("Exception delete error:", err);
    return NextResponse.json(
      { error: "Failed to remove exception", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
