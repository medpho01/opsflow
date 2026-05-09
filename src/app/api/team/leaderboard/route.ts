/**
 * GET /api/team/leaderboard?range=7d
 *
 * Per-agent performance ranking, designed to live INSIDE the Team panel
 * (audit's W4 — leaderboard was buried in Analytics; the head wants it
 * where they manage agents). One query bucket per metric so callers can
 * pivot without re-fetching.
 *
 * Query params:
 *   range = 24h | 7d (default) | 30d
 *
 * Response:
 *   {
 *     range, since,
 *     entries: [
 *       { userId, name, role,
 *         totalAssigned, completed, cancelled, breached, active,
 *         slaCompliance,             // 0–100, % completed-on-time of all completed
 *         avgMinutesToComplete,      // null if no completed tasks
 *         currentLoad, maxConcurrentTasks, utilizationPct,
 *         rank: { byCompleted, bySlaCompliance, byVolume }   // 1-based ranks for sortable UI
 *       }
 *     ]
 *   }
 *
 * Computed in three small SQL queries (groupBy by status, AVG completion
 * time, current load). Ranks are JS-side because Postgres window functions
 * for "non-stable cross-tab ranking" add more complexity than a sort here.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma, UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";

type Range = "24h" | "7d" | "30d";
const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 60 * 60_000,
  "7d":  7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rangeParam = (request.nextUrl.searchParams.get("range") ?? "7d") as Range;
  const range: Range = rangeParam in RANGE_MS ? rangeParam : "7d";
  const since = new Date(Date.now() - RANGE_MS[range]);

  // ─── Roster: every active agent / store-admin ─────────────────────────
  const team = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { not: UserRole.OPS_HEAD },
    },
    include: {
      teamMember: { select: { maxConcurrentTasks: true } },
      _count: {
        select: {
          assignedTasks: { where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } },
        },
      },
    },
  });

  if (team.length === 0) {
    return NextResponse.json({ range, since: since.toISOString(), entries: [] });
  }

  const userIds = team.map((u) => u.id);

  // ─── Per-user × per-status counts in one groupBy ──────────────────────
  const grouped = await prisma.task.groupBy({
    by: ["assignedToId", "status"],
    where: { assignedToId: { in: userIds }, createdAt: { gte: since } },
    _count: { _all: true },
  });

  const taskMap = new Map<number, Record<string, number>>();
  for (const g of grouped) {
    if (g.assignedToId == null) continue;
    const inner = taskMap.get(g.assignedToId) ?? {};
    inner[g.status] = g._count._all;
    taskMap.set(g.assignedToId, inner);
  }

  // ─── Per-user avg minutes-to-complete (one SQL with a join) ───────────
  // Filtered to COMPLETED tasks in the window. NULL if the user closed nothing.
  const avgRows = await prisma.$queryRaw<Array<{ assigned_to_id: number; avg_minutes: number | null }>>(Prisma.sql`
    SELECT "assignedToId" AS assigned_to_id,
           AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) / 60.0) AS avg_minutes
    FROM taskos.tasks
    WHERE "assignedToId" IN (${Prisma.join(userIds)})
      AND "createdAt" >= ${since}
      AND "completedAt" IS NOT NULL
      AND status = 'COMPLETED'
    GROUP BY "assignedToId"
  `);
  const avgMap = new Map(avgRows.map((r) => [r.assigned_to_id, r.avg_minutes != null ? Math.round(Number(r.avg_minutes) * 10) / 10 : null]));

  // ─── SLA compliance: completed-on-time / completed (also one SQL) ─────
  const slaRows = await prisma.$queryRaw<Array<{ assigned_to_id: number; on_time: number; total_completed: number }>>(Prisma.sql`
    SELECT "assignedToId" AS assigned_to_id,
           SUM(CASE WHEN "completedAt" <= "slaDeadline" THEN 1 ELSE 0 END)::int AS on_time,
           COUNT(*)::int AS total_completed
    FROM taskos.tasks
    WHERE "assignedToId" IN (${Prisma.join(userIds)})
      AND "createdAt" >= ${since}
      AND "completedAt" IS NOT NULL
      AND status = 'COMPLETED'
    GROUP BY "assignedToId"
  `);
  const slaMap = new Map<number, { onTime: number; total: number }>();
  for (const r of slaRows) {
    slaMap.set(r.assigned_to_id, { onTime: Number(r.on_time), total: Number(r.total_completed) });
  }

  // ─── Shape per-entry rows ─────────────────────────────────────────────
  const rows = team.map((u) => {
    const counts = taskMap.get(u.id) ?? {};
    const completed = counts["COMPLETED"] ?? 0;
    const cancelled = counts["CANCELLED"] ?? 0;
    const breached  = counts["BREACHED"]  ?? 0;
    const active    = (counts["CREATED"] ?? 0) + (counts["ASSIGNED"] ?? 0) + (counts["IN_PROGRESS"] ?? 0) + (counts["BLOCKED"] ?? 0);
    const totalAssigned = completed + cancelled + breached + active;

    const sla = slaMap.get(u.id);
    const slaCompliance = sla && sla.total > 0
      ? Math.round((sla.onTime / sla.total) * 1000) / 10
      : null;

    const maxConcurrentTasks = u.teamMember?.maxConcurrentTasks ?? 5;
    const currentLoad = u._count.assignedTasks;
    const utilizationPct = maxConcurrentTasks > 0 ? Math.round((currentLoad / maxConcurrentTasks) * 100) : 0;

    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      totalAssigned,
      completed,
      cancelled,
      breached,
      active,
      slaCompliance,
      avgMinutesToComplete: avgMap.get(u.id) ?? null,
      currentLoad,
      maxConcurrentTasks,
      utilizationPct,
    };
  });

  // ─── Compute three rankings (1-based; ties get the same rank) ─────────
  const rankBy = <K extends keyof typeof rows[number]>(
    sorted: typeof rows,
    key: K,
    order: "desc" | "asc"
  ): Map<number, number> => {
    const cmp = (a: number, b: number) => order === "desc" ? b - a : a - b;
    const ordered = [...sorted].sort((a, b) => cmp((a[key] as number) ?? 0, (b[key] as number) ?? 0));
    const out = new Map<number, number>();
    let lastValue: number | null = null;
    let lastRank = 0;
    ordered.forEach((row, idx) => {
      const v = (row[key] as number) ?? 0;
      const rank = v === lastValue ? lastRank : idx + 1;
      lastValue = v;
      lastRank = rank;
      out.set(row.userId, rank);
    });
    return out;
  };

  const completedRanks = rankBy(rows, "completed", "desc");
  const slaRanks       = rankBy(rows.filter((r) => r.slaCompliance !== null), "slaCompliance", "desc");
  const volumeRanks    = rankBy(rows, "totalAssigned", "desc");

  const entries = rows
    .map((r) => ({
      ...r,
      rank: {
        byCompleted: completedRanks.get(r.userId) ?? null,
        bySlaCompliance: slaRanks.get(r.userId) ?? null,
        byVolume: volumeRanks.get(r.userId) ?? null,
      },
    }))
    .sort((a, b) => b.completed - a.completed); // default sort: most-done first

  return NextResponse.json({
    range,
    since: since.toISOString(),
    entries,
  });
}
