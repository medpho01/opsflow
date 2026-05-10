/**
 * POST   /api/escalations/:id/levels — add a level to a chain
 * DELETE /api/escalations/:id/levels/:levelId — remove a level
 * Body for POST: { delayMinutes, channelType, notifyUserId }
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
  const chainId = parseInt(id, 10);

  const { delayMinutes, channelType, notifyUserId } = await request.json();
  if (notifyUserId === undefined) return NextResponse.json({ error: "notifyUserId required" }, { status: 400 });

  // Get the next level number
  const lastLevel = await prisma.escalationLevel.findFirst({
    where: { chainId },
    orderBy: { levelNumber: "desc" },
  });
  const levelNumber = (lastLevel?.levelNumber ?? 0) + 1;

  const level = await prisma.escalationLevel.create({
    data: {
      chainId,
      levelNumber,
      delayMinutes: Number(delayMinutes) || 0,
      channelType: channelType ?? "IN_APP",
      notifyUserId: Number(notifyUserId),
    },
    include: { notifyUser: { select: { id: true, name: true, role: true } } },
  });

  return NextResponse.json({ level }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const chainId = parseInt(id, 10);
  const body = await request.json();
  const levelId = parseInt(body.levelId, 10);

  await prisma.escalationLevel.delete({ where: { id: levelId } });

  // Re-sequence remaining levels
  const remaining = await prisma.escalationLevel.findMany({
    where: { chainId },
    orderBy: { levelNumber: "asc" },
  });
  for (let i = 0; i < remaining.length; i++) {
    await prisma.escalationLevel.update({
      where: { id: remaining[i].id },
      data: { levelNumber: i + 1 },
    });
  }

  return NextResponse.json({ success: true });
}
