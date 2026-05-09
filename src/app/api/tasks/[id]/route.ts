/**
 * GET   /api/tasks/:id   — fetch single task with full details
 * PATCH /api/tasks/:id   — update task (status, assignee, notes)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { TaskStatus, UserRole } from "@prisma/client";
import { appendOrderNote } from "@/lib/engine/labstack";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const taskId = parseInt(id, 10);

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

  // Access control: agents can only see their own tasks
  if (user.role === UserRole.OPS_AGENT && task.assignedToId !== user.id) {
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
  const body = await request.json();

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  // Agents can only update their own tasks
  if (user.role === UserRole.OPS_AGENT && task.assignedToId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status, note, checklistItemId, isDone, assignedToId } = body;
  const updates: Record<string, unknown> = {};
  const historyNote = note ?? "";

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

    // Write note back to labstack if completing.
    // appendOrderNote retries internally; we surface a non-fatal failure on
    // the task's own metadata so the operator can see the labstack writeback
    // didn't land (instead of it being silently swallowed in console.error).
    if (status === TaskStatus.COMPLETED && task.entityType === "ORDER") {
      const completionNote = `Task completed by ${user.name}: ${task.title}${historyNote ? ` — ${historyNote}` : ""}`;
      const result = await appendOrderNote(task.entityId, completionNote);
      if (!result.ok) {
        console.error(`[TaskPatch] appendOrderNote failed after ${result.attempts} attempts: ${result.error}`);
        // Stash the failure on the task's metadata so operators can spot it
        // when reviewing the task. Non-fatal — the task itself completed.
        const existingMd = (task.metadata as Record<string, unknown> | null) ?? {};
        await prisma.task.update({
          where: { id: task.id },
          data: {
            metadata: {
              ...existingMd,
              labstackWritebackFailed: true,
              labstackWritebackError: result.error,
              labstackWritebackAttempts: result.attempts,
            },
          },
        });
      }
    }
  }

  // ── Checklist item toggle ─────────────────────────────────────────
  if (checklistItemId !== undefined && isDone !== undefined) {
    await prisma.taskChecklistItem.update({
      where: { id: checklistItemId },
      data: { isDone, doneAt: isDone ? new Date() : null },
    });
  }

  // ── Re-assign (OPS_HEAD / STORE_ADMIN only) ───────────────────────
  if (assignedToId !== undefined && user.role !== UserRole.OPS_AGENT) {
    updates.assignedToId = assignedToId;
    updates.assignedAt = new Date();

    if (!status) {
      // If only reassigning (no status change), also create history
      await prisma.taskHistory.create({
        data: {
          taskId,
          status: task.status,
          changedById: user.id,
          note: `Reassigned to user #${assignedToId}`,
        },
      });
    }
  }

  // ── Standalone note (no status change) ──────────────────────────
  const standaloneNote = !status && !assignedToId && note?.trim() && checklistItemId === undefined;
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
