/**
 * POST   /api/team/:id/stores         — assign a store to a team member
 * DELETE /api/team/:id/stores/:storeId — remove a store assignment
 * Body for POST: { storeId: number }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const member = await prisma.teamMember.findFirst({ where: { userId: parseInt(id, 10) }, include: { storeAssignments: true } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  return NextResponse.json({ storeIds: member.storeAssignments.map((a) => a.storeId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { storeId } = await request.json();
  if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const member = await prisma.teamMember.findFirst({ where: { userId: parseInt(id, 10) } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const assignment = await prisma.storeAssignment.upsert({
    where: { teamMemberId_storeId: { teamMemberId: member.id, storeId: Number(storeId) } },
    create: { teamMemberId: member.id, storeId: Number(storeId) },
    update: {},
  });

  return NextResponse.json({ assignment }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { storeId } = await request.json();
  if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const member = await prisma.teamMember.findFirst({ where: { userId: parseInt(id, 10) } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  await prisma.storeAssignment.deleteMany({
    where: { teamMemberId: member.id, storeId: Number(storeId) },
  });

  return NextResponse.json({ success: true });
}
