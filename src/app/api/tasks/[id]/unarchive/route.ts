import { NextRequest, NextResponse } from "next/server";
import { unarchiveTask } from "@/lib/engine/taskArchiver";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

/**
 * PATCH /api/tasks/:id/unarchive
 * Manually restore an archived task to active view. OPS_HEAD only.
 *
 * Audit P0 — previously had no auth check; any anonymous request could
 * unarchive any task by id. Now mirrors `tasks/archive/route.ts`.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const taskId = parseInt(id);

    if (isNaN(taskId)) {
      return NextResponse.json(
        { error: "Invalid task ID" },
        { status: 400 }
      );
    }

    const task = await unarchiveTask(taskId);

    return NextResponse.json({
      success: true,
      message: `Task ${taskId} restored to active view`,
      task
    });
  } catch (error) {
    console.error("[UnarchiveAPI] Error unarchiving task:", error);
    return NextResponse.json(
      { error: "Failed to unarchive task" },
      { status: 500 }
    );
  }
}
