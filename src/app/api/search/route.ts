/**
 * GET /api/search?q=<query>&limit=10
 * Global search across tasks (title, order ID) and order IDs.
 * Returns tasks matching query, accessible to the current role.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { TaskStatus, UserRole } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  const limit = Math.min(20, parseInt(searchParams.get("limit") ?? "10", 10));

  if (q.length < 2) return NextResponse.json({ tasks: [] });

  // Build role-scoped base filter
  const baseWhere: Record<string, unknown> = {};
  if (user.role === UserRole.OPS_AGENT) {
    baseWhere.assignedToId = user.id;
  } else if (user.role === UserRole.STORE_ADMIN) {
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { storeAssignments: true },
    });
    baseWhere.storeId = { in: member?.storeAssignments.map((a) => a.storeId) ?? [] };
  }

  // Check if query is a pure number (order ID search)
  const numericId = parseInt(q, 10);
  const isNumeric = !isNaN(numericId) && String(numericId) === q;

  const orConditions: object[] = [
    { title: { contains: q, mode: "insensitive" } },
  ];
  if (isNumeric) {
    orConditions.push({ entityId: numericId });
    orConditions.push({ id: numericId });
  }

  const tasks = await prisma.task.findMany({
    where: {
      ...baseWhere,
      isArchived: false,
      OR: orConditions,
      status: { notIn: [TaskStatus.CANCELLED] },
    },
    include: {
      assignedTo: { select: { id: true, name: true } },
      taskType: { select: { label: true } },
    },
    orderBy: [{ status: "asc" }, { slaDeadline: "asc" }],
    take: limit,
  });

  return NextResponse.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      entityId: t.entityId,
      slaDeadline: t.slaDeadline,
      assignedTo: t.assignedTo,
      taskType: t.taskType,
    })),
  });
}
