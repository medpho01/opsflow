/**
 * One wake of one journey (DESIGN.md §4.3, step 11): load, read the console,
 * run the pure step, then persist the journey, its checkpoints and its new
 * events in one transaction, and hand every proposed action to the guard.
 *
 * The worker runs this under a per-order singleton key, so two wakes of the
 * same order never overlap (FR-1.2).
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { fetchOrderSnapshot } from "./window";
import { step, type CheckpointState, type JourneyEvent, type JourneyState } from "./step";
import type { OrderSnapshot } from "./policy";
import { guard, loadGuardState, type GuardState } from "../guard/guard";

export type WakeReason = "sweep" | "timer" | "console_change" | "opened" | "person" | "inbound" | "block_start";

export type WakeResult = { orderId: number; opened: boolean; closed: boolean; events: number; actions: number; skipped?: string };

const asDate = (v: unknown): Date | null => (typeof v === "string" || v instanceof Date ? new Date(v) : null);

function toJourneyState(row: Prisma.AgentJourneyGetPayload<{ include: { checkpoints: true } }>): JourneyState {
  const snap = row.consoleSnapshot as Record<string, unknown> | null;
  const consoleSnapshot: OrderSnapshot | null = snap ? {
    id: Number(snap.id), orderType: String(snap.orderType), orderStatus: String(snap.orderStatus),
    appointmentTime: asDate(snap.appointmentTime), labId: snap.labId == null ? null : Number(snap.labId), storeId: snap.storeId == null ? null : Number(snap.storeId),
    createdAt: asDate(snap.createdAt) ?? row.openedAt, statusUpdatedAt: asDate(snap.statusUpdatedAt),
    phleboName: String(snap.phleboName ?? ""), patientName: (snap.patientName as string | null) ?? null,
    labName: (snap.labName as string | null) ?? null, storeName: (snap.storeName as string | null) ?? null,
  } : null;
  return {
    orderId: row.orderId, orderType: row.orderType, labId: row.labId, storeId: row.storeId, stage: row.stage, subStates: row.subStates,
    waitingFor: (row.waitingFor as JourneyState["waitingFor"]) ?? null, dueAt: row.dueAt, dueSource: (row.dueSource as JourneyState["dueSource"]) ?? null,
    nextCheckAt: row.nextCheckAt, health: row.health as JourneyState["health"], ownerUserId: row.ownerUserId, pausedUntil: row.pausedUntil,
    attempts: (row.attempts as Record<string, number>) ?? {}, brokenPromises: row.brokenPromises,
    consoleFingerprint: row.consoleFingerprint, consoleSnapshot,
    plan: ((row.plan as unknown[]) ?? []).map((p) => { const i = p as Record<string, unknown>; return { id: String(i.id), label: String(i.label), state: i.state as "DONE" | "NOW" | "NEXT", at: asDate(i.at) }; }),
    closedAt: row.closedAt, closeReason: row.closeReason,
  };
}

const toCheckpointState = (c: { name: string; dueAt: Date; dueSource: string; metAt: Date | null; status: string }): CheckpointState =>
  ({ name: c.name as CheckpointState["name"], dueAt: c.dueAt, dueSource: c.dueSource as CheckpointState["dueSource"], metAt: c.metAt, status: c.status as CheckpointState["status"] });

/** Wake one journey. `order` may be passed by the sweep to save a replica read. */
export async function wakeJourney(orderId: number, reason: WakeReason, opts: { now?: Date; order?: OrderSnapshot; guardState?: GuardState } = {}): Promise<WakeResult> {
  const now = opts.now ?? new Date();
  const row = await prisma.agentJourney.findUnique({ where: { orderId }, include: { checkpoints: true } });
  if (row?.closedAt) return { orderId, opened: false, closed: true, events: 0, actions: 0, skipped: "journey closed" };

  // The replica is the truth; when it has nothing (lag, an outage), an existing journey
  // still applies people's events on its last snapshot. Nothing is ever written to the
  // console from a snapshot: the guard records in shadow and executors re-read first.
  let order = opts.order ?? await fetchOrderSnapshot(orderId);
  if (!order && row) order = toJourneyState(row).consoleSnapshot;
  if (!order) return { orderId, opened: false, closed: false, events: 0, actions: 0, skipped: "order not in the replica" };

  const pending = row ? await prisma.agentJourneyEvent.findMany({ where: { journeyId: row.id, applied: false }, orderBy: { at: "asc" } }) : [];
  const events: JourneyEvent[] = pending.map((e) => ({ kind: e.kind, at: e.at, actor: e.actor, payload: (e.payload as Record<string, unknown>) ?? {} }));

  const out = step({ now, order, journey: row ? toJourneyState(row) : null, checkpoints: row ? row.checkpoints.map(toCheckpointState) : [], events });
  const j = out.journey;
  const data = {
    orderType: j.orderType, labId: j.labId, storeId: j.storeId, stage: j.stage, subStates: j.subStates,
    waitingFor: (j.waitingFor ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull, dueAt: j.dueAt, dueSource: j.dueSource, nextCheckAt: j.nextCheckAt,
    health: j.health, ownerUserId: j.ownerUserId, pausedUntil: j.pausedUntil, attempts: j.attempts as Prisma.InputJsonValue, brokenPromises: j.brokenPromises,
    consoleFingerprint: j.consoleFingerprint, consoleSnapshot: j.consoleSnapshot as unknown as Prisma.InputJsonValue,
    plan: j.plan.map((p) => ({ ...p, at: p.at ? p.at.toISOString() : null })) as Prisma.InputJsonValue,
    closedAt: j.closedAt, closeReason: j.closeReason,
  };

  const journeyId = await prisma.$transaction(async (tx) => {
    const saved = row
      ? await tx.agentJourney.update({ where: { id: row.id }, data, select: { id: true } })
      : await tx.agentJourney.create({ data: { orderId, ...data }, select: { id: true } });
    for (const c of out.checkpoints) {
      await tx.agentCheckpoint.upsert({
        where: { journeyId_name: { journeyId: saved.id, name: c.name } },
        update: { dueAt: c.dueAt, dueSource: c.dueSource, metAt: c.metAt, status: c.status },
        create: { journeyId: saved.id, name: c.name, dueAt: c.dueAt, dueSource: c.dueSource, metAt: c.metAt, status: c.status },
      });
    }
    const gone = new Set(out.checkpoints.map((c) => c.name));
    const stale = (row?.checkpoints ?? []).filter((c) => !gone.has(c.name as CheckpointState["name"]));
    if (stale.length) await tx.agentCheckpoint.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
    if (pending.length) await tx.agentJourneyEvent.updateMany({ where: { id: { in: pending.map((e) => e.id) } }, data: { applied: true } });
    const opening: JourneyEvent[] = row ? [] : [{ kind: "opened", at: now, actor: "SYSTEM", payload: { reason, orderStatus: order.orderStatus, appointmentTime: order.appointmentTime } }];
    const toWrite = [...opening, ...out.newEvents];
    if (toWrite.length) {
      await tx.agentJourneyEvent.createMany({
        data: toWrite.map((e) => ({ journeyId: saved.id, at: e.at, kind: e.kind, actor: e.actor, payload: e.payload as Prisma.InputJsonValue, applied: true })),
      });
    }
    return saved.id;
  });

  let actions = 0;
  if (out.actions.length) {
    const state = opts.guardState ?? await loadGuardState();
    for (const action of out.actions) {
      await guard(action, { journeyId, orderId, labId: j.labId, storeId: j.storeId }, state);
      actions += 1;
    }
  }
  return { orderId, opened: !row, closed: !!j.closedAt, events: out.newEvents.length, actions };
}
