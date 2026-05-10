/**
 * /api/tasks/archive — manual archive trigger + paged archived-task listing.
 *
 * Audit P0 #3: this route used to be open. Both verbs now require an
 * authenticated OPS_HEAD. Archived tasks contain order history and
 * patient-related metadata; they are not public.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { archiveOldTasks } from "@/lib/engine/taskArchiver";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (user.role !== UserRole.OPS_HEAD) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

/**
 * POST /api/tasks/archive
 * Manually trigger the archive job (normally runs on nightly schedule).
 */
export async function POST(request: NextRequest) {
  const auth = await requireOpsHead(request);
  if ("error" in auth) return auth.error;

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
  const auth = await requireOpsHead(request);
  if ("error" in auth) return auth.error;

  try {
    // Get pagination params
    const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "25");
    const offset = (page - 1) * limit;

    console.log(`[ArchiveAPI] Fetching archive stats and tasks (page ${page}, limit ${limit})...`);

    // Compute archive stats directly (the v_archive_stats view was removed).
    // Returns the same shape the UI expects: rows with { category, count, percentage }.
    const statsRaw = await prisma.$queryRaw<
      Array<{ active_count: bigint; archived_count: bigint }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE "isArchived" = false) AS active_count,
        COUNT(*) FILTER (WHERE "isArchived" = true)  AS archived_count
      FROM taskos."tasks";
    `;
    const activeCount = Number(statsRaw[0]?.active_count ?? 0);
    const archivedCount = Number(statsRaw[0]?.archived_count ?? 0);
    const totalAll = activeCount + archivedCount;
    const stats = [
      { category: "Active Tasks",   count: activeCount,   percentage: totalAll > 0 ? (activeCount / totalAll) * 100 : 0 },
      { category: "Archived Tasks", count: archivedCount, percentage: totalAll > 0 ? (archivedCount / totalAll) * 100 : 0 },
    ];

    // Get total count of archived tasks
    const countResult = await prisma.$queryRaw`
      SELECT COUNT(*) as "total" FROM taskos."tasks" WHERE "isArchived" = true;
    `;
    const totalCount = parseInt(String((countResult as any[])[0]?.total || 0), 10);
    const totalPages = Math.ceil(totalCount / limit);

    // Fetch ARCHIVED tasks with pagination.
    //
    // Audit perf finding: previously each row issued 4 correlated subselects
    // for taskTypeName, taskTypeLabel, dataSourceName, dataSourceId. At
    // archive scale this scaled with N×4 lookups. Replaced with two LEFT
    // JOINs against task_types + task_rules + data_sources.
    //
    // Audit P1: `EXTRACT(DAY FROM NOW() - x)` returned 0–30 (the day
    // component, not the absolute number of days). For tasks older than a
    // month the UI showed 5 instead of 35. Replaced with EPOCH-based math
    // that produces the true number of days regardless of size.
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
        tt."name"        AS "taskTypeName",
        tt."label"       AS "taskTypeLabel",
        ds."displayName" AS "dataSourceName",
        tr."dataSourceId" AS "dataSourceId",
        FLOOR(
          EXTRACT(EPOCH FROM
            NOW() - COALESCE((t."metadata"->>'appointmentTime')::timestamp, t."createdAt")
          ) / 86400
        ) AS "daysSinceAppointment"
      FROM taskos."tasks" t
      LEFT JOIN taskos."task_types" tt ON tt."id" = t."taskTypeId"
      LEFT JOIN taskos."task_rules" tr ON tr."id" = t."taskRuleId"
      LEFT JOIN taskos."data_sources" ds ON ds."id" = tr."dataSourceId"
      WHERE t."isArchived" = true
      ORDER BY t."createdAt" DESC
      LIMIT ${limit} OFFSET ${offset};
    `;

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
      dataSource: t.dataSourceId
        ? { id: t.dataSourceId, displayName: t.dataSourceName || t.dataSourceId }
        : null,
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
