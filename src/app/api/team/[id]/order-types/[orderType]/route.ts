/**
 * DELETE /api/team/:id/order-types/:orderType — remove a data source capability from a team member
 *
 * The :orderType param now accepts the dataSourceId (UUID/cuid) of the data source to remove.
 * The legacy name is retained for URL compatibility.
 */
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

    if (session.role !== UserRole.OPS_HEAD && session.role !== UserRole.STORE_ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id, orderType: dataSourceId } = await params;
    const userId = parseInt(id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { teamMember: true },
    });

    if (!user || !user.teamMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const teamMemberId = user.teamMember.id;

    const capability = await prisma.teamMemberCapability.findUnique({
      where: { teamMemberId_dataSourceId: { teamMemberId, dataSourceId } },
    });

    if (!capability) {
      return NextResponse.json({ error: "Capability not found" }, { status: 404 });
    }

    await prisma.teamMemberCapability.delete({
      where: { teamMemberId_dataSourceId: { teamMemberId, dataSourceId } },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[CAPABILITY_DELETE]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
