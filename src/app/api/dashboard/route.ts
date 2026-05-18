/**
 * GET /api/dashboard — aggregate stats for the OPS_HEAD command center.
 *
 * Audit W1 (feature 08) rewrites:
 *
 *  P0 — `dailyRosters` was the legacy table that no path writes any more
 *       (replaced by weekly_schedules + roster_exceptions in
 *       lib/roster/availability.ts). The dashboard kept reading it, so
 *       Team Status defaulted every member to "OFF" — every load of /head
 *       lied about who was working. Now uses computeRosterStatus(), the
 *       same helper /api/team and the assignment engine use.
 *
 *  P0 — `now.setHours(0, 0, 0, 0)` mutated the shared `now` reference, so
 *       every comparison after the "completedToday" query saw a midnight-
 *       anchored value instead of the original `now`. Switched to a
 *       non-mutating IST-anchored start-of-day computed via Intl rather
 *       than the Date.setHours mutation pattern.
 *
 *  P1 — No role check meant any authenticated user (incl. OPS_AGENT) could
 *       fetch the dashboard with team load + breaches + alerts. Now
 *       OPS_HEAD only.
 *
 *  P1 — "Today" comparisons used server-local midnight. The DB session is
 *       Asia/Kolkata; the JS server may be UTC. They produced different
 *       midnights, so "Done Today" silently included or excluded ~5h30m of
 *       events at the day boundary. Now anchored to IST.
 *
 *  P1 — `fetchAllActiveOrders().then(o => o.length).catch(() => 0)` ran
 *       the heaviest query in the codebase (full multi-join over every
 *       active order) JUST to read its length, then silently mapped any
 *       failure to 0 — indistinguishable from "no active orders". Now a
 *       single COUNT(*) on labstack."Order"; failure surfaces explicitly
 *       in the response so the UI can show a "labstack unreachable"
 *       state instead of a deceptive 0.
 *
 *  Arch — 12 parallel queries dropped to 7 by collapsing the six task
 *       counts (open / breached / warning / unassigned / completedToday
 *       / breachedToday) into a single FILTER-aggregate raw SQL. Same
 *       round-trip count, fewer query plans + fewer pool acquisitions.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack from "@/lib/db/labstack";
import { TaskStatus, UserRole } from "@prisma/client";
import { computeRosterStatus, getUTCDayOfWeek } from "@/lib/roster/availability";

/**
 * Anchor "today" to midnight in IST. Returns the corresponding UTC instant
 * so Prisma's bindings compare correctly against stored timestamps. The DB
 * session is Asia/Kolkata; this matches how operational "today" is
 * interpreted by the rest of the product (rosters, /api/team, dashboards).
 */
function startOfTodayIST(): Date {
  const istDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // "2026-05-10" + "T00:00:00+05:30" → real UTC instant for IST midnight.
  return new Date(`${istDateKey}T00:00:00+05:30`);
}

/**
 * Resolve the start-of-range for the dashboard's "Done in range" /
 * "Breached in range" tiles. Three buckets the head can toggle between
 * via the W4 segmented control:
 *
 *   today  — IST midnight today
 *   shift  — IST 09:00 today if we're past 09:00; otherwise IST 09:00
 *            yesterday. India ops typically run a 09:00–21:00 day shift,
 *            so this captures "what's happened since the shift began".
 *   week   — IST 00:00 of Monday this week.
 */
type DashboardRange = "today" | "shift" | "week";

