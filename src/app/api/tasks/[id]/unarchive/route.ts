import { NextRequest, NextResponse } from "next/server";
import { unarchiveTask } from "@/lib/engine/taskArchiver";

/**
 * PATCH /api/tasks/:id/unarchive
 * Manually restore an archived task to active view
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = parseInt(params.id);

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
