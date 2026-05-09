/**
 * GET /api/team/heatmap?weekStart=YYYY-MM-DD
 *
 * Returns a 7-day × N-agent grid for the Team page's weekly heatmap (audit
 * W5 — "agents × days view + one-click conflict detection").
 *
 * Each cell summarises a single agent's coverage on a single date:
 *   - status      : "WORKING" | "OFF" | "EXCEPTION" | "UNSCHEDULED"
 *   - shift       : { start, end, breakStart?, breakEnd? } from the weekly schedule (if any)
 *   - exception   : { kind, note? } from a roster exception (if any) — overrides shift
 *
 * The endpoint also computes day-level totals so the UI can flag conflicts:
 *   - workingCount, offCount, exceptionCount, unscheduledCount per day
 *   - lowCoverage    : a day where < `minCoverage` agents are working (config-tunable; default 1)
 *   - everyoneOff    : zero working agents — likely a coverage gap
 *
 * Response:
 *   {
 *     weekStart, weekEnd,
 *     days: [{ date, dayOfWeek, dayName, totals, lowCoverage, everyoneOff }],
 *     agents: [{ userId, name, role, cells: [day0, day1, ...] }]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_COVERAGE_DEFAULT = 1;

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ─── Parse weekStart (default = the Monday of this week) ──────────────
  const url = new URL(request.url);
  const weekStartParam = url.searchParams.get("weekStart");
  let weekStart: Date;
  if (weekStartParam && /^\d{4}-\d{2}-\d{2}$/.test(weekStartParam)) {
    const [y, m, d] = weekStartParam.split("-").map(Number);
    weekStart = new Date(Date.UTC(y, m - 1, d));
  } else {
    // Default — Monday of THIS week, anchored at UTC midnight.
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dow = todayUTC.getUTCDay(); // 0=Sun, 1=Mon, ...
    const offsetToMon = (dow + 6) % 7; // distance back to Monday
    weekStart = new Date(todayUTC);
    weekStart.setUTCDate(weekStart.getUTCDate() - offsetToMon);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const minCoverage = (() => {
    const raw = parseInt(url.searchParams.get("minCoverage") ?? String(MIN_COVERAGE_DEFAULT), 10);
    return isNaN(raw) ? MIN_COVERAGE_DEFAULT : Math.max(0, Math.min(20, raw));
  })();

  // ─── Pull all agents + every weekly schedule + exceptions in window ───
  // One round-trip; the join surface is small (≤ N*7 schedule rows, ≤ N*7
  // exception rows).
  const team = await prisma.user.findMany({
    where: { isActive: true, role: { not: UserRole.OPS_HEAD } },
    include: {
      teamMember: {
        include: {
          weeklySchedules: { orderBy: { dayOfWeek: "asc" } },
          rosterExceptions: {
            where: { date: { gte: weekStart, lt: weekEnd } },
            orderBy: { date: "asc" },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  // Build the 7 day records.
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      utc: d,
      dayOfWeek: d.getUTCDay(),
      dayName: DAY_NAMES[d.getUTCDay()],
      totals: { working: 0, off: 0, exception: 0, unscheduled: 0 },
    };
  });

  // ─── Build cells ──────────────────────────────────────────────────────
  type Cell = {
    status: "WORKING" | "OFF" | "EXCEPTION" | "UNSCHEDULED";
    shift?: { start: string; end: string; breakStart: string | null; breakEnd: string | null };
    exception?: { kind: string; note?: string };
  };

  const agents = team.map((u) => {
    const schedulesByDow = new Map<number, typeof u.teamMember.weeklySchedules[0]>();
    if (u.teamMember) {
      for (const ws of u.teamMember.weeklySchedules) {
        schedulesByDow.set(ws.dayOfWeek, ws);
      }
    }
    const exceptionsByDate = new Map<string, typeof u.teamMember.rosterExceptions[0]>();
    if (u.teamMember) {
      for (const ex of u.teamMember.rosterExceptions) {
        const key = (ex.date instanceof Date ? ex.date : new Date(ex.date)).toISOString().slice(0, 10);
        exceptionsByDate.set(key, ex);
      }
    }

    const cells: Cell[] = days.map((day) => {
      // Exception priority — same as computeRosterStatus.
      const ex = exceptionsByDate.get(day.date);
      if (ex) {
        // ACTIVE-type exceptions look like coverage; everything else is "exception" (off-coded).
        const kindUpper = String(ex.status).toUpperCase();
        const isCoverage = kindUpper === "ACTIVE";
        if (isCoverage) {
          // Use the schedule's hours if present; otherwise unscheduled-but-active.
          const ws = schedulesByDow.get(day.dayOfWeek);
          if (ws?.isWorking && ws.startTime && ws.endTime) {
            day.totals.working++;
            return {
              status: "WORKING",
              shift: {
                start: ws.startTime, end: ws.endTime,
                breakStart: ws.breakStart ?? null, breakEnd: ws.breakEnd ?? null,
              },
              exception: { kind: kindUpper, note: ex.note ?? undefined },
            };
          }
          day.totals.exception++;
          return {
            status: "EXCEPTION",
            exception: { kind: kindUpper, note: ex.note ?? undefined },
          };
        }
        day.totals.exception++;
        return {
          status: "EXCEPTION",
          exception: { kind: kindUpper, note: ex.note ?? undefined },
        };
      }

      const ws = schedulesByDow.get(day.dayOfWeek);
      if (!ws) {
        day.totals.unscheduled++;
        return { status: "UNSCHEDULED" };
      }
      if (!ws.isWorking) {
        day.totals.off++;
        return { status: "OFF" };
      }
      day.totals.working++;
      return {
        status: "WORKING",
        shift: {
          start: ws.startTime ?? "00:00",
          end: ws.endTime ?? "23:59",
          breakStart: ws.breakStart ?? null,
          breakEnd: ws.breakEnd ?? null,
        },
      };
    });

    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      cells,
    };
  });

  // ─── Day-level conflict flags ─────────────────────────────────────────
  const dayPayload = days.map((d) => ({
    date: d.date,
    dayOfWeek: d.dayOfWeek,
    dayName: d.dayName,
    totals: d.totals,
    lowCoverage: d.totals.working < minCoverage,
    everyoneOff: d.totals.working === 0,
  }));

  return NextResponse.json({
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
    minCoverage,
    days: dayPayload,
    agents,
  });
}
