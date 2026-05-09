/**
 * GET /api/task-rules/{id}/recent-fires?limit=10
 *
 * Returns the most recent tasks created by this rule, so the rule list UI
 * can show "what did this rule actually fire on?" without bouncing the user
 * to the Tasks board with a filter. Cheap query — index on
 * (taskRuleId, createdAt) covers it.
 *
 * Response shape:
 *   {
 *     ruleId: "<cuid>",
 *     fires: [
 *       { taskId, entityId, title, status, createdAt, assignedToName }
 *     ],
 *     count
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ ruleId: id, fires: [], count: 0 });
  }

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit));

  const tasks = await prisma.task.findMany({
    where: { taskRuleId: id },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      entityId: true,
      title: true,
      status: true,
      createdAt: true,
      isArchived: true,
      assignedTo: { select: { name: true } },
    },
  });

  return NextResponse.json({
    ruleId: id,
    count: tasks.length,
    fires: tasks.map((t) => ({
      taskId: t.id,
      entityId: t.entityId,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
      isArchived: t.isArchived,
      assignedToName: t.assignedTo?.name ?? null,
    })),
  });
}
