/**
 * PATCH /api/tasks/bulk
 * Perform a bulk action on multiple tasks.
 * Body: { ids: number[], action: "reassign"|"cancel"|"block", assignedToId?: number }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";

export async function PATCH(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === UserRole.OPS_AGENT) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { ids, action, assignedToId } = body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 });
  }
  if (!["reassign", "cancel", "block"].includes(action)) {
    return NextResponse.json({ error: "action must be reassign, cancel, or block" }, { status: 400 });
  }
  if (action === "reassign" && !assignedToId) {
    return NextResponse.json({ error: "assignedToId required for reassign" }, { status: 400 });
  }

  const taskIds = ids.map(Number).filter((n) => !isNaN(n));

  if (action === "reassign") {
    const assignee = await prisma.user.findUnique({ where: { id: Number(assignedToId) } });
    if (!assignee) return NextResponse.json({ error: "Assignee not found" }, { status: 404 });

    await prisma.task.updateMany({
      where: {
        id: { in: taskIds },
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      },
      data: {
        assignedToId: Number(assignedToId),
        status: TaskStatus.ASSIGNED,
        assignedAt: new Date(),
      },
    });

    // Create history for each
    await prisma.taskHistory.createMany({
      data: taskIds.map((tid) => ({
        taskId: tid,
        status: TaskStatus.ASSIGNED,
        changedById: user.id,
        note: `Bulk reassigned to ${assignee.name}`,
      })),
    });
  } else if (action === "cancel") {
    await prisma.task.updateMany({
      where: {
        id: { in: taskIds },
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      },
      data: { status: TaskStatus.CANCELLED },
    });
    await prisma.taskHistory.createMany({
      data: taskIds.map((tid) => ({
        taskId: tid,
        status: TaskStatus.CANCELLED,
        changedById: user.id,
        note: "Bulk cancelled by Ops Head",
      })),
    });
  } else if (action === "block") {
    // C1.3: Only ASSIGNED or IN_PROGRESS tasks can be blocked
    // Prevents invalid state transition: CREATED → BLOCKED
    const blockableStatuses = [TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS];

    // Get valid tasks to block
    const validTasksToBlock = await prisma.task.findMany({
      where: {
        id: { in: taskIds },
        status: { in: blockableStatuses },
      },
      select: { id: true },
    });

    if (validTasksToBlock.length === 0) {
      return NextResponse.json({
        error: "Cannot block CREATED, COMPLETED, CANCELLED, or BREACHED tasks. Only ASSIGNED or IN_PROGRESS tasks can be blocked.",
      }, { status: 400 });
    }

    const validIds = validTasksToBlock.map((t) => t.id);

    await prisma.task.updateMany({
      where: { id: { in: validIds } },
      data: { status: TaskStatus.BLOCKED },
    });

    await prisma.taskHistory.createMany({
      data: validIds.map((tid) => ({
        taskId: tid,
        status: TaskStatus.BLOCKED,
        changedById: user.id,
        note: "Bulk marked BLOCKED by Ops Head",
      })),
    });
  }

  return NextResponse.json({ success: true, affected: taskIds.length });
}
