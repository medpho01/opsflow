/**
 * GET  /api/tasks  — fetch tasks for the current user (role-scoped)
 * POST /api/tasks  — create a manual task (OPS_HEAD / STORE_ADMIN only)
 *
 * GET query params:
 *   status     — filter by TaskStatus (comma-separated)
 *   priority   — filter by priority (comma-separated)
 *   assigneeId — filter by assignee IDs (comma-separated)
 *   storeId    — filter by store
 *   orderId    — filter by order ID (entityId)
 *   dateFrom   — filter tasks created from this date (ISO 8601)
 *   dateTo     — filter tasks created until this date (ISO 8601)
 *   slaRiskOnly — if true, show only tasks with SLA warnings/breaches (true/false)
 *   sortBy     — sort field: createdAt|appointmentTime|slaDeadline|status|priority (default: priority)
 *   sortOrder  — sort direction: asc|desc (default: desc for most, asc for dates)
 *   page       — pagination (default 1)
 *   limit      — page size (default 20)
 *
 * POST body:
 *   { title, taskTypeId, priority, entityId, storeId?, slaMinutes, assignedToId?, note? }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { TaskStatus, TaskPriority, UserRole } from "@prisma/client";

// Whitelist of valid sort fields (Phase 1 MVP)
const VALID_SORT_FIELDS = ["createdAt", "appointmentTime", "slaDeadline", "status", "priority"] as const;
type SortField = (typeof VALID_SORT_FIELDS)[number];

// Type-safe sort order
type SortOrder = "asc" | "desc";

/**
 * Format relative time for display (e.g., "45m ago", "in 2h")
 */
