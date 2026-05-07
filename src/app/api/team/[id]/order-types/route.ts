import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

const VALID_ORDER_TYPES = ["HOME_SAMPLE", "CENTER_VISIT", "INJECTION"];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const userId = parseInt(id);

    // Look up user first
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { teamMember: { include: { orderTypes: true } } },
    });

    if (!user || !user.teamMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const member = user.teamMember;

    return NextResponse.json({
      teamMemberId: member.id,
      memberName: user.name || "Unknown",
      orderTypes: member.orderTypes,
    });
  } catch (error) {
    console.error("[ORDER_TYPES_GET]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

    const { orderType } = await request.json();

    // Validate order type
    if (!orderType || !VALID_ORDER_TYPES.includes(orderType)) {
      return NextResponse.json(
        {
          error: "Invalid order type",
          code: "INVALID_ORDER_TYPE",
          details: {
            validTypes: VALID_ORDER_TYPES,
            provided: orderType,
          },
        },
        { status: 400 }
      );
    }

    const { id } = await params;
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

    // Check for duplicate
    const existing = await prisma.teamMemberOrderType.findUnique({
      where: {
        teamMemberId_orderType: {
          teamMemberId,
          orderType,
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        {
          error: "Order type already assigned to this member",
          code: "DUPLICATE_ASSIGNMENT",
          details: {
            teamMemberId,
            orderType,
            assignedAt: existing.assignedAt,
          },
        },
        { status: 409 }
      );
    }

    // Create assignment
    const assignment = await prisma.teamMemberOrderType.create({
      data: {
        teamMemberId,
        orderType,
        assignedBy: session.userId,
      },
    });

    return NextResponse.json(
      {
        id: assignment.id,
        teamMemberId,
        memberName: user?.name || "Unknown",
        orderType,
        assignedAt: assignment.assignedAt,
        assignedBy: assignment.assignedBy,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[ORDER_TYPES_POST]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
