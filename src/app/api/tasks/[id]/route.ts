/**
 * GET   /api/tasks/:id   — fetch single task with full details
 * PATCH /api/tasks/:id   — update task (status, assignee, notes)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { TaskStatus, UserRole } from "@prisma/client";
// Labstack is treated as a strictly read-only source — no writebacks.
// (Previously this route called appendOrderNote() on task completion; that
// path has been removed. Task completion is recorded in taskos.task_history
// only; the labstack Order row is left untouched.)

/**
 * Resolve store IDs a STORE_ADMIN is permitted to act on. Empty array means
 * the admin has no store assignments — they should be forbidden from acting
 * on any task.
 */
async function getAdminStoreIds(userId: number): Promise<number[]> {
  const member = await prisma.teamMember.findFirst({
    where: { userId },
    include: { storeAssignments: { select: { storeId: true } } },
  });
  return member?.storeAssignments.map((a) => a.storeId) ?? [];
}

/**
 * Returns true iff the user is allowed to read/write this task. Centralises
 * the role-based scoping rule so GET and PATCH agree (audit P0 #4 — PATCH
 * previously only checked OPS_AGENT-not-own and let STORE_ADMINs touch any
 * task).
 */
async function canAccessTask(
  user: { id: number; role: UserRole },
  task: { assignedToId: number | null; storeId: number | null }
): Promise<boolean> {
  if (user.role === UserRole.OPS_HEAD) return true;
  if (user.role === UserRole.OPS_AGENT) return task.assignedToId === user.id;
  // STORE_ADMIN: must own the task's store
  if (task.storeId == null) return false;
  const storeIds = await getAdminStoreIds(user.id);
  return storeIds.includes(task.storeId);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const taskId = parseInt(id, 10);
  if (isNaN(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      checklistItems: { orderBy: { stepOrder: "asc" } },
      history: {
        orderBy: { createdAt: "desc" },
        include: { changedBy: { select: { id: true, name: true } } },
      },
      taskType: { select: { name: true, label: true } },
      taskRule: { select: { name: true, slaMinutes: true } },
    },
  });

  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (!(await canAccessTask(user, task))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ task });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const taskId = parseInt(id, 10);
  if (isNaN(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  const body = await request.json();

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (!(await canAccessTask(user, task))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status, note, checklistItemId, isDone, assignedToId, snoozeMinutes, clearSnooze } = body;
  const updates: Record<string, unknown> = {};
  const historyNote = note ?? "";

  // ── Snooze (W5) ───────────────────────────────────────────────────
  // The agent picks a duration ("Ping me in 15m") which sets snoozedUntil.
  // The task disappears from their Active tab until the timestamp passes.
  // `clearSnooze: true` removes an active snooze (the panel banner does this).
  // Allowed durations are clamped server-side so the UI can't drift.
  if (clearSnooze === true) {
    updates.snoozedUntil = null;
  } else if (snoozeMinutes !== undefined) {
    const minutes = Number(snoozeMinutes);
    const ALLOWED = [15, 30, 60, 240];
    if (!ALLOWED.includes(minutes)) {
      return NextResponse.json(
        { error: `Invalid snoozeMinutes — must be one of ${ALLOWED.join(", ")}` },
        { status: 400 }
      );
    }
    updates.snoozedUntil = new Date(Date.now() + minutes * 60_000);
    // History trail so heads can see the snooze in the timeline.
    await prisma.taskHistory.create({
      data: {
        taskId,
        status: task.status,
        changedById: user.id,
        note: `Snoozed for ${minutes} min`,
      },
    });
  }

  // ── Status transition ─────────────────────────────────────────────
  if (status && Object.values(TaskStatus).includes(status)) {
    updates.status = status;

    if (status === TaskStatus.IN_PROGRESS && !task.startedAt) {
      updates.startedAt = new Date();
    }
    if (status === TaskStatus.COMPLETED) {
      updates.completedAt = new Date();
    }
    if (status === TaskStatus.ASSIGNED && !task.assignedAt) {
      updates.assignedAt = new Date();
    }

    await prisma.taskHistory.create({
      data: {
        taskId,
        status,
        changedById: user.id,
        note: historyNote,
      },
    });

    // (Removed) labstack writeback on COMPLETED. OpsFlow no longer mutates
    // the labstack Order row — task completion is recorded entirely in
    // taskos.task_history above. Labstack is read-only from OpsFlow.
  }

  // ── Checklist item toggle ─────────────────────────────────────────
  // Audit P1: previously the route updated whatever checklistItemId the
  // caller supplied without verifying it belonged to this task. A
  // logged-in agent could toggle any checklist item across any task by
  // guessing ids. Now we constrain the update to (id AND taskId).
  if (checklistItemId !== undefined && isDone !== undefined) {
    const updated = await prisma.taskChecklistItem.updateMany({
      where: { id: checklistItemId, taskId },
      data: { isDone, doneAt: isDone ? new Date() : null },
    });
    if (updated.count === 0) {
      return NextResponse.json(
        { error: "Checklist item not found on this task" },
        { status: 404 }
      );
    }
  }

  // ── Re-assign (OPS_HEAD / STORE_ADMIN only) ───────────────────────
  // Audit P1: PATCH previously accepted any `assignedToId` without
  // verifying the user existed or was an OPS_AGENT. Verify both before
  // landing the change so a typo or malicious id can't orphan the task.
  if (assignedToId !== undefined && user.role !== UserRole.OPS_AGENT) {
    const target =
      assignedToId === null
        ? null
        : await prisma.user.findUnique({
            where: { id: Number(assignedToId) },
            select: { id: true, role: true, isActive: true, teamMember: { select: { id: true } } },
          });

    if (assignedToId !== null) {
      if (!target || !target.isActive || target.role !== UserRole.OPS_AGENT) {
        return NextResponse.json(
          { error: "Invalid assignee — must be an active OPS_AGENT" },
          { status: 400 }
        );
      }
    }

    updates.assignedToId = target?.id ?? null;
    // Keep teamMemberId in sync (audit arch finding — divergent dual writes)
    updates.teamMemberId = target?.teamMember?.id ?? null;
    updates.assignedAt = target ? new Date() : null;

    if (!status) {
      // If only reassigning (no status change), also create history
      await prisma.taskHistory.create({
        data: {
          taskId,
          status: task.status,
          changedById: user.id,
          note: target
            ? `Reassigned to user #${target.id}`
            : `Unassigned`,
        },
      });
    }
  }

  // ── Standalone note (no status change) ──────────────────────────
  const standaloneNote = !status && assignedToId === undefined && note?.trim() && checklistItemId === undefined;
  if (standaloneNote) {
    await prisma.taskHistory.create({
      data: {
        taskId,
        status: task.status,
        changedById: user.id,
        note: note.trim(),
      },
    });
  }

  if (Object.keys(updates).length === 0 && checklistItemId === undefined && !standaloneNote) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: updates,
    include: {
      assignedTo: { select: { id: true, name: true } },
      checklistItems: { orderBy: { stepOrder: "asc" } },
    },
  });

  return NextResponse.json({ task: updated });
}