function getRelativeTime(pastDate: Date, nowDate: Date): string {
  const diffMs = nowDate.getTime() - pastDate.getTime();
  const diffMins = Math.round(diffMs / (60 * 1000));

  if (diffMins < 0) {
    const absMins = Math.abs(diffMins);
    if (absMins < 60) return `in ${absMins}m`;
    const hours = Math.round(absMins / 60);
    return `in ${hours}h`;
  }

  if (diffMins < 60) return `${diffMins}m ago`;
  const hours = Math.round(diffMins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Build the orderBy clause for Prisma query based on sortBy parameter
 * Handles tiebreakers (e.g., same priority → sort by createdAt)
 * Handles NULL values appropriately (e.g., appointmentTime NULL → end of results)
 */
function buildOrderBy(sortBy: SortField, sortOrder: SortOrder): Array<Record<string, string>> {
  switch (sortBy) {
    case "createdAt":
      // Creation date: newer first by default (desc)
      return sortOrder === "asc"
        ? [{ createdAt: "asc" }]
        : [{ createdAt: "desc" }];

    case "appointmentTime":
      // Appointment date: sort by appointment time, then by priority as tiebreaker
      return sortOrder === "asc"
        ? [
            { appointmentTime: "asc" },
            { priority: "desc" },
          ]
        : [
            { appointmentTime: "desc" },
            { priority: "desc" },
          ];

    case "slaDeadline":
      // SLA deadline: ascending (most urgent first)
      // Tiebreaker: priority (URGENT before HIGH, etc.)
      return sortOrder === "asc"
        ? [
            { slaDeadline: "asc" },
            { priority: "desc" },
            { createdAt: "asc" },
          ]
        : [
            { slaDeadline: "desc" },
            { priority: "desc" },
            { createdAt: "asc" },
          ];

    case "status":
      // Status: custom order (created → assigned → in_progress → completed)
      // Tiebreaker: createdAt (older tasks first)
      // Note: For status sorting, we'll rely on enum order from DB
      return [
        { status: sortOrder === "asc" ? "asc" : "desc" },
        { priority: "desc" }, // secondary tiebreaker
        { createdAt: "asc" }, // tertiary tiebreaker
      ];

    case "priority":
      // Priority: URGENT → HIGH → MEDIUM → LOW (desc order naturally)
      // Tiebreaker: createdAt (older tasks first)
      return sortOrder === "asc"
        ? [
            { priority: "asc" },
            { createdAt: "asc" },
          ]
        : [
            { priority: "desc" },
            { createdAt: "asc" },
          ];

    default:
      // Fallback (should never happen with validation)
      return [{ priority: "desc" }, { createdAt: "asc" }];
  }
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const priorityParam = searchParams.get("priority");
  const assigneeIdParam = searchParams.get("assigneeId");
  const storeId = searchParams.get("storeId");
  const orderId = searchParams.get("orderId");
  const dateFromParam = searchParams.get("dateFrom");
  const dateToParam = searchParams.get("dateTo");
  const slaRiskOnlyParam = searchParams.get("slaRiskOnly");
  const sourceParam = searchParams.get("source");
  const sourceTypeParam = searchParams.get("sourceType");
  const sortByParam = searchParams.get("sortBy") ?? "priority";
  const sortOrderParam = searchParams.get("sortOrder") ?? "desc";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));

  // Foundation Feature: Get current time for SLA calculations
  const now = new Date();

  // Validate sortBy parameter
  if (!VALID_SORT_FIELDS.includes(sortByParam as SortField)) {
    return NextResponse.json(
      { error: `Invalid sortBy. Valid options: ${VALID_SORT_FIELDS.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate sortOrder parameter
  if (!["asc", "desc"].includes(sortOrderParam)) {
    return NextResponse.json(
      { error: "Invalid sortOrder. Valid options: asc, desc" },
      { status: 400 }
    );
  }

  const sortBy = sortByParam as SortField;
  const sortOrder = sortOrderParam as SortOrder;

  // Parse status filter (comma-separated, validated against enum)
  const statusFilter = statusParam
    ? statusParam.split(",").filter((s) => Object.values(TaskStatus).includes(s as TaskStatus)) as TaskStatus[]
    : undefined;

  // Parse priority filter (comma-separated)
  const priorityFilter = priorityParam
    ? priorityParam.split(",").filter((p) => p.length > 0)
    : undefined;

  // Parse source filter (comma-separated)
  const sourceFilter = sourceParam
    ? sourceParam.split(",").filter((s) => s.length > 0)
    : undefined;

  // Parse source type filter (comma-separated)
  const sourceTypeFilter = sourceTypeParam
    ? sourceTypeParam.split(",").filter((st) => st.length > 0)
    : undefined;

  // Parse assignee IDs filter (comma-separated)
  const assigneeIdFilter = assigneeIdParam
    ? assigneeIdParam
        .split(",")
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id))
    : undefined;

  // Parse date range filters
  let dateFromFilter: Date | undefined;
  let dateToFilter: Date | undefined;
  if (dateFromParam) {
    const parsed = new Date(dateFromParam);
    if (!isNaN(parsed.getTime())) dateFromFilter = parsed;
  }
  if (dateToParam) {
    const parsed = new Date(dateToParam);
    if (!isNaN(parsed.getTime())) dateToFilter = parsed;
  }

  // Parse SLA risk filter
  const slaRiskOnly = slaRiskOnlyParam === "true";

  // Role-based scoping
  const where: Record<string, unknown> = {};

  if (user.role === UserRole.OPS_AGENT) {
    where.assignedToId = user.id;
  } else if (user.role === UserRole.STORE_ADMIN) {
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { storeAssignments: true },
    });
    const ids = member?.storeAssignments.map((a) => a.storeId) ?? [];
    where.storeId = { in: ids };
  }
  // OPS_HEAD sees everything

  // ARCHIVE SYSTEM: Exclude archived tasks from active view
  where.isArchived = false;

  // Apply filters
  if (statusFilter?.length) where.status = { in: statusFilter };
  if (priorityFilter?.length) where.priority = { in: priorityFilter };
  if (assigneeIdFilter?.length) where.assignedToId = { in: assigneeIdFilter };
  if (storeId) where.storeId = parseInt(storeId, 10);
  if (orderId) where.entityId = parseInt(orderId, 10);
  if (sourceFilter?.length) where.source = { in: sourceFilter };
  if (sourceTypeFilter?.length) where.sourceType = { in: sourceTypeFilter };

  // Date range filtering
  if (dateFromFilter || dateToFilter) {
    where.createdAt = {};
    if (dateFromFilter) (where.createdAt as Record<string, unknown>).gte = dateFromFilter;
    if (dateToFilter) (where.createdAt as Record<string, unknown>).lte = dateToFilter;
  }

  // Build the orderBy clause with tiebreakers
  const orderBy = buildOrderBy(sortBy, sortOrder);

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        assignedTo: { select: { id: true, name: true } },
        checklistItems: { orderBy: { stepOrder: "asc" } },
        taskType: { select: { name: true, label: true } },
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.task.count({ where }),
  ]);

  // Foundation Features: Add calculated fields
  const tasksWithMeta = tasks.map((task) => {
    // C3: Color-coded urgency (slaStatus)
    let slaStatus: "safe" | "warning" | "critical" | "breached" = "safe";
    const minutesRemaining = (new Date(task.slaDeadline).getTime() - now.getTime()) / (60 * 1000);

    if (task.status === "BREACHED" || minutesRemaining < 0) {
      slaStatus = "breached";
    } else if (minutesRemaining < 10) {
      slaStatus = "critical";
    } else if (minutesRemaining < 30) {
      slaStatus = "warning";
    }

    // C5: Assignment status visibility
    const assignmentMethod = task.assignmentMethod || "auto"; // default to auto if not specified
    const assignmentRuleId = task.assignmentRuleId || task.taskRuleId; // fallback to task rule

    // Phase 3 Feature 13: Task Aging Indicator
    const lastStatusChangeTime = task.lastStatusUpdate || task.createdAt;
    const minutesInStatus = Math.floor((now.getTime() - lastStatusChangeTime.getTime()) / (60 * 1000));

    // Default thresholds (can be customized per task type)
    const normalAgingMinutes = 30;
    const warningAgingMinutes = 45;
    const criticalAgingMinutes = 60;

    let ageColor = "green";
    if (minutesInStatus > criticalAgingMinutes) ageColor = "red";
    else if (minutesInStatus > warningAgingMinutes) ageColor = "yellow";

    const aging = {
      minutesInStatus,
      isStuck: minutesInStatus > criticalAgingMinutes,
      stuckThreshold: criticalAgingMinutes,
      ageColor,
      displayText: `${task.status} for ${minutesInStatus} mins`,
    };

    // Phase 2 Feature 7: SLA Context for timeline visualization
    const slaContext = {
      createdAt: task.createdAt.toISOString(),
      slaMinutes: Math.round((new Date(task.slaDeadline).getTime() - task.createdAt.getTime()) / (60 * 1000)),
      minutesRemaining: Math.max(-999999, minutesRemaining), // can be negative if breached
      breachedAt: task.slaBreachedAt ? task.slaBreachedAt.toISOString() : null,
      breachedSince: task.slaBreachedAt
        ? Math.round((now.getTime() - task.slaBreachedAt.getTime()) / (60 * 1000))
        : null,
      timeline: {
        created: {
          label: "Created",
          time: task.createdAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          relativeTime: getRelativeTime(task.createdAt, now),
        },
        deadline: {
          label: "SLA Deadline",
          time: new Date(task.slaDeadline).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          relativeTime: getRelativeTime(new Date(task.slaDeadline), now),
        },
        ...(task.slaBreachedAt && {
          breached: {
            label: "Breached",
            time: task.slaBreachedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
            relativeTime: getRelativeTime(task.slaBreachedAt, now),
          },
        }),
      },
    };

    return {
      ...task,
      slaStatus,
      minutesRemaining: Math.max(0, minutesRemaining),
      assignmentMethod,
      assignmentRuleId,
      slaContext,
      aging,
    };
  });

  // Phase 2: Apply SLA risk filter (warning, critical, or breached)
  let filteredTasks = tasksWithMeta;
  if (slaRiskOnly) {
    filteredTasks = tasksWithMeta.filter(
      (task) => task.slaStatus === "warning" || task.slaStatus === "critical" || task.slaStatus === "breached"
    );
  }

  // Build appliedFilters response object for UI
  const appliedFilters: Record<string, unknown> = {};
  if (statusFilter?.length) appliedFilters.status = statusFilter;
  if (priorityFilter?.length) appliedFilters.priority = priorityFilter;
  if (assigneeIdFilter?.length) appliedFilters.assigneeId = assigneeIdFilter;
  if (storeId) appliedFilters.storeId = parseInt(storeId, 10);
  if (dateFromFilter) appliedFilters.dateFrom = dateFromFilter.toISOString();
  if (dateToFilter) appliedFilters.dateTo = dateToFilter.toISOString();
  if (slaRiskOnly) appliedFilters.slaRiskOnly = true;
  if (sourceFilter?.length) appliedFilters.source = sourceFilter;
  if (sourceTypeFilter?.length) appliedFilters.sourceType = sourceTypeFilter;

  const filterCount = Object.keys(appliedFilters).length;

  return NextResponse.json({
    tasks: filteredTasks,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    sorting: { sortBy, sortOrder },
    appliedFilters,
    filterCount,
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === UserRole.OPS_AGENT) {
    return NextResponse.json({ error: "Agents cannot create tasks" }, { status: 403 });
  }

  const body = await request.json();
  const { title, taskTypeId, priority, entityId, storeId, slaMinutes, assignedToId, note } = body;

  if (!title || !taskTypeId || !priority || !entityId || !slaMinutes) {
    return NextResponse.json(
      { error: "title, taskTypeId, priority, entityId, slaMinutes are required" },
      { status: 400 }
    );
  }

  if (!Object.values(TaskPriority).includes(priority)) {
    return NextResponse.json({ error: `Invalid priority: ${priority}` }, { status: 400 });
  }

  // Ensure the MANUAL sentinel task rule exists
  const manualRule = await prisma.taskRule.upsert({
    where: { id: "MANUAL" },
    create: {
      id: "MANUAL",
      name: "Manual Task",
      orderType: "HOME_SAMPLE",
      taskTypeId: parseInt(taskTypeId, 10),
      titleTemplate: "{title}",
      slaMinutes: 60,
      priority: TaskPriority.MEDIUM,
      triggerCondition: {},
      isActive: true,
    },
    update: {},
  });

  const slaDeadline = new Date(Date.now() + Number(slaMinutes) * 60_000);

  // Optionally verify the assignee exists and is an agent
  let resolvedAssigneeId: number | null = null;
  let resolvedTeamMemberId: number | null = null;
  if (assignedToId) {
    const assignee = await prisma.user.findUnique({
      where: { id: Number(assignedToId) },
      include: { teamMember: true },
    });
    if (assignee) {
      resolvedAssigneeId = assignee.id;
      resolvedTeamMemberId = assignee.teamMember?.id ?? null;

      // Roster Check: Verify agent is available for task assignment
      if (resolvedTeamMemberId) {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const dayOfWeek = today.getUTCDay();

        // Get schedule for today
        const schedule = await prisma.weeklySchedule.findFirst({
          where: {
            teamMemberId: resolvedTeamMemberId,
            dayOfWeek,
          },
        });

        // Get exception for today (if any)
        const exception = await prisma.rosterException.findUnique({
          where: {
            teamMemberId_date: {
              teamMemberId: resolvedTeamMemberId,
              date: new Date(dateStr),
            },
          },
        });

        // Determine status
        let status = "ACTIVE";
        if (exception) {
          status = exception.status;
        } else if (!schedule || !schedule.isWorking) {
          status = "OFF";
        }

        // Only allow assignment if ACTIVE
        if (status !== "ACTIVE") {
          return NextResponse.json(
            {
              error: `Agent not available on ${dateStr} - status: ${status}`,
              code: "AGENT_UNAVAILABLE",
              details: { agentId: resolvedAssigneeId, date: dateStr, rosterStatus: status },
            },
            { status: 400 }
          );
        }
      }
    }
  }

  const task = await prisma.task.create({
    data: {
      taskRuleId: manualRule.id,
      taskTypeId: parseInt(taskTypeId, 10),
      title,
      entityType: "ORDER",
      entityId: Number(entityId),
      storeId: storeId ? Number(storeId) : null,
      orderType: "HOME_SAMPLE",
      priority,
      status: resolvedAssigneeId ? TaskStatus.ASSIGNED : TaskStatus.CREATED,
      assignedToId: resolvedAssigneeId,
      teamMemberId: resolvedTeamMemberId,
      assignedAt: resolvedAssigneeId ? new Date() : null,
      slaDeadline,
      metadata: { manual: true, createdBy: user.name, createdById: user.id },
      history: {
        create: {
          status: resolvedAssigneeId ? TaskStatus.ASSIGNED : TaskStatus.CREATED,
          changedById: user.id,
          note: note ? `Manual task created: ${note}` : "Manual task created by Ops Head",
        },
      },
    },
    include: {
      assignedTo: { select: { id: true, name: true } },
      checklistItems: { orderBy: { stepOrder: "asc" } },
      taskType: { select: { name: true, label: true } },
    },
  });

  return NextResponse.json({ task }, { status: 201 });
}
