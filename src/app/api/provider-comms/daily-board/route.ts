/**
 * GET /api/provider-comms/daily-board — today and tomorrow, per provider.
 *
 * Answers the question an Ops head actually starts the day with: for each lab
 * we talk to, how much work is coming, how much of it they have confirmed, and
 * what is already going wrong. PRD §31 (daily provider business summary) and
 * §41 (operations dashboard, built around exceptions).
 *
 * Two sources, joined per lab:
 *   LabStack  — the orders themselves, counted by day and status
 *   OpsFlow   — whether the provider has actually answered, from the
 *               confirmation workflows and their communication history
 *
 * "Today" and "tomorrow" are in the operating timezone, not UTC. A board that
 * rolls over at 05:30 local would be wrong for exactly the people using it.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
// Counted in one place, shared with the WhatsApp digest the provider itself
// receives. A board that says 14 while the message says 11 destroys trust in
// both, so neither owns the query. See lib/provider-comms/day-summary.ts.
import {
  loadDaySummaries, todayKey, tomorrowKey, localDayKey, TIME_ZONE, type DayCounts,
} from "@/lib/provider-comms/day-summary";
import { fetchOrderSnapshotsByIds } from "@/lib/engine/labstack";
import { classifySourceOrder, isAwaitingConfirmation } from "@/lib/non-api-labs/source-check";

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const configs = await prisma.nonApiLabConfig.findMany({
      orderBy: [{ isActive: "desc" }, { labName: "asc" }],
    });
    if (configs.length === 0) return NextResponse.json({ labs: [], generatedAt: new Date().toISOString() });

    const labIds = configs.map((config) => config.labId);
    const zone = TIME_ZONE();
    const summaries = await loadDaySummaries(labIds, zone);

    const today = todayKey(zone);
    const tomorrow = tomorrowKey(zone);

    // How the provider is answering us, for the orders on THIS board only —
    // today's and tomorrow's appointments. Counting every workflow ever
    // started showed long-gone orders as "escalated" forever: a workflow is
    // only closed when its next reminder comes due, so an order cancelled
    // after its last reminder never was.
    const now = Date.now();
    const inWindow = (await prisma.labCommunicationWorkflow.findMany({
      where: {
        labId: { in: labIds },
        appointmentTime: { gte: new Date(now - 36 * 3_600_000), lt: new Date(now + 60 * 3_600_000) },
      },
      select: { labId: true, orderId: true, status: true, appointmentTime: true },
    })).filter((w) => w.appointmentTime && [today, tomorrow].includes(localDayKey(w.appointmentTime, zone)));

    // "Still unconfirmed" is LabStack's call: the lab confirms on the LabStack
    // confirmation page. An order cancelled or already confirmed there is not
    // awaiting anything, whatever its workflow last recorded. If LabStack is
    // unreachable the workflow status is shown as-is rather than nothing.
    const open = inWindow.filter((w) => w.status === "WAITING_FOR_LAB_CONFIRMATION" || w.status === "ESCALATED");
    const snapshots = open.length > 0 ? await fetchOrderSnapshotsByIds(open.map((w) => w.orderId)) : new Map();
    const stillOpen = (orderId: number) => {
      if (!snapshots) return true;
      const snapshot = snapshots.get(orderId);
      return classifySourceOrder(snapshot, null).kind !== "CLOSE" && isAwaitingConfirmation(snapshot?.orderStatus);
    };
    const workflows = inWindow.map((w) => ({
      ...w,
      status: (w.status === "WAITING_FOR_LAB_CONFIRMATION" || w.status === "ESCALATED") && !stillOpen(w.orderId)
        ? "SETTLED"
        : w.status,
    }));

    // Milestone breaches still unresolved — the exceptions §41 wants surfaced.
    const openBreaches = await prisma.slaBreachEvent.groupBy({
      by: ["labId"],
      where: { labId: { in: labIds }, status: "ACTIVE" },
      _count: true,
    });

    /** Dates cross the wire as ISO strings; everything else is already a number. */
    const serialize = (counts: DayCounts) => ({
      ...counts,
      firstAppointment: counts.firstAppointment?.toISOString() ?? null,
      nextAppointment: counts.nextAppointment?.toISOString() ?? null,
    });

    const labs = configs.map((config) => {
      const mine = workflows.filter((w) => w.labId === config.labId);
      const count = (status: string) => mine.filter((w) => w.status === status).length;
      return {
        labId: config.labId,
        labName: config.labName,
        integrationType: config.integrationType,
        isActive: config.isActive,
        // A lab with no target cannot be chased, however many orders it has.
        reachable: !!(config.waGroupJid || config.whatsappNumber),
        today: serialize(summaries.get(config.labId)!.today),
        tomorrow: serialize(summaries.get(config.labId)!.tomorrow),
        confirmation: {
          // Escalated orders are still unconfirmed — counted in both, so the
          // headline "awaiting" never reads lower than the escalations under it.
          awaiting: count("WAITING_FOR_LAB_CONFIRMATION") + count("ESCALATED"),
          accepted: count("LAB_ACCEPTED"),
          rescheduleRequested: count("LAB_RESCHEDULE_REQUESTED"),
          rejected: count("LAB_REJECTED"),
          escalated: count("ESCALATED"),
        },
        openBreaches: openBreaches.find((b) => b.labId === config.labId)?._count ?? 0,
      };
    });

    return NextResponse.json({ labs, timeZone: zone, today, tomorrow, generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId, scope: "ProviderCommsDailyBoardAPI.GET", code: "FETCH_ERROR",
        userMessage: "Failed to load the provider board", error,
      }),
      { status: 500 },
    );
  }
}
