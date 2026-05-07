/**
 * PATCH /api/team/:id — update a team member (name, phone, isActive, maxConcurrentTasks)
 * OPS_HEAD only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (isNaN(targetId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  // Only OPS_HEAD can edit accounts (including their own)
  // Store admins cannot edit any accounts

  const body = await request.json();
  const { name, phone, role, isActive, maxConcurrentTasks, resetPassword } = body;

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    include: { teamMember: true },
  });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Update user fields
  const userUpdates: Record<string, unknown> = {};
  if (name !== undefined) userUpdates.name = name.trim();
  if (phone !== undefined) userUpdates.phone = phone?.trim() || null;
  if (role !== undefined) userUpdates.role = role;
  if (typeof isActive === "boolean") userUpdates.isActive = isActive;

  // Reset password
  if (resetPassword) {
    if (typeof resetPassword !== "string" || resetPassword.length < 8) {
      return NextResponse.json({ error: "Reset password must be at least 8 characters" }, { status: 400 });
    }
    userUpdates.passwordHash = await hashPassword(resetPassword);
    // Invalidate all sessions for this user
    await prisma.session.deleteMany({ where: { userId: targetId } });
  }

  if (Object.keys(userUpdates).length > 0) {
    await prisma.user.update({ where: { id: targetId }, data: userUpdates });
  }

  // Update team member fields
  if (maxConcurrentTasks !== undefined && target.teamMember) {
    const maxTasks = parseInt(maxConcurrentTasks, 10);
    if (!isNaN(maxTasks) && maxTasks >= 1) {
      await prisma.teamMember.update({
        where: { id: target.teamMember.id },
        data: { maxConcurrentTasks: maxTasks },
      });
    }
  }

  const updated = await prisma.user.findUnique({
    where: { id: targetId },
    include: { teamMember: { include: { storeAssignments: true, orderTypes: true } } },
  });

  return NextResponse.json({ user: updated });
}
