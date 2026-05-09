/**
 * GET /api/team/coverage?weekStart=YYYY-MM-DD&hourFrom=06:00&hourTo=22:30&interval=30
 *
 * Returns an hour-of-day × day-of-week coverage matrix — i.e. "how many
 * agents are scheduled to be working at this exact half-hour on this
 * exact date". This is the visualisation a head needs to design shift
 * patterns: the existing weekly heatmap answers "who works when" but
 * doesn't surface gaps inside the day (no agents at 7pm Tuesday).
 *
 * For each (date, time-slot) pair we count agents whose effective shift
 * covers the slot, where "effective shift" is:
 *   - If a roster_exception exists for the date with status "ACTIVE":
 *       use the schedule's hours if a schedule exists for that DOW;
 *       skip otherwise (active-without-schedule = no concrete hours).
 *   - If a roster_exception exists with any other status (OFF/SICK/ON_LEAVE):
 *       skip — agent isn't covering.
 *   - Else if a weekly schedule exists with isWorking=true:
 *       count slots in [startTime, endTime), excluding [breakStart, breakEnd)
 *       when both are set.
 *
 * Response shape:
 *   {
 *     weekStart, weekEnd, hourFrom, hourTo, intervalMinutes,
 *     slots: [{ time: "06:00", dayCounts: [n_mon, n_tue, ..., n_sun] }, ...],
 *     days: ["Mon","Tue",...],
 *     dates: ["2026-05-04", ...],
 *     summary: { totalSlots, gapSlots, lowCoverageSlots, peakConcurrent }
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

const DAY_NAMES_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_HOUR_FROM = "06:00";
const DEFAULT_HOUR_TO = "22:30";
const DEFAULT_INTERVAL = 30;

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);

  // ─── Parse weekStart (default = Monday of this week) ─────────────────
  const weekStartParam = url.searchParams.get("weekStart");
  let weekStart: Date;
  if (weekStartParam && /^\d{4}-\d{2}-\d{2}$/.test(weekStartParam)) {
    const [y, m, d] = weekStartParam.split("-").map(Number);
    weekStart = new Date(Date.UTC(y, m - 1, d));
  } else {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dow = today.getUTCDay();
    const offsetToMon = (dow + 6) % 7;
    weekStart = new Date(today);
    weekStart.setUTCDate(weekStart.getUTCDate() - offsetToMon);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  // ─── Parse hour window (HH:MM) and interval (minutes) ────────────────
  const hourFrom = parseHHMM(url.searchParams.get("hourFrom") ?? DEFAULT_HOUR_FROM) ?? hhmmToMinutes(DEFAULT_HOUR_FROM);
  const hourTo = parseHHMM(url.searchParams.get("hourTo") ?? DEFAULT_HOUR_TO) ?? hhmmToMinutes(DEFAULT_HOUR_TO);
  const rawInterval = parseInt(url.searchParams.get("interval") ?? String(DEFAULT_INTERVAL), 10);
  const intervalMinutes = [15, 30, 60].includes(rawInterval) ? rawInterval : DEFAULT_INTERVAL;
  const lowCoverageThreshold = (() => {
    const raw = parseInt(url.searchParams.get("lowCoverage") ?? "1", 10);
    return isNaN(raw) ? 1 : Math.max(0, Math.min(20, raw));
  })();

  if (hourTo <= hourFrom) {
    return NextResponse.json(
      { error: "hourTo must be after hourFrom" },
      { status: 400 }
    );
  }

  // ─── Load every agent's schedules + this-week's exceptions ──────────
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
  });

  // ─── Build the (dayIdx, slotMinutes) grid initialised to zero ───────
  // dayIdx 0 = Monday (matches week-start anchor)
  const slotsCount = Math.floor((hourTo - hourFrom) / intervalMinutes);
  const grid: number[][] = Array.from({ length: slotsCount }, () => Array(7).fill(0));

  // ─── For each agent, increment counts for every slot they cover ─────
  for (const u of team) {
    if (!u.teamMember) continue;

    const schedulesByDow = new Map<number, typeof u.teamMember.weeklySchedules[0]>();
    for (const ws of u.teamMember.weeklySchedules) schedulesByDow.set(ws.dayOfWeek, ws);

    const exceptionsByDate = new Map<string, typeof u.teamMember.rosterExceptions[0]>();
    for (const ex of u.teamMember.rosterExceptions) {
      const key = (ex.date instanceof Date ? ex.date : new Date(ex.date)).toISOString().slice(0, 10);
      exceptionsByDate.set(key, ex);
    }

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + dayIdx);
      const dateKey = date.toISOString().slice(0, 10);
      const dow = date.getUTCDay();

      // Resolve the agent's effective shift for this date.
      const ex = exceptionsByDate.get(dateKey);
      let shift: typeof u.teamMember.weeklySchedules[0] | null = null;

      if (ex) {
        const kind = String(ex.status).toUpperCase();
        if (kind === "ACTIVE") {
          // Use the schedule's hours when present; otherwise we have no
          // concrete window so the agent doesn't contribute to coverage.
          shift = schedulesByDow.get(dow) ?? null;
          if (shift && !shift.isWorking) shift = null;
        } else {
          // OFF / SICK / ON_LEAVE — agent isn't covering.
          continue;
        }
      } else {
        const ws = schedulesByDow.get(dow);
        shift = ws && ws.isWorking ? ws : null;
      }
      if (!shift || !shift.startTime || !shift.endTime) continue;

      const shiftStart = parseHHMM(shift.startTime);
      const shiftEnd = parseHHMM(shift.endTime);
      const breakStart = shift.breakStart ? parseHHMM(shift.breakStart) : null;
      const breakEnd = shift.breakEnd ? parseHHMM(shift.breakEnd) : null;
      if (shiftStart == null || shiftEnd == null) continue;

      // Walk every slot in the visualisation window and decide if this
      // agent is on-shift at the slot's *start instant*. Half-open
      // intervals: [shiftStart, shiftEnd) and [breakStart, breakEnd).
      for (let slotIdx = 0; slotIdx < slotsCount; slotIdx++) {
        const slotMin = hourFrom + slotIdx * intervalMinutes;
        const onShift = slotMin >= shiftStart && slotMin < shiftEnd;
        if (!onShift) continue;
        const onBreak = breakStart != null && breakEnd != null
          && slotMin >= breakStart && slotMin < breakEnd;
        if (onBreak) continue;
        grid[slotIdx][dayIdx]++;
      }
    }
  }

  // ─── Shape response ────────────────────────────────────────────────
  const slots = Array.from({ length: slotsCount }, (_, i) => ({
    time: minutesToHHMM(hourFrom + i * intervalMinutes),
    dayCounts: grid[i],
  }));

  // dayIdx → date label
  const dates: string[] = [];
  const dayLabels: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
    dayLabels.push(DAY_NAMES_FULL[d.getUTCDay()]);
  }

  // ─── Summary ───────────────────────────────────────────────────────
  let totalSlots = 0, gapSlots = 0, lowCoverageSlots = 0, peakConcurrent = 0;
  for (const slot of slots) {
    for (const c of slot.dayCounts) {
      totalSlots++;
      if (c === 0) gapSlots++;
      else if (c < lowCoverageThreshold) lowCoverageSlots++;
      if (c > peakConcurrent) peakConcurrent = c;
    }
  }

  return NextResponse.json({
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
    hourFrom: minutesToHHMM(hourFrom),
    hourTo: minutesToHHMM(hourTo),
    intervalMinutes,
    lowCoverageThreshold,
    days: dayLabels,
    dates,
    slots,
    summary: { totalSlots, gapSlots, lowCoverageSlots, peakConcurrent, agentsConsidered: team.length },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
function hhmmToMinutes(s: string): number {
  return parseHHMM(s) ?? 0;
}
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
