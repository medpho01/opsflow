import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@/types";
import { getMemberStats } from "@/lib/performance";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check authorization
    if (![UserRole.OPS_HEAD, UserRole.STORE_ADMIN].includes(session.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const period = (searchParams.get("period") ||
      "month") as "week" | "month" | "alltime";

    // Validate period
    if (!["week", "month", "alltime"].includes(period)) {
      return NextResponse.json(
        { error: "Invalid period parameter" },
        { status: 400 }
      );
    }

    const teamMemberId = parseInt(params.id);

    // Check member exists
    const member = await prisma.teamMember.findUnique({
      where: { id: teamMemberId },
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Get stats
    const stats = await getMemberStats(teamMemberId, period);

    if (!stats) {
      return NextResponse.json({ error: "Stats not found" }, { status: 404 });
    }

    return NextResponse.json(stats);
  } catch (error) {
    console.error("[PERFORMANCE_GET]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
