/**
 * POST   /api/team/:id/skills         — assign a skill tag to a member
 * DELETE /api/team/:id/skills         — remove a skill tag from a member
 * Body: { skillTagId: number }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { skillTagId } = await request.json();
  if (!skillTagId) return NextResponse.json({ error: "skillTagId required" }, { status: 400 });

  const member = await prisma.teamMember.findFirst({ where: { userId: parseInt(id, 10) } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Upsert — idempotent
  await prisma.teamMemberSkill.upsert({
    where: { teamMemberId_skillTagId: { teamMemberId: member.id, skillTagId: Number(skillTagId) } },
    create: { teamMemberId: member.id, skillTagId: Number(skillTagId) },
    update: {},
  });

  return NextResponse.json({ success: true }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { skillTagId } = await request.json();
  if (!skillTagId) return NextResponse.json({ error: "skillTagId required" }, { status: 400 });

  const member = await prisma.teamMember.findFirst({ where: { userId: parseInt(id, 10) } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  await prisma.teamMemberSkill.deleteMany({
    where: { teamMemberId: member.id, skillTagId: Number(skillTagId) },
  });

  return NextResponse.json({ success: true });
}
