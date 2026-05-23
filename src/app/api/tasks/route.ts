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
const VALID_SORT_FIELDS = ["createdAt", "appointmentTime", "slaDeadline", "status", "priority", "urgency"] as const;
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
 * Compute urgency bucket for smart "what needs attention now" ordering.
 *
 * Buckets (lower = more urgent):
 *   0  IMMINENT     appointment within (-15 min … +30 min) of now
 *   1  TODAY        today IST, more than 30 min in the future
 *   2  PAST_TODAY   today IST, more than 15 min in the past
 *   3  TOMORROW     tomorrow IST
 *   4  FUTURE       2+ days away
 *   5  PAST_OLD     yesterday or earlier
 *   6  NO_APPT      null appointmentTime
 *
 * All timestamps are treated as proper UTC; IST offsets are applied only for
 * "which calendar day is this?" comparisons.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h30m in ms

function istDayKey(utcDate: Date): string {
  const ist = new Date(utcDate.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${ist.getUTCMonth()}-${ist.getUTCDate()}`;
}

function computeUrgencyBucket(appt: Date | null, now: Date): number {
  if (!appt || isNaN(appt.getTime())) return 6;
  const diffMin = (appt.getTime() - now.getTime()) / 60_000;

  if (diffMin >= -15 && diffMin <= 30) return 0; // IMMINENT

  const nowDay = istDayKey(now);
  const apptDay = istDayKey(appt);
  const tomorrowDay = istDayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  if (diffMin > 30) {
    if (apptDay === nowDay) return 1;      // TODAY (upcoming)
    if (apptDay === tomorrowDay) return 3; // TOMORROW
    return 4;                              // FUTURE (2+ days)
  }
  // diffMin < -15 → past
  return apptDay === nowDay ? 2 : 5;     // PAST_TODAY or PAST_OLD
}

const URGENCY_LABELS: Record<number, string> = {
  0: "⚡ Imminent",
  1: "📅 Today",
  2: "⏰ Past (Today)",
  3: "🔜 Tomorrow",
  4: "📆 Upcoming",
  5: "📋 Past",
  6: "—",
};

/**
 * Phase-1 view bucket — coarser than urgencyBucket, designed for the
 * Today / Tomorrow / Stuck navigation in the My Work view.
 *
 *   "today"    appt is today IST AND appt+30min has not passed
 *              OR no appt + created today + not completed
 *   "tomorrow" appt is tomorrow IST
 *   "stuck"    appt+30min has passed AND task status is non-terminal
 *              OR explicit BREACHED status with non-terminal state
 *   "future"   appt is 2+ days out (visible only when explicitly requested)
 *   "done"     task is in a terminal status (COMPLETED / CANCELLED / RESOLVED)
 *              — handled separately, kept out of the live buckets
 *
 * Sliding-window subdivisions inside "today" (NOW / LATER / PREP / DONE_TODAY)
 * are computed on the client where the page can react to real-time clock ticks
 * without re-hitting the API.
 */
type ViewBucket = "today" | "tomorrow" | "stuck" | "future" | "done";

const TERMINAL_STATUSES_FOR_BUCKET = new Set<string>([
  "COMPLETED", "CANCELLED", "RESOLVED",
]);

function computeViewBucket(
  appt: Date | null,
  createdAt: Date,
  status: string,
  now: Date,
): ViewBucket {
  if (TERMINAL_STATUSES_FOR_BUCKET.has(status)) return "done";

  const stuckGraceMs = 30 * 60 * 1000;
  const nowDay = istDayKey(now);
  const tomorrowDay = istDayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  if (appt && !isNaN(appt.getTime())) {
    const apptDay = istDayKey(appt);
    const pastGrace = now.getTime() - appt.getTime() > stuckGraceMs;

    if (pastGrace) return "stuck"; // missed appt, lifecycle didn't advance
    if (apptDay === nowDay) return "today";
    if (apptDay === tomorrowDay) return "tomorrow";
    return "future";
  }

  // No appointment → fall back to createdAt for day bucketing
  const createdDay = istDayKey(createdAt);
  if (createdDay === nowDay) return "today";
  if (createdDay === tomorrowDay) return "tomorrow";
  // Older-than-today, no appt, not terminal → treat as stuck (something to revisit)
  return "stuck";
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
      // Appointment date: most imminent first (asc) — what needs attention now.
      // Tiebreakers: SLA deadline (most urgent first), then priority.
      // Tasks with NULL appointmentTime sort to the end on asc by default in Prisma.
      return sortOrder === "asc"
        ? [
            { appointmentTime: "asc" },
            { slaDeadline: "asc" },
            { priority: "desc" },
          ]
        : [
            { appointmentTime: "desc" },
            { slaDeadline: "asc" },
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
  const dataSourceIdParam = searchParams.get("dataSourceId");
  // Phase-1 My Work view: filter to a coarse bucket (today/tomorrow/stuck).
  // Accepts comma-separated values for combined views if needed later.
  const viewParam = searchParams.get("view"); // "today" | "tomorrow" | "stuck" | "future" | null = all
  // Default sort: urgency bucket — puts imminent appointments first, then
  // today's upcoming tasks, then tomorrow, then future, then past.
  // This surfaces tasks that need immediate attention without requiring the
  // user to think about sort settings.
  const sortByParam = searchParams.get("sortBy") ?? "urgency";
  const sortOrderParam = searchParams.get("sortOrder") ?? "asc";
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

  // Parse priority filter (comma-separated, validated against enum).
  // Audit yellow-bug: previously unvalidated; an invalid value crashed
  // the Prisma query with a 500.
  const priorityFilter = priorityParam
    ? priorityParam
        .split(",")
        .filter((p) => Object.values(TaskPriority).includes(p as TaskPriority)) as TaskPriority[]
    : undefined;

  // Parse source filter (comma-separated)
  const sourceFilter = sourceParam
    ? sourceParam.split(",").filter((s) => s.length > 0)
    : undefined;

  // Parse source type filter (comma-separated)
  const sourceTypeFilter = sourceTypeParam
    ? sourceTypeParam.split(",").filter((st) => st.length > 0)
    : undefined;

  // Parse data-source ID filter (comma-separated CUIDs from data_sources.id)
  const dataSourceIdFilter = dataSourceIdParam
    ? dataSourceIdParam.split(",").filter((id) => id.length > 0)
    : undefined;

  // Parse assignee IDs filter (comma-separated)
  const assigneeIdFilter = assigneeIdParam
    ? assigneeIdParam
        .split(",")
        .map((id) => parseInt(id, 10))
        .filter((id) => !isNaN(id))
    : undefined;

  // Parse date range filters.
  //
  // Audit yellow-bug on `dateTo`: when the UI passes a date-only string like
  // "2026-05-09", `new Date("2026-05-09")` parses to 00:00 UTC of that day,
  // and the `lte` filter then misses every task created during that day.
  // Bump date-only `dateTo` to the END of the day so the inclusive filter
  // does what users expect. Detect by checking for the absence of a time
  // component in the original string.
  let dateFromFilter: Date | undefined;
  let dateToFilter: Date | undefined;
  if (dateFromParam) {
    const parsed = new Date(dateFromParam);
    if (!isNaN(parsed.getTime())) dateFromFilter = parsed;
  }
  if (dateToParam) {
    const parsed = new Date(dateToParam);
    if (!isNaN(parsed.getTime())) {
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateToParam);
      dateToFilter = isDateOnly
        ? new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1)
        : parsed;
    }
  }

  // Parse SLA risk filter
  const slaRiskOnly = slaRiskOnlyParam === "true";

  // W5 — `excludeSnoozed=true` drops snoozed-future tasks from the result.
  // The agent's Active tab + tab-count fetches always pass this; the head
  // view leaves it off so monitoring isn't blinded.
  const excludeSnoozed = searchParams.get("excludeSnoozed") === "true";

  // Role-based scoping.
  //
  // Audit P0 #2 — STORE_ADMIN scoping bypass. The previous implementation
  // set `where.storeId = { in: <admin's stores> }` and was overwritten two
  // lines later by `if (storeId) where.storeId = parseInt(...)`, letting a
  // STORE_ADMIN read tasks for any store by passing `?storeId=X`.
  //
  // Fix: derive the admin's store list FIRST, then compose the
  // user-supplied `storeId` filter against that list (intersect, never
  // overwrite). OPS_AGENT scope (own tasks) is composed similarly so an
  // explicit `assigneeId` filter can't broaden it.
  const where: Record<string, unknown> = {};
  let adminStoreIds: number[] | null = null; // null = no role-based store gate

  if (user.role === UserRole.OPS_AGENT) {
    where.assignedToId = user.id;
  } else if (user.role === UserRole.STORE_ADMIN) {
    const member = await prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { storeAssignments: { select: { storeId: true } } },
    });
    adminStoreIds = member?.storeAssignments.map((a) => a.storeId) ?? [];
  }
  // OPS_HEAD sees everything

  // ARCHIVE SYSTEM: Exclude archived tasks from active view
  where.isArchived = false;

  // Apply filters
  if (statusFilter?.length) where.status = { in: statusFilter };
  if (priorityFilter?.length) where.priority = { in: priorityFilter };
  // Compose, don't overwrite: agent's own scope already bound `assignedToId`.
  // For non-agents, an `assigneeId=...` param applies as the only constraint.
  if (assigneeIdFilter?.length && user.role !== UserRole.OPS_AGENT) {
    where.assignedToId = { in: assigneeIdFilter };
  }

  // ── Store scoping (compose with role-based admin scope) ───────────────
  // - OPS_HEAD with no `storeId` param: no store gate.
  // - OPS_HEAD with `storeId`: gate to that store.
  // - STORE_ADMIN with no `storeId` param: gate to admin's stores.
  // - STORE_ADMIN with `storeId`: gate to that store iff it's in admin's
  //   stores; otherwise gate to id=-1 (returns nothing) — never broaden.
  if (adminStoreIds !== null) {
    if (storeId) {
      const requested = parseInt(storeId, 10);
      where.storeId = adminStoreIds.includes(requested) ? requested : -1;
    } else {
      where.storeId = { in: adminStoreIds };
    }
  } else if (storeId) {
    where.storeId = parseInt(storeId, 10);
  }

  if (orderId) where.entityId = parseInt(orderId, 10);
  if (sourceFilter?.length) where.source = { in: sourceFilter };
  if (sourceTypeFilter?.length) where.sourceType = { in: sourceTypeFilter };
  // Filter by data source via taskRule relation
  if (dataSourceIdFilter?.length) {
    where.taskRule = { dataSourceId: { in: dataSourceIdFilter } };
  }

  // Date range filtering
  if (dateFromFilter || dateToFilter) {
    where.createdAt = {};
    if (dateFromFilter) (where.createdAt as Record<string, unknown>).gte = dateFromFilter;
    if (dateToFilter) (where.createdAt as Record<string, unknown>).lte = dateToFilter;
  }

  // SLA-risk filter pushed into the SQL WHERE (was previously applied AFTER
  // pagination, which made `pagination.total` wrong — the count came from
  // the unfiltered query while the page came from the filtered subset). The
  // semantics match the slaStatus mapping below: warning (<30min remaining),
  // critical (<10min), or breached (slaDeadline < now OR status=BREACHED).
  if (slaRiskOnly) {
    const warningCutoff = new Date(now.getTime() + 30 * 60 * 1000);
    where.OR = [
      { status: TaskStatus.BREACHED },
      { slaDeadline: { lt: warningCutoff } },
    ];
  }

  // W5 — Hide tasks that are still snoozed. Two-condition AND captured via
  // a Prisma `OR` array (snooze is null) OR (snooze is past) — task is
  // visible. Composed before the OR slot used by slaRiskOnly above; if both
  // are active we use AND with both predicates instead of stomping the OR.
  if (excludeSnoozed) {
    const notSnoozed = {
      OR: [
        { snoozedUntil: null },
        { snoozedUntil: { lte: now } },
      ],
    };
    if (where.OR) {
      // slaRiskOnly already set OR — combine with AND so both filters apply.
      where.AND = [{ OR: where.OR }, notSnoozed];
      delete where.OR;
    } else {
      Object.assign(where, notSnoozed);
    }
  }

  // Build the orderBy clause with tiebreakers (not used for urgency sort)
  const orderBy = buildOrderBy(sortBy as SortField, sortOrder);
  const isUrgencySort = sortBy === "urgency";

  const include = {
    assignedTo: { select: { id: true, name: true } },
    checklistItems: { orderBy: { stepOrder: "asc" } },
    taskType: { select: { name: true, label: true } },
    taskRule: {
      select: {
        dataSourceId: true,
        dataSource: { select: { id: true, sourceId: true, displayName: true } },
      },
    },
  } as const;

  // Fetch-all mode when we need to sort/filter post-compute:
  //   - urgency sort (computed bucket, can't ORDER BY in SQL)
  //   - view filter (Today/Tomorrow/Stuck is computed, not a DB column)
  // For typical workspaces (<500 active tasks) this is fine.
  const isViewFilter = !!viewParam;
  const isFullFetch = isUrgencySort || isViewFilter;

  const [tasks, total] = await Promise.all([
    isFullFetch
      ? prisma.task.findMany({ where, include, orderBy: [{ appointmentTime: "asc" }] })
      : prisma.task.findMany({ where, include, orderBy, skip: (page - 1) * limit, take: limit }),
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

    // Flatten the data source info onto the top of the task for easy UI access
    const dataSource = task.taskRule?.dataSource
      ? {
          id: task.taskRule.dataSource.id,
          sourceId: task.taskRule.dataSource.sourceId,
          displayName: task.taskRule.dataSource.displayName,
        }
      : null;

    // Urgency bucket — computed for every task regardless of sort mode so
    // the UI can always display a badge and group tasks visually.
    const appt = task.appointmentTime ? new Date(task.appointmentTime) : null;
    const urgencyBucket = computeUrgencyBucket(appt, now);
    const urgencyLabel = URGENCY_LABELS[urgencyBucket] ?? "—";

    // Phase-1 view bucket for My Work navigation.
    const viewBucket = computeViewBucket(appt, task.createdAt, task.status, now);

    return {
      ...task,
      // sourceEntityId is a BigInt in the DB — convert to string so JSON.stringify doesn't throw
      sourceEntityId: task.sourceEntityId != null ? task.sourceEntityId.toString() : null,
      slaStatus,
      // Signed minutesRemaining — negative means breached by N min. The
      // previous `Math.max(0, ...)` clamped to zero and lost the magnitude
      // every breach UI needs to render "breached by 12m".
      minutesRemaining,
      assignmentMethod,
      assignmentRuleId,
      slaContext,
      aging,
      dataSource,
      urgencyBucket,
      urgencyLabel,
      viewBucket,
    };
  });

  let filteredTasks = tasksWithMeta;

  // ── view filter (Today / Tomorrow / Stuck / Future) ───────────────
  // Computed bucket can't be a SQL WHERE; filter post-meta. Updates `total`
  // to the filtered count so pagination semantics stay correct.
  let effectiveTotal = total;
  if (isViewFilter) {
    const wantedBuckets = viewParam!.split(",").map(v => v.trim());
    filteredTasks = filteredTasks.filter(t => wantedBuckets.includes(t.viewBucket));
    effectiveTotal = filteredTasks.length;
  }

  // ── urgency sort (in-memory bucket sort + tiebreakers) ────────────
  if (isUrgencySort) {
    filteredTasks = [...filteredTasks].sort((a, b) => {
      if (a.urgencyBucket !== b.urgencyBucket) return a.urgencyBucket - b.urgencyBucket;
      const at = a.appointmentTime ? new Date(a.appointmentTime).getTime() : null;
      const bt = b.appointmentTime ? new Date(b.appointmentTime).getTime() : null;
      if (!at && !bt) return 0;
      if (!at) return 1;
      if (!bt) return -1;
      const pastBucket = a.urgencyBucket === 2 || a.urgencyBucket === 5;
      return pastBucket ? bt - at : at - bt; // DESC for past, ASC for future
    });
  }

  // ── pagination slice for any full-fetch path ──────────────────────
  if (isFullFetch) {
    filteredTasks = filteredTasks.slice((page - 1) * limit, page * limit);
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
  if (dataSourceIdFilter?.length) appliedFilters.dataSourceId = dataSourceIdFilter;
  if (viewParam) appliedFilters.view = viewParam;

  const filterCount = Object.keys(appliedFilters).length;

  return NextResponse.json({
    tasks: filteredTasks,
    pagination: { page, limit, total: effectiveTotal, pages: Math.ceil(effectiveTotal / limit) },
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

  // Ensure the MANUAL sentinel task rule exists.
  //
  // The MANUAL rule is a row whose `id = 'MANUAL'` carries every manually-
  // created or system-archived task's FK. It needs a valid dataSourceId
  // because TaskRule.dataSourceId is NOT NULL — but the row has no semantic
  // tie to any specific source. Pick the OLDEST active source as a stable
  // anchor (was: random-first; sources getting deleted left a stale FK).
  //
  // The upsert refreshes the dataSourceId on every manual-task POST so a
  // deleted source can never leave it dangling for long.
  const anchorSource = await prisma.dataSource.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!anchorSource) {
    return NextResponse.json({ error: "No active data sources configured" }, { status: 500 });
  }
  const manualRule = await prisma.taskRule.upsert({
    where: { id: "MANUAL" },
    create: {
      id: "MANUAL",
      name: "Manual Task",
      dataSourceId: anchorSource.id,
      taskTypeId: parseInt(taskTypeId, 10),
      titleTemplate: "{title}",
      slaMinutes: 60,
      priority: TaskPriority.MEDIUM,
      triggerCondition: {},
      isActive: false,
    },
    // W1.2: refresh the anchor on every call so a deleted-and-recreated
    // source can't leave the MANUAL rule pointing at a non-existent FK.
    update: { dataSourceId: anchorSource.id },
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
      orderType: "MANUAL",
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
