import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { archiveOldTasks, unarchiveTask, unarchiveOrderTasks } from "@/lib/engine/taskArchiver";

/**
 * POST /api/tasks/archive
 * Manually trigger the archive job (normally runs on nightly schedule)
 */
export async function POST(request: NextRequest) {
  try {
    await archiveOldTasks();
    return NextResponse.json({
      success: true,
      message: "Archive job executed successfully"
    });
  } catch (error) {
    console.error("[ArchiveAPI] Error running archive job:", error);
    return NextResponse.json(
      { error: "Failed to run archive job" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tasks/archive
 * Get archive statistics and archived tasks with pagination
 * ?page=1&limit=25
 */
export async function GET(request: NextRequest) {
  try {
    // Get pagination params
    const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "25");
    const offset = (page - 1) * limit;

    console.log(`[ArchiveAPI] Fetching archive stats and tasks (page ${page}, limit ${limit})...`);

    const stats = await prisma.$queryRaw`
      SELECT * FROM taskos."v_archive_stats";
    `;
    console.log("[ArchiveAPI] Stats query result:", stats);

    // Get total count of archived tasks
    const countResult = await prisma.$queryRaw`
      SELECT COUNT(*) as "total" FROM taskos."tasks" WHERE "isArchived" = true;
    `;
    const totalCount = parseInt(String((countResult as any[])[0]?.total || 0), 10);
    const totalPages = Math.ceil(totalCount / limit);

    // Fetch ARCHIVED tasks with pagination - include all fields from tasks table
    const archivedTasks = await prisma.$queryRaw`
      SELECT
        t."id",
        t."title",
        t."status",
        t."priority",
        t."entityId",
        t."storeId",
        t."orderType",
        t."slaDeadline",
        t."slaBreachedAt",
        t."assignedToId",
        t."taskTypeId",
        t."createdAt",
        t."updatedAt",
        t."metadata",
        (SELECT "name" FROM taskos."task_types" WHERE "id" = t."taskTypeId") as "taskTypeName",
        (SELECT "label" FROM taskos."task_types" WHERE "id" = t."taskTypeId") as "taskTypeLabel",
        EXTRACT(DAY FROM NOW() - COALESCE((t."metadata"->>'appointmentTime')::timestamp, t."createdAt")) as "daysSinceAppointment"
      FROM taskos."tasks" t
      WHERE t."isArchived" = true
      ORDER BY t."createdAt" DESC
      LIMIT ${limit} OFFSET ${offset};
    `;
    console.log("[ArchiveAPI] Archived tasks query result:", archivedTasks);

    // Convert BigInt to number for JSON serialization
    const statsFormatted = (stats as any[]).map((s: any) => ({
      ...s,
      count: typeof s.count === 'bigint' ? Number(s.count) : s.count,
      percentage: typeof s.percentage === 'string' ? parseFloat(s.percentage) : s.percentage,
    }));

    const tasksFormatted = (archivedTasks as any[]).map((t: any) => ({
      id: typeof t.id === 'bigint' ? Number(t.id) : t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      entityId: typeof t.entityId === 'bigint' ? Number(t.entityId) : t.entityId,
      storeId: t.storeId ? (typeof t.storeId === 'bigint' ? Number(t.storeId) : t.storeId) : null,
      orderType: t.orderType,
      slaDeadline: t.slaDeadline,
      slaBreachedAt: t.slaBreachedAt,
      assignedToId: t.assignedToId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      taskType: {
        name: t.taskTypeName || "N/A",
        label: t.taskTypeLabel || "N/A"
      },
      daysSinceAppointment: t.daysSinceAppointment != null
        ? Math.floor(Number(t.daysSinceAppointment))
        : 0,
    }));

    return NextResponse.json({
      stats: statsFormatted,
      tasks: tasksFormatted,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
      },
      nextArchiveThreshold: 10 // days
    });
  } catch (error) {
    console.error("[ArchiveAPI] Error fetching archive data:", error);
    return NextResponse.json(
      { error: "Failed to fetch archive data", details: String(error) },
      { status: 500 }
    );
  }
}
