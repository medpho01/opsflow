/**
 * PATCH  /api/team/:id  — update a team member (name, phone, role, isActive,
 *                          maxConcurrentTasks, resetPassword)
 * DELETE /api/team/:id  — permanently delete a team member (preserves audit history)
 *
 * OPS_HEAD only. Validation shared with POST /api/team via lib/validation/team.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { updateTeamMemberSchema, zodErrorToTeamResponse } from "@/lib/validation/team";
import { rateLimit } from "@/lib/observability/rate-limit";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (isNaN(targetId)) return NextResponse.json({ error: "Invalid ID", requestId }, { status: 400 });

  let parsed: import("@/lib/validation/team").UpdateTeamMemberInput;
  try {
    parsed = updateTeamMemberSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ ...zodErrorToTeamResponse(err), requestId }, { status: 400 });
    }
    throw err;
  }

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    include: { teamMember: true },
  });
  if (!target) return NextResponse.json({ error: "User not found", requestId }, { status: 404 });

  // ── User-level updates ──────────────────────────────────────────────────
  const userUpdates: Record<string, unknown> = {};
  if (parsed.name !== undefined) userUpdates.name = parsed.name;
  if (parsed.phone !== undefined) userUpdates.phone = parsed.phone || null;
  if (parsed.role !== undefined) userUpdates.role = parsed.role; // W1.1 — validated by zod enum
  if (parsed.isActive !== undefined) userUpdates.isActive = parsed.isActive;

  // ── Reset password (with rate limit) ────────────────────────────────────
  if (parsed.resetPassword !== undefined) {
    // W1.8 — rate-limit password resets to 5 per minute per target user.
    // Stops a compromised admin session from hammering reset on many users
    // and rotating credentials silently.
    if (!rateLimit("password-reset", String(targetId), 5, 60_000)) {
      return NextResponse.json(
        { error: "Too many password resets for this user — try again in a minute", code: "RATE_LIMITED", requestId },
        { status: 429 }
      );
    }
    userUpdates.passwordHash = await hashPassword(parsed.resetPassword);
    // Invalidate all sessions for the target so the new password is required.
    await prisma.session.deleteMany({ where: { userId: targetId } });
  }

  if (Object.keys(userUpdates).length > 0) {
    await prisma.user.update({ where: { id: targetId }, data: userUpdates });
  }

  // ── TeamMember-level updates ────────────────────────────────────────────
  if (parsed.maxConcurrentTasks !== undefined && target.teamMember) {
    // W1.10 — bound enforced by zod (1..100); no need to re-check here.
    await prisma.teamMember.update({
      where: { id: target.teamMember.id },
      data: { maxConcurrentTasks: parsed.maxConcurrentTasks },
    });
  }

  const updated = await prisma.user.findUnique({
    where: { id: targetId },
    include: {
      teamMember: {
        include: {
          storeAssignments: true,
          capabilities: { include: { dataSource: { select: { id: true, sourceId: true, displayName: true } } } },
          skills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
        },
      },
    },
  });

  return NextResponse.json({ user: updated, requestId });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (isNaN(targetId)) return NextResponse.json({ error: "Invalid ID", requestId }, { status: 400 });

  if (targetId === user.id) {
    return NextResponse.json({ error: "You cannot delete your own account", requestId }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return NextResponse.json({ error: "User not found", requestId }, { status: 404 });

  try {
    // ─── W1.2 — DELETE preserves audit history ───────────────────────────
    //
    // Previous behaviour nulled `assignedToId` on EVERY task the user ever
    // owned, including COMPLETED — wiping the historical attribution that
    // makes "who closed this task last week" answerable.
    //
    // New behaviour: only release ACTIVE tasks (so they can be reassigned
    // by the engine). For COMPLETED / CANCELLED / BREACHED tasks, copy the
    // departing user's id into a new `previousAssigneeId` column so the
    // FK can null out without losing the audit trail.
    //
    // The schema doesn't have `previousAssigneeId` yet — we stash the id
    // into the existing JSONB `metadata` field under a `previousAssigneeId`
    // key as an interim measure (no migration needed). When the column is
    // added later, a data backfill is straightforward.

    const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "BREACHED"] as const;

    // Active tasks: free them up so the engine can reassign on next poll.
    await prisma.task.updateMany({
      where: {
        assignedToId: targetId,
        status: { notIn: [...TERMINAL_STATUSES] },
      },
      data: {
        assignedToId: null,
        teamMemberId: null,
        assignedAt: null,
        assignmentMethod: null,
      },
    });

    // Terminal tasks: stash the old assignee id in metadata, then null FK.
    // We do this in batches because a per-task update is the only way to
    // merge a key into existing JSONB (raw SQL alternative would also work
    // but is more invasive).
    const terminalTasks = await prisma.task.findMany({
      where: {
        assignedToId: targetId,
        status: { in: [...TERMINAL_STATUSES] },
      },
      select: { id: true, metadata: true },
    });

    for (const t of terminalTasks) {
      const md = (t.metadata as Record<string, unknown> | null) ?? {};
      await prisma.task.update({
        where: { id: t.id },
        data: {
          metadata: { ...md, previousAssigneeId: targetId, previousAssigneeName: target.name },
          assignedToId: null,
          teamMemberId: null,
        },
      });
    }

    // Cascade-delete the user (sessions, teamMember, storeAssignments,
    // schedules, exceptions all go via Prisma's onDelete: Cascade).
    await prisma.user.delete({ where: { id: targetId } });

    return NextResponse.json({
      success: true,
      preservedTerminalTasks: terminalTasks.length,
      requestId,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TeamAPI.DELETE",
        code: "DELETE_ERROR",
        userMessage: "Failed to delete team member",
        error,
      }),
      { status: 500 }
    );
  }
}
