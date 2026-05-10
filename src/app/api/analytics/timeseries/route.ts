/**
 * GET /api/analytics/timeseries?range=week|month
 *
 * Per-day aggregates for the analytics Trends tab. Returns one bucket
 * per IST calendar day in the range, with completed / breached counts
 * and SLA % derived from sla_compliant / completed.
 *
 * IST anchoring: the underlying columns (`completedAt`, `slaBreachedAt`)
 * are naive TIMESTAMP storing UTC instants. We re-interpret as UTC then
 * convert to IST inside SQL so the day buckets line up with the head's
 * wall-clock day. Same trick the rest of analytics uses; centralised
 * here to keep the SQL self-contained.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { Prisma, UserRole } from "@prisma/client";
import { getRangeStart, startOfTodayIST } from "../_helpers";

type Range = "week" | "month";

interface DayRow {
  day: string;
  completed?: bigint;
  sla_compliant?: bigint;
  breached?: bigint;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rangeParam = (request.nextUrl.searchParams.get("range") ?? "week") as Range;
  const range: Range = rangeParam === "month" ? "month" : "week";
  const dataSourceId = request.nextUrl.searchParams.get("dataSourceId"); // W5
  const since = getRangeStart(range);
  const today = startOfTodayIST();

  const sourceFilter = dataSourceId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM taskos.task_rules tr
        WHERE tr.id = t."taskRuleId" AND tr."dataSourceId" = ${dataSourceId}
      )`
    : Prisma.empty;

  const [completedRows, breachedRows] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      SELECT
        to_char((t."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
        COUNT(*)                                              AS completed,
        COUNT(*) FILTER (WHERE t."slaBreachedAt" IS NULL)     AS sla_compliant
      FROM taskos.tasks t
      WHERE t.status = 'COMPLETED'
        AND t."completedAt" >= ${since}
        ${sourceFilter}
      GROUP BY 1
    `,
    prisma.$queryRaw<DayRow[]>`
      SELECT
        to_char((t."slaBreachedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
        COUNT(*) AS breached
      FROM taskos.tasks t
      WHERE t."slaBreachedAt" >= ${since}
        ${sourceFilter}
      GROUP BY 1
    `,
  ]);

  // Build a per-day map, then materialise the full date series so the
  // chart shows zeros explicitly (otherwise gaps would just disappear).
  const byDay = new Map<string, { completed: number; slaCompliant: number; breached: number }>();
  for (const r of completedRows) {
    const cur = byDay.get(r.day) ?? { completed: 0, slaCompliant: 0, breached: 0 };
    cur.completed = Number(r.completed ?? 0);
    cur.slaCompliant = Number(r.sla_compliant ?? 0);
    byDay.set(r.day, cur);
  }
  for (const r of breachedRows) {
    const cur = byDay.get(r.day) ?? { completed: 0, slaCompliant: 0, breached: 0 };
    cur.breached = Number(r.breached ?? 0);
    byDay.set(r.day, cur);
  }

  const series: Array<{
    date: string;
    completed: number;
    breached: number;
    slaPercent: number;
  }> = [];
  // Walk every day from `since` through today inclusive.
  for (let t = since.getTime(); t <= today.getTime(); t += 24 * 60 * 60 * 1000) {
    const dayKey = new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const stat = byDay.get(dayKey) ?? { completed: 0, slaCompliant: 0, breached: 0 };
    const slaPercent = stat.completed > 0
      ? Math.round((stat.slaCompliant / stat.completed) * 100)
      : 100; // matches dashboard convention: zero work → perfect score
    series.push({
      date: dayKey,
      completed: stat.completed,
      breached: stat.breached,
      slaPercent,
    });
  }

  return NextResponse.json({
    range,
    since: since.toISOString(),
    series,
  });
}
