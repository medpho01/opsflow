/**
 * GET /api/sources/health — operational health snapshot per data source.
 *
 * Used by the OPS_HEAD command center's Source Health card. Surfaces
 * three signals the audit (feature 08) called out:
 *
 *   - Last poll       — cycle-level, since the legacy poller runs all
 *                       sources in a single cycle. The freshness of the
 *                       last cycle implies the freshness of all sources.
 *   - Success rate    — proportion of recent cycles that ran without
 *                       error. Cycle-level for the same reason.
 *   - Tasks last hour — per-source. Joins tasks → task_rules →
 *                       data_sources and counts createdAt >= now-1h.
 *
 * No per-source telemetry was historically tracked. Once that exists
 * (audit Phase 4 — source-health watcher / per-source poll), we can
 * shift `lastPollAt` and `successRate` here to per-source values.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

interface PerSourceRow {
  id: string;
  sourceId: string;
  displayName: string;
  tasks_last_hour: bigint;
  open_tasks: bigint;
}

interface CycleStatsRow {
  total: bigint;
  success_count: bigint;
  last_poll_at: Date | null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60_000);

  const [perSource, cycleStats] = await Promise.all([
    prisma.$queryRaw<PerSourceRow[]>`
      SELECT
        ds.id,
        ds."sourceId",
        ds."displayName",
        COUNT(t.id) FILTER (WHERE t."createdAt" >= ${oneHourAgo})                                                AS tasks_last_hour,
        COUNT(t.id) FILTER (WHERE t."isArchived" = false
                              AND t.status NOT IN ('COMPLETED','CANCELLED'))                                     AS open_tasks
      FROM taskos.data_sources ds
      LEFT JOIN taskos.task_rules tr ON tr."dataSourceId" = ds.id
      LEFT JOIN taskos.tasks t        ON t."taskRuleId"   = tr.id
      WHERE ds."isActive" = true
      GROUP BY ds.id, ds."sourceId", ds."displayName"
      ORDER BY ds."displayName" ASC
    `,
    prisma.$queryRaw<CycleStatsRow[]>`
      SELECT
        COUNT(*)::bigint                                       AS total,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')::bigint     AS success_count,
        MAX("startedAt")                                       AS last_poll_at
      FROM taskos.polling_logs
      WHERE "startedAt" >= ${oneHourAgo}
    `,
  ]);

  const cycle = cycleStats[0] ?? { total: BigInt(0), success_count: BigInt(0), last_poll_at: null };
  const totalCycles = Number(cycle.total);
  const successCount = Number(cycle.success_count);
  const successRate = totalCycles > 0 ? successCount / totalCycles : null;

  // Health classification: green if last cycle succeeded AND <=2x interval
  // since last poll; amber if degraded; red if last poll is stale or
  // recent cycles errored. The thresholds are deliberately wide — the
  // tile is a glance signal, not a paging alert.
  let cycleHealth: "green" | "amber" | "red" = "green";
  if (cycle.last_poll_at) {
    const minutesSinceLast = (Date.now() - cycle.last_poll_at.getTime()) / 60_000;
    const sr = successRate ?? 1;
    if (minutesSinceLast > 30 || sr < 0.5) cycleHealth = "red";
    else if (minutesSinceLast > 15 || sr < 0.9) cycleHealth = "amber";
  } else {
    // No cycles in the last hour — the cron is silent.
    cycleHealth = "red";
  }

  return NextResponse.json({
    cycle: {
      lastPollAt: cycle.last_poll_at,
      cyclesInLastHour: totalCycles,
      successCount,
      successRate,
      health: cycleHealth,
    },
    sources: perSource.map((s) => ({
      id: s.id,
      sourceId: s.sourceId,
      displayName: s.displayName,
      openTasks: Number(s.open_tasks),
      tasksLastHour: Number(s.tasks_last_hour),
    })),
  });
}
