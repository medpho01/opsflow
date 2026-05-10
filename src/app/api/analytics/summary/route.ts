/**
 * GET /api/analytics/summary?date=YYYY-MM-DD
 *
 * Daily operational summary — used by the summary panel and the daily
 * summary cron.
 *
 * Audit (feature 07) rewrites:
 *
 *  - "Today" was anchored to UTC midnight (`Date.UTC(...)`). Server in
 *    UTC + DB in IST meant `dayStart` = 05:30 IST, so events between IST
 *    midnight and 05:30 IST were silently counted under the wrong day.
 *    Now anchored to IST midnight via the shared helper.
 *
 *  - Date param parsing now NaN-checks the resulting Date (the prior
 *    regex matched but didn't validate, so `9999-99-99` produced a
 *    garbage Invalid Date downstream).
 *
 *  - SLA-health divisor: previously divided "agent-only compliant
 *    completions" by "all-roles completed today". If any OPS_HEAD
 *    completed a task, the ratio could exceed 100%. Now both numerator
 *    and divisor come from the same scoped count.
 *
 *  - Day with zero completed → `slaHealthPercent = 100` (matches the
 *    /api/dashboard convention; previously this returned 0, disagreed
 *    with the dashboard, and the "zero work, 0% SLA" reading was
 *    misleading).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";
import { startOfTodayIST, parseDateOrNull } from "../_helpers";

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");

  // IST-anchored dayStart. parseDateOrNull falls back to today's IST
  // midnight if the param is absent or malformed.
  const dayStart = parseDateOrNull(dateParam) ?? startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [
    createdToday,
    completedToday,
    breachedToday,
    openCarryover,
    slaCompliantToday,
    agentStats,
    pollStats,
  ] = await Promise.all([
    prisma.task.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { status: TaskStatus.COMPLETED, completedAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { slaBreachedAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({
      where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
    }),
    // SLA-compliant completions (numerator scoped to the same set as
    // `completedToday` — eliminates the divisor mismatch).
    prisma.task.count({
      where: {
        status: TaskStatus.COMPLETED,
        completedAt: { gte: dayStart, lt: dayEnd },
        slaBreachedAt: null,
      },
    }),

    // Per-agent completed today.
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        assignedTasks: {
          where: {
            status: TaskStatus.COMPLETED,
            completedAt: { gte: dayStart, lt: dayEnd },
          },
          select: { id: true, slaBreachedAt: true },
        },
      },
      orderBy: { name: "asc" },
    }),

    // Polling cycles in the day.
    prisma.pollingLog.findMany({
      where: { startedAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { startedAt: "desc" },
      select: { status: true, ordersFound: true, tasksCreated: true, durationMs: true },
    }),
  ]);

  // SLA health: zero completed → 100 (matches /api/dashboard's "no work,
  // perfect score" convention).
  const slaHealth =
    completedToday > 0
      ? Math.round((slaCompliantToday / completedToday) * 100)
      : 100;

  const agentBreakdown = agentStats
    .map((a) => ({
      name: a.name,
      completed: a.assignedTasks.length,
      slaCompliant: a.assignedTasks.filter((t) => !t.slaBreachedAt).length,
    }))
    .filter((a) => a.completed > 0)
    .sort((a, b) => b.completed - a.completed);

  const pollSummary = {
    cycles: pollStats.length,
    errors: pollStats.filter((p) => p.status === "ERROR").length,
    totalOrders: pollStats.reduce((s, p) => s + p.ordersFound, 0),
    totalTasksCreated: pollStats.reduce((s, p) => s + p.tasksCreated, 0),
    avgDurationMs:
      pollStats.length > 0
        ? Math.round(pollStats.reduce((s, p) => s + (p.durationMs ?? 0), 0) / pollStats.length)
        : 0,
  };

  // Format the date back in IST (the wall-clock day the head asked
  // about). Using `toISOString().split("T")[0]` would format in UTC
  // and underreport by a day at the IST/UTC boundary.
  const dateKey = dayStart.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return NextResponse.json({
    date: dateKey,
    summary: {
      createdToday,
      completedToday,
      breachedToday,
      openCarryover,
      slaHealthPercent: slaHealth,
    },
    agentBreakdown,
    pollSummary,
  });
}
