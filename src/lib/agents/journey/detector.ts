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
import { loadLiveSops } from "../sop/load";
import { loadDirectory } from "../directory";
import type { OrderSnapshot } from "./policy";

export type SweepResult = { window: number; opened: number; changed: number; due: number; closedOut: number; errors: number };

export type Wake = (orderId: number, reason: WakeReason, order?: OrderSnapshot, labSilentHours?: number | null) => Promise<void>;

/** Hours since each lab's group last wrote (lab-side, not our team), for risk and the lab board. */
export async function labSilence(labIds: number[], now: Date): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (!labIds.length) return out;
  const configs = await prisma.nonApiLabConfig.findMany({ where: { labId: { in: labIds }, waGroupJid: { not: null } }, select: { labId: true, waGroupJid: true } });
  const groups = await prisma.waGroup.findMany({ where: { jid: { in: configs.map((c) => c.waGroupJid!) }, archivedAt: null }, select: { id: true, jid: true } });
  const lastByJid = new Map<string, number | null>();
  for (const g of groups) {
    const last = await prisma.waMessage.findFirst({ where: { groupId: g.id, direction: "IN", fromMe: false }, orderBy: { ts: "desc" }, select: { ts: true } });
    lastByJid.set(g.jid, last ? (now.getTime() - last.ts.getTime()) / 3_600_000 : null);
  }
  for (const c of configs) if (lastByJid.has(c.waGroupJid!)) out.set(c.labId, lastByJid.get(c.waGroupJid!)!);
  return out;
}

export async function sweep(now = new Date(), wake?: Wake, opts: { reason?: WakeReason; all?: boolean } = {}): Promise<SweepResult> {
  const result: SweepResult = { window: 0, opened: 0, changed: 0, due: 0, closedOut: 0, errors: 0 };
  const orders = await fetchActiveWindow();
  result.window = orders.length;
  const byId = new Map(orders.map((o) => [o.id, o]));

  const open = await prisma.agentJourney.findMany({ where: { closedAt: null }, select: { orderId: true, consoleFingerprint: true, nextCheckAt: true } });
  const known = new Map(open.map((j) => [j.orderId, j]));
  // Orders whose journey is already closed (delivered, cancelled, done) stay in the window for a
  // week, and a wake of a closed journey does nothing. They used to be re-queued as "opened" on
  // every sweep — ~1,500 a minute, a backlog that delayed every real wake (26 Oct 2026).
  const unknownIds = orders.filter((o) => !known.has(o.id)).map((o) => o.id);
  const closed = new Set(unknownIds.length ? (await prisma.agentJourney.findMany({ where: { orderId: { in: unknownIds }, closedAt: { not: null } }, select: { orderId: true } })).map((j) => j.orderId) : []);

  const [guardState, sops, directory] = await Promise.all([loadGuardState(), loadLiveSops(), loadDirectory()]);
  const silence = await labSilence([...new Set(orders.map((o) => o.labId).filter((x): x is number => x != null))], now);
  const run: Wake = wake ?? (async (orderId, reason, order, labSilentHours) => { await wakeJourney(orderId, reason, { now, order, guardState, sops, directory, labSilentHours }); });

  for (const order of orders) {
    const j = known.get(order.id);
    if (!j && closed.has(order.id)) continue;
    let reason: WakeReason | null = null;
    if (!j) reason = "opened";
    else if (j.consoleFingerprint !== fingerprint(order)) reason = "console_change";
    else if (opts.all) reason = opts.reason ?? "block_start";
    else if (j.nextCheckAt && j.nextCheckAt.getTime() <= now.getTime()) reason = "timer";
    if (!reason) continue;
    try {
      await run(order.id, reason, order, order.labId != null ? silence.get(order.labId) ?? null : null);
      if (reason === "opened") result.opened += 1; else if (reason === "console_change") result.changed += 1; else result.due += 1;
    } catch (error) {
      result.errors += 1;
      console.error(`[Agents] wake ${order.id} (${reason}) failed:`, error instanceof Error ? error.message : error);
    }
  }

  const gone = open.filter((j) => !byId.has(j.orderId)).map((j) => j.orderId);
  if (gone.length) {
    const closed = await prisma.agentJourney.updateMany({ where: { orderId: { in: gone }, closedAt: null }, data: { closedAt: now, closeReason: "LEFT_WINDOW", nextCheckAt: null } });
    result.closedOut = closed.count;
    const rows = await prisma.agentJourney.findMany({ where: { orderId: { in: gone }, closeReason: "LEFT_WINDOW", closedAt: now }, select: { id: true } });
    if (rows.length) await prisma.agentJourneyEvent.createMany({ data: rows.map((r) => ({ journeyId: r.id, at: now, kind: "closed", actor: "SYSTEM", payload: { reason: "LEFT_WINDOW" }, applied: true })) });
    await prisma.agentOutboxItem.updateMany({ where: { orderId: { in: gone }, status: "QUEUED" }, data: { status: "WITHDRAWN" } });
  }
  return result;
}
