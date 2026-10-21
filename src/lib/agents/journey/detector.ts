/**
 * The sweep (DESIGN.md §4.2, FR-1.3): every minute, read the active window
 * from the replica, open journeys for new orders, wake the ones whose
 * console fingerprint changed or whose next check is due, and close the ones
 * that left the window. Level-triggered, so a missed event or a worker
 * restart heals itself on the next pass.
 *
 * `wake` is injected: the worker hands it the queue, tests hand it a stub.
 * With no queue the sweep runs the wakes inline (one process, dev runs).
 */
import prisma from "@/lib/db/client";
import { fetchActiveWindow } from "./window";
import { fingerprint } from "./step";
import { wakeJourney, type WakeReason } from "./run";
import { loadGuardState } from "../guard/guard";
import type { OrderSnapshot } from "./policy";

export type SweepResult = { window: number; opened: number; changed: number; due: number; closedOut: number; errors: number };

export type Wake = (orderId: number, reason: WakeReason, order?: OrderSnapshot) => Promise<void>;

export async function sweep(now = new Date(), wake?: Wake): Promise<SweepResult> {
  const result: SweepResult = { window: 0, opened: 0, changed: 0, due: 0, closedOut: 0, errors: 0 };
  const orders = await fetchActiveWindow();
  result.window = orders.length;
  const byId = new Map(orders.map((o) => [o.id, o]));

  const open = await prisma.agentJourney.findMany({
    where: { closedAt: null },
    select: { orderId: true, consoleFingerprint: true, nextCheckAt: true },
  });
  const known = new Map(open.map((j) => [j.orderId, j]));

  const guardState = await loadGuardState();
  const run: Wake = wake ?? (async (orderId, reason, order) => { await wakeJourney(orderId, reason, { now, order, guardState }); });

  for (const order of orders) {
    const j = known.get(order.id);
    let reason: WakeReason | null = null;
    if (!j) reason = "opened";
    else if (j.consoleFingerprint !== fingerprint(order)) reason = "console_change";
    else if (j.nextCheckAt && j.nextCheckAt.getTime() <= now.getTime()) reason = "timer";
    if (!reason) continue;
    try {
      await run(order.id, reason, order);
      if (reason === "opened") result.opened += 1; else if (reason === "console_change") result.changed += 1; else result.due += 1;
    } catch (error) {
      result.errors += 1;
      console.error(`[Agents] wake ${order.id} (${reason}) failed:`, error instanceof Error ? error.message : error);
    }
  }

  // Orders that left the window without a terminal status we saw: close with a note, never silently.
  const gone = open.filter((j) => !byId.has(j.orderId)).map((j) => j.orderId);
  if (gone.length) {
    const closed = await prisma.agentJourney.updateMany({
      where: { orderId: { in: gone }, closedAt: null },
      data: { closedAt: now, closeReason: "LEFT_WINDOW", nextCheckAt: null },
    });
    result.closedOut = closed.count;
    const rows = await prisma.agentJourney.findMany({ where: { orderId: { in: gone }, closeReason: "LEFT_WINDOW", closedAt: now }, select: { id: true } });
    if (rows.length) {
      await prisma.agentJourneyEvent.createMany({
        data: rows.map((r) => ({ journeyId: r.id, at: now, kind: "closed", actor: "SYSTEM", payload: { reason: "LEFT_WINDOW" }, applied: true })),
      });
    }
  }
  return result;
}
