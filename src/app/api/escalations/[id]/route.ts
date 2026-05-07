/**
 * PATCH  /api/escalations/:id — update chain (name, isActive)
 * DELETE /api/escalations/:id — delete chain (only if no rules use it)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const chainId = parseInt(id, 10);
  const body = await request.json();
  const { name, isActive } = body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (typeof isActive === "boolean") updates.isActive = isActive;

  const chain = await prisma.escalationChain.update({
    where: { id: chainId },
    data: updates,
    include: { levels: { include: { notifyUser: { select: { id: true, name: true } } }, orderBy: { levelNumber: "asc" } }, _count: { select: { rules: true } } },
  });

  return NextResponse.json({ chain });
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

  const ruleCount = await prisma.taskRule.count({ where: { escalationChainId: chainId } });
  if (ruleCount > 0) {
    return NextResponse.json({ error: `Cannot delete — ${ruleCount} task rule(s) use this chain. Remove them first.` }, { status: 409 });
  }

  await prisma.escalationChain.delete({ where: { id: chainId } });
  return NextResponse.json({ success: true });
}
