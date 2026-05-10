/**
 * GET /api/analytics/agents?range=today|week|month
 *
 * Per-agent performance metrics for the OPS_HEAD analytics dashboard.
 *
 * Audit (feature 07) rewrites:
 *
 *  - Replaced the inline `calculateRosterStatus` (the audit's "third
 *    re-implementation" — used local `getDay()` not UTC, and referenced
 *    nonexistent `breakStartTime`/`breakEndTime` columns so the break
 *    window check was silently a no-op). Now calls
 *    `computeRosterStatus()` from lib/roster/availability — the same
 *    helper /api/team and pickAssignee use. Single source of truth.
 *
 *  - `getRangeStart` no longer uses local `setHours(0,0,0,0)`. The
 *    server runs in UTC and the DB in IST; the resulting midnight was
 *    misaligned by 5h30m. Now anchored to IST via the shared helper.
 *
 *  - Aggregation push-down: previously loaded every assigned task per
 *    agent and filtered in JS — O(agents × tasks) memory and pure
 *    JSON-over-the-wire bandwidth. Now a single GROUP BY assignedToId
 *    aggregate run server-side; only the per-agent count rows come back.
 *
 *  - rosterExceptions filter now uses the shared IST-anchored start so
 *    it matches everywhere else in the file (was inconsistently using
 *    `Date.UTC(...)`).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";
import { computeRosterStatus, getUTCDayOfWeek } from "@/lib/roster/availability";
import { getRangeStart, startOfTodayIST } from "../_helpers";

interface AgentAggregate {
  assignedToId: number;
  completed: bigint;
  open: bigint;
  breached: bigint;
  sla_compliant: bigint;
  avg_completion_minutes: number | null;
  urgent_breaches: bigint;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") ?? "today";
  const since = getRangeStart(range);
  const now = new Date();
  const dayStart = startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayOfWeek = getUTCDayOfWeek(now);

  const [agents, aggregates] = await Promise.all([
    // Light user list — no nested tasks. Just the metadata we need to
    // shape the row + compute roster status.
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
      },
      orderBy: { name: "asc" },
    }),
    // Per-agent aggregates pushed into SQL. Avg-completion-minutes uses
    // EPOCH math against naive TIMESTAMP columns; both columns store
    // UTC instants the same way so the difference is correct.
    prisma.$queryRaw<AgentAggregate[]>`
      SELECT
        "assignedToId",
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${since})                                AS completed,
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED'))                                           AS open,
        COUNT(*) FILTER (WHERE "slaBreachedAt" >= ${since})                                                       AS breached,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${since}
                          AND "slaBreachedAt" IS NULL)                                                            AS sla_compliant,
        AVG(EXTRACT(EPOCH FROM ("completedAt" - "assignedAt")) / 60.0)
          FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${since}
                  AND "completedAt" IS NOT NULL AND "assignedAt" IS NOT NULL)                                     AS avg_completion_minutes,
        COUNT(*) FILTER (WHERE "slaBreachedAt" >= ${since}
                          AND priority IN ('URGENT','HIGH'))                                                      AS urgent_breaches
      FROM taskos.tasks
      WHERE "isArchived" = false AND "assignedToId" IS NOT NULL
      GROUP BY "assignedToId"
    `,
  ]);

  // Index the aggregate by agent id for O(1) lookup during shape.
  const aggByUser = new Map<number, AgentAggregate>();
  for (const row of aggregates) aggByUser.set(row.assignedToId, row);

  const metrics = agents.map((agent) => {
    const agg = aggByUser.get(agent.id);
    const completed = agg ? Number(agg.completed) : 0;
    const open = agg ? Number(agg.open) : 0;
    const breached = agg ? Number(agg.breached) : 0;
    const slaCompliant = agg ? Number(agg.sla_compliant) : 0;
    const urgentBreaches = agg ? Number(agg.urgent_breaches) : 0;
    const avgCompletionMinutes = agg && agg.avg_completion_minutes !== null
      ? Math.round(Number(agg.avg_completion_minutes))
      : null;

    const slaCompliance =
      completed > 0 ? Math.round((slaCompliant / completed) * 100) : 0;

    const schedule = agent.teamMember?.weeklySchedules[0] ?? null;
    const exception = agent.teamMember?.rosterExceptions[0] ?? null;
    const rosterStatus = agent.teamMember
      ? computeRosterStatus(schedule, exception, now)
      : "OFF";

    const maxConcurrent = agent.teamMember?.maxConcurrentTasks ?? 5;

    return {
      userId: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      rosterStatus,
      maxConcurrentTasks: maxConcurrent,
      storeIds: agent.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
      // metrics
      completedCount: completed,
      openCount: open,
      breachedCount: breached,
      urgentBreaches,
      slaCompliance,
      avgCompletionMinutes,
      loadPercent: maxConcurrent > 0 ? Math.round((open / maxConcurrent) * 100) : 0,
    };
  });

  // Sort by completed desc then sla compliance desc
  metrics.sort((a, b) => b.completedCount - a.completedCount || b.slaCompliance - a.slaCompliance);

  return NextResponse.json({ metrics, range, since: since.toISOString() });
}