function startOfRangeIST(range: DashboardRange): Date {
  const today = startOfTodayIST();
  if (range === "today") return today;

  if (range === "shift") {
    // IST 09:00 today.
    const istDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const shiftStart = new Date(`${istDateKey}T09:00:00+05:30`);
    if (Date.now() >= shiftStart.getTime()) return shiftStart;
    // Pre-09:00 IST — the active shift began at 09:00 yesterday.
    return new Date(shiftStart.getTime() - 24 * 60 * 60 * 1000);
  }

  // range === "week": Monday 00:00 IST. JS getDay(): Sunday=0..Saturday=6.
  // Monday = 1; if today is Sunday, Monday is 6 days ago.
  const istNow = new Date(today);
  const dow = istNow.getUTCDay(); // today is at IST midnight; UTC dow matches IST dow at midnight.
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return new Date(today.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
}

interface TaskCountsRow {
  open_tasks: bigint;
  breached: bigint;
  warning: bigint;
  unassigned: bigint;
  completed_today: bigint;
  breached_today: bigint;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const warningThreshold = new Date(now.getTime() + 10 * 60_000); // 10 min
  const dayOfWeek = getUTCDayOfWeek(now);

  // W4 — `range` toggle for the "Done in range" / "Breached in range"
  // tiles. Defaults to "today" so existing callers behave identically.
  const rangeParam = request.nextUrl.searchParams.get("range");
  const range: DashboardRange =
    rangeParam === "shift" || rangeParam === "week" ? rangeParam : "today";
  const rangeStart = startOfRangeIST(range);

  // Roster exception window stays anchored to today — rosters are a
  // calendar-day concept; broadening to "this week" doesn't make sense.
  const dayStart = startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Labstack outage marker. The fetchAllActiveOrders count used to silence
  // every error to `0`; we now distinguish "labstack returned 0" from
  // "labstack threw". UI can render a real banner on the latter.
  let activeOrders: number | null = 0;
  let labstackError: string | null = null;

  const [
    activeOrdersResult,
    taskCountsRow,
    riskTasks,
    teamStatus,
    recentAlerts,
    lastPoll,
    sourceStats,
  ] = await Promise.all([
    // 1. Labstack active-order count via a real COUNT(*). One index scan
    //    over the status filter — no multi-join, no row materialisation.
    //    Wrapped so a labstack outage doesn't take down the whole dashboard.
    labstack.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM public."Order"
      WHERE "orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
    `.catch((err: unknown) => {
      labstackError = err instanceof Error ? err.message : String(err);
      return null;
    }),

    // 2. Six task counts in a single FILTER-aggregate query (down from
    //    six separate parallel prisma.task.count calls).
    //
    //    `slaDeadline` and `completedAt` / `slaBreachedAt` are naive
    //    TIMESTAMP columns; passing JS Dates as parameters binds them
    //    as naive timestamps the same way Prisma's where filters do, so
    //    comparisons are correct (verified in All Tasks W1 E2E).
    prisma.$queryRaw<TaskCountsRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED'))                                            AS open_tasks,
        COUNT(*) FILTER (WHERE status = 'BREACHED')                                                                AS breached,
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED','BREACHED')
                          AND "slaDeadline" >  ${now}
                          AND "slaDeadline" <= ${warningThreshold})                                                AS warning,
        COUNT(*) FILTER (WHERE status = 'CREATED' AND "assignedToId" IS NULL)                                      AS unassigned,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${rangeStart})                            AS completed_today,
        COUNT(*) FILTER (WHERE "slaBreachedAt" >= ${rangeStart})                                                   AS breached_today
      FROM taskos.tasks
      WHERE "isArchived" = false
    `,

    // 3. Risk zone — at-risk and breached open tasks for the inline-assign UI.
    prisma.task.findMany({
      where: {
        isArchived: false,
        status: { in: [TaskStatus.BREACHED, TaskStatus.CREATED, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] },
        OR: [
          { status: TaskStatus.BREACHED },
          { slaDeadline: { lte: warningThreshold } },
        ],
      },
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: [{ status: "asc" }, { slaDeadline: "asc" }],
      take: 20,
    }),

    // 4. Team status — now reads weekly_schedules + roster_exceptions for
    //    today, so computeRosterStatus can decide ACTIVE / OFF / SICK /
    //    ON_LEAVE the same way /api/team and the engine do.
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        teamMember: {
          include: {
            storeAssignments: { select: { storeId: true } },
            weeklySchedules: { where: { dayOfWeek } },
            rosterExceptions: {
              where: { date: { gte: dayStart, lt: dayEnd } },
              take: 1,
            },
          },
        },
        assignedTasks: {
          where: {
            isArchived: false,
            status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
          },
          select: { id: true },
        },
      },
    }),

    // 5. Recent alerts (PENDING only — re-breaches show as new entries).
    prisma.alert.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { task: { select: { id: true, title: true, entityId: true } } },
    }),

    // 6. Last poll status.
    prisma.pollingLog.findFirst({ orderBy: { startedAt: "desc" } }),

    // 7. Per-source open task counts.
    prisma.dataSource.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        taskRules: {
          select: {
            _count: {
              select: {
                tasks: {
                  where: { isArchived: false, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  if (activeOrdersResult && activeOrdersResult.length > 0) {
    activeOrders = Number(activeOrdersResult[0].count);
  } else if (labstackError) {
    // labstack outage — surface it instead of pretending zero.
    activeOrders = null;
  }

  // BigInt(0) rather than 0n — the project's TS target is below ES2020 so
  // BigInt literal syntax isn't available; the constructor produces the
  // same value at runtime.
  const z = BigInt(0);
  const counts = taskCountsRow[0] ?? {
    open_tasks: z, breached: z, warning: z,
    unassigned: z, completed_today: z, breached_today: z,
  };
  const openTasksCount = Number(counts.open_tasks);
  const breachedCount = Number(counts.breached);
  const warningCount = Number(counts.warning);
  const unassignedCount = Number(counts.unassigned);
  const totalDoneToday = Number(counts.completed_today);
  const totalBreachedToday = Number(counts.breached_today);

  const slaHealth =
    openTasksCount > 0
      ? Math.round(((openTasksCount - breachedCount) / openTasksCount) * 100)
      : 100;

  // Risk items — `now` is unmutated here (it was the audit P0 #8). All
  // remaining-time calculations now use the original `now`.
  const riskItems = riskTasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    priority: t.priority,
    status: t.status,
    entityId: t.entityId,
    orderType: t.orderType,
    storeId: t.storeId,
    slaDeadline: t.slaDeadline,
    slaBreachedAt: t.slaBreachedAt,
    assignedTo: t.assignedTo ? { id: t.assignedTo.id, name: t.assignedTo.name } : null,
    metadata: t.metadata as Record<string, unknown>,
    minutesRemaining: Math.round((t.slaDeadline.getTime() - now.getTime()) / 60_000),
  }));

  const team = teamStatus.map((u) => {
    const schedule = u.teamMember?.weeklySchedules[0] ?? null;
    const exception = u.teamMember?.rosterExceptions[0] ?? null;
    const rosterStatus = u.teamMember
      ? computeRosterStatus(schedule, exception, now)
      : "OFF";
    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      rosterStatus,
      openTasks: u.assignedTasks.length,
      maxTasks: u.teamMember?.maxConcurrentTasks ?? 5,
      storeIds: u.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
    };
  });

  const shapedSourceStats = sourceStats.map((ds) => ({
    sourceId: ds.sourceId,
    displayName: ds.displayName,
    openTasks: ds.taskRules.reduce(
      (sum, rule) => sum + (rule._count?.tasks ?? 0),
      0
    ),
  }));

  return NextResponse.json({
    stats: {
      activeOrders,
      openTasks: openTasksCount,
      breachedTasks: breachedCount,
      warningTasks: warningCount,
      slaHealthPercent: slaHealth,
      unassignedTasks: unassignedCount,
      completedToday: totalDoneToday,
      breachedToday: totalBreachedToday,
    },
    sourceStats: shapedSourceStats,
    riskItems,
    team,
    recentAlerts,
    lastPollAt: lastPoll?.finishedAt ?? null,
    // W4 — echoes the resolved range so the UI can label the affected
    // tiles ("Done Today" vs "Done This Shift" vs "Done This Week").
    range: { key: range, since: rangeStart.toISOString() },
    // Surface labstack reachability so the UI can render a "labstack
    // unreachable" banner instead of treating activeOrders=null as 0.
    labstackError,
  });
}
