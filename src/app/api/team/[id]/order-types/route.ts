/**
 * GET  /api/team/:id/order-types — list data source capabilities for a team member
 * POST /api/team/:id/order-types — assign a data source capability to a team member
 *
 * Note: This endpoint retains the "order-types" URL path for backward compatibility
 * but now operates on TeamMemberCapability (data source assignments) instead of OrderType enum.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        teamMember: {
          include: {
            capabilities: {
              include: {
                dataSource: { select: { id: true, sourceId: true, displayName: true } },
              },
            },
          },
        },
      },
    });

    if (!user || !user.teamMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const member = user.teamMember;

    return NextResponse.json({
      teamMemberId: member.id,
      memberName: user.name || "Unknown",
      capabilities: member.capabilities.map((c) => ({
        id: c.id,
        dataSourceId: c.dataSourceId,
        dataSource: c.dataSource,
        assignedAt: c.assignedAt,
        assignedBy: c.assignedBy,
      })),
    });
  } catch (error) {
    console.error("[CAPABILITIES_GET]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
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

    if (session.role !== UserRole.OPS_HEAD && session.role !== UserRole.STORE_ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    // Accept either dataSourceId (new) or orderType (legacy field name)
    const dataSourceId = body.dataSourceId ?? body.orderType;

    if (!dataSourceId) {
      return NextResponse.json({ error: "dataSourceId is required" }, { status: 400 });
    }

    const { id } = await params;
    const userId = parseInt(id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { teamMember: true },
    });

    if (!user || !user.teamMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Validate data source exists
    const dataSource = await prisma.dataSource.findUnique({ where: { id: dataSourceId } });
    if (!dataSource) {
      return NextResponse.json({ error: "Data source not found" }, { status: 404 });
    }

    const teamMemberId = user.teamMember.id;

    // Check for duplicate
    const existing = await prisma.teamMemberCapability.findUnique({
      where: { teamMemberId_dataSourceId: { teamMemberId, dataSourceId } },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Data source already assigned to this member", code: "DUPLICATE_ASSIGNMENT" },
        { status: 409 }
      );
    }

    const capability = await prisma.teamMemberCapability.create({
      data: { teamMemberId, dataSourceId, assignedBy: session.id },
      include: { dataSource: { select: { id: true, sourceId: true, displayName: true } } },
    });

    return NextResponse.json(
      {
        id: capability.id,
        teamMemberId,
        memberName: user.name || "Unknown",
        dataSourceId,
        dataSource: capability.dataSource,
        assignedAt: capability.assignedAt,
        assignedBy: capability.assignedBy,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[CAPABILITIES_POST]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
