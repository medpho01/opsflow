import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderType: string }> }
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

    const { id, orderType } = await params;
    const userId = parseInt(id);

    // Look up user and get their teamMember
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { teamMember: true },
    });

    if (!user || !user.teamMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const member = user.teamMember;
    const teamMemberId = member.id;

    // Check assignment exists
    const assignment = await prisma.teamMemberOrderType.findUnique({
      where: {
        teamMemberId_orderType: {
          teamMemberId,
          orderType,
        },
      },
    });

    if (!assignment) {
      return NextResponse.json(
        { error: "Assignment not found" },
        { status: 404 }
      );
    }

    // Delete assignment
    await prisma.teamMemberOrderType.delete({
      where: {
        teamMemberId_orderType: {
          teamMemberId,
          orderType,
        },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[ORDER_TYPE_DELETE]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
