/**
 * GET /api/tasks/:id/calls — call history for a task, for the "Call
 * activity" panel in the task drawer. Same access rule as the task itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { canAccessTask } from "@/lib/auth/taskAccess";
import { fetchCallsForTask } from "@/lib/calls/callHistory";

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
    select: { id: true, assignedToId: true, storeId: true },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!(await canAccessTask(user, task))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const calls = await fetchCallsForTask(taskId);

  return NextResponse.json({ calls });
}
