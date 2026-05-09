/**
 * GET /api/task-rules/{id}/metrics?range=7d
 *
 * Per-rule operational metrics for the rule list's expanded card and
 * (later) for the rule-level analytics dashboard. Authors needed something
 * cheaper than "scroll the All Tasks board filtered by rule and eyeball
 * the breakdown".
 *
 * Query params:
 *   range = 7d (default) | 30d | 24h
 *
 * Response shape:
 *   {
 *     ruleId, ruleName, range,
 *     totals: {
 *       fires:        all tasks created by the rule in the window
 *       completed:    tasks finished
 *       cancelled:    tasks cancelled (proxy for false positives)
 *       breached:     tasks that breached SLA before completion
 *       active:       still open at query time
 *     },
 *     ratios: {
 *       completionRate: completed / fires
 *       cancelRate:     cancelled / fires    (false-positive rate)
 *       breachRate:     breached / fires
 *     },
 *     avgMinutesToComplete: average wall-clock time from create to complete (null if 0 completed)
 *     firesByDay:    [{ day: "2026-05-09", count: 12 }, ...]   ← bucketed for sparklines
 *   }
 *
 * The "false-positive rate" framing matches the audit:
 *   - cancelRate near 0%  → rule is precise
 *   - cancelRate above 20% → rule is firing on orders that don't actually
 *     need a task; tighten the trigger
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { Prisma, UserRole } from "@prisma/client";

type Range = "24h" | "7d" | "30d";

const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 60 * 60_000,
  "7d":  7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

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
    return NextResponse.json({ error: "Cannot query metrics for the MANUAL sentinel rule" }, { status: 400 });
  }

  const rule = await prisma.taskRule.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  const rangeParam = (request.nextUrl.searchParams.get("range") ?? "7d") as Range;
  const range: Range = rangeParam in RANGE_MS ? rangeParam : "7d";
  const since = new Date(Date.now() - RANGE_MS[range]);

  // ─── Totals via groupBy ─────────────────────────────────────────────────
  // One DB round-trip groups the window's tasks by status; we derive
  // every total + ratio from the result without re-querying.
  const grouped = await prisma.task.groupBy({
    by: ["status"],
    where: { taskRuleId: id, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const fires = grouped.reduce((sum, g) => sum + g._count._all, 0);
  const completed = counts["COMPLETED"] ?? 0;
  const cancelled = counts["CANCELLED"] ?? 0;
  const breached  = counts["BREACHED"] ?? 0;
  const active    = (counts["CREATED"] ?? 0) + (counts["ASSIGNED"] ?? 0) + (counts["IN_PROGRESS"] ?? 0) + (counts["BLOCKED"] ?? 0);

  // ─── Average minutes-to-complete ─────────────────────────────────────────
  // Done in raw SQL so AVG is computed server-side (lots cheaper than
  // pulling N task rows and reducing in JS).
  const avgRow = await prisma.$queryRaw<Array<{ avg_minutes: number | null }>>(Prisma.sql`
    SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) / 60.0) AS avg_minutes
    FROM taskos.tasks
    WHERE "taskRuleId" = ${id}
      AND "createdAt" >= ${since}
      AND "completedAt" IS NOT NULL
      AND status = 'COMPLETED'
  `);
  const avgMinutesToComplete = avgRow[0]?.avg_minutes != null
    ? Math.round(Number(avgRow[0].avg_minutes) * 10) / 10
    : null;

  // ─── Fires by day (for sparkline) ────────────────────────────────────────
  // date_trunc to 'day' produces a TIMESTAMP; cast to date for compactness.
  // ::int cast on COUNT is needed because Prisma returns BigInt by default.
  const dailyRows = await prisma.$queryRaw<Array<{ day: Date; count: number }>>(Prisma.sql`
    SELECT date_trunc('day', "createdAt")::date AS day,
           COUNT(*)::int                          AS count
    FROM taskos.tasks
    WHERE "taskRuleId" = ${id}
      AND "createdAt" >= ${since}
    GROUP BY 1
    ORDER BY 1
  `);
  const firesByDay = dailyRows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
    count: Number(r.count),
  }));

  // ─── Ratios ──────────────────────────────────────────────────────────────
  const safeRatio = (num: number) => (fires > 0 ? Math.round((num / fires) * 1000) / 10 : 0);

  return NextResponse.json({
    ruleId: rule.id,
    ruleName: rule.name,
    range,
    rangeStart: since.toISOString(),
    totals: { fires, completed, cancelled, breached, active },
    ratios: {
      completionRate: safeRatio(completed),
      cancelRate:     safeRatio(cancelled),  // false-positive proxy
      breachRate:     safeRatio(breached),
    },
    avgMinutesToComplete,
    firesByDay,
  });
}
