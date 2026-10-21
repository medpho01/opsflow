/**
 * Replay (FR-5.5, FR-14.4): run step() again over a journey's recorded
 * events with another SOP version, and report which actions would differ.
 * Possible because step() is pure and every input is in the event log:
 * console snapshots in console_change events, facts, people's actions.
 */
import prisma from "@/lib/db/client";
import { step, type CheckpointState, type JourneyEvent, type JourneyState, type ProposedAction } from "../journey/step";
import type { OrderSnapshot } from "../journey/policy";
import { resolveParams, type SopBody } from "../sop/schema";
import { loadDirectory, tierOf } from "../directory";

export type ReplayDiff = { orderId: number; added: string[]; removed: string[]; moved: Array<{ action: string; from: string; to: string }> };
export type ReplayResult = { journeys: number; unchanged: number; changed: number; asksEarlierMin: number; asksAdded: number; asksRemoved: number; tasksAdded: number; callsAdded: number; labsAffected: string[]; samples: ReplayDiff[] };

const asDate = (v: unknown): Date | null => (typeof v === "string" || v instanceof Date ? new Date(v) : null);

/** Rebuild the console snapshot at each event from the event's own payload. */
function snapshotAt(base: OrderSnapshot, ev: JourneyEvent): OrderSnapshot {
  if (ev.kind !== "console_change") return base;
  const to = ev.payload.to as { status?: string; appointmentTime?: string | Date | null; labId?: number | null } | undefined;
  return { ...base, orderStatus: to?.status ?? base.orderStatus, appointmentTime: to?.appointmentTime !== undefined ? asDate(to.appointmentTime) : base.appointmentTime, labId: to?.labId !== undefined ? to.labId ?? null : base.labId, statusUpdatedAt: ev.at };
}

const key = (a: ProposedAction) => `${a.action}:${String(a.params.checkpoint ?? a.params.to ?? "")}`;

/** Run one journey's history through a SOP body; returns the actions by time. */
export async function replayJourney(journeyId: string, body: SopBody): Promise<Array<{ at: Date; action: ProposedAction }>> {
  const j = await prisma.agentJourney.findUnique({ where: { id: journeyId }, include: { events: { orderBy: { at: "asc" } } } });
  if (!j) return [];
  const dir = await loadDirectory();
  const opened = j.events.find((e) => e.kind === "opened" || e.kind === "console_change");
  const snap = j.consoleSnapshot as Record<string, unknown> | null;
  if (!opened || !snap) return [];
  let order: OrderSnapshot = {
    id: j.orderId, orderType: j.orderType, orderStatus: String((opened.payload as { orderStatus?: string }).orderStatus ?? snap.orderStatus), appointmentTime: asDate((opened.payload as { appointmentTime?: string }).appointmentTime ?? snap.appointmentTime),
    labId: j.labId, storeId: j.storeId, createdAt: asDate(snap.createdAt) ?? j.openedAt, statusUpdatedAt: null, phleboName: "", patientName: (snap.patientName as string) ?? null, labName: (snap.labName as string) ?? null, storeName: (snap.storeName as string) ?? null,
  };
  const params = resolveParams(body, { labTier: tierOf(dir, j.labId), labId: j.labId, storeId: j.storeId, orderType: j.orderType });
  let state: JourneyState | null = null;
  let checkpoints: CheckpointState[] = [];
  const out: Array<{ at: Date; action: ProposedAction }> = [];
  // Group events by minute and wake once per group, as the sweep would have.
  const groups = new Map<number, JourneyEvent[]>();
  for (const e of j.events) {
    const ev: JourneyEvent = { kind: e.kind, at: e.at, actor: e.actor, payload: (e.payload as Record<string, unknown>) ?? {} };
    const slot = Math.floor(e.at.getTime() / 60_000);
    groups.set(slot, [...(groups.get(slot) ?? []), ev]);
  }
  const lastAt = j.closedAt ?? new Date();
  const slots = [...groups.keys()].sort((a, b) => a - b);
  // Also wake at every 30 minutes between events, so timers fire as they did.
  const wakes = new Set<number>(slots);
  for (let t = slots[0]; t <= Math.floor(lastAt.getTime() / 60_000); t += 30) wakes.add(t);
  for (const slot of [...wakes].sort((a, b) => a - b)) {
    const events = (groups.get(slot) ?? []).filter((e) => e.kind !== "ask" && e.kind !== "promise" && e.kind !== "promise_broken" && e.kind !== "closed" && e.kind !== "write" && e.kind !== "task");
    for (const e of events) order = snapshotAt(order, e);
    const now = new Date(slot * 60_000 + 59_000);
    const result = step({ now, order, journey: state, checkpoints, events: events.filter((e) => e.kind !== "console_change" && e.kind !== "opened"), sop: params, labTier: tierOf(dir, j.labId), timeZone: process.env.TIMEZONE || "Asia/Kolkata" });
    state = result.journey; checkpoints = result.checkpoints;
    for (const a of result.actions) out.push({ at: now, action: a });
    if (state.closedAt) break;
  }
  return out;
}

/** Replay a candidate SOP against the journeys of the last `days`, against what the live SOP produces on the same history. */
export async function replaySop(candidate: SopBody, live: SopBody, days = 14, limit = 300): Promise<ReplayResult> {
  const since = new Date(Date.now() - days * 86_400_000);
  const journeys = await prisma.agentJourney.findMany({ where: { openedAt: { gte: since }, labId: { not: null } }, select: { id: true, orderId: true, labId: true }, take: limit, orderBy: { openedAt: "desc" } });
  const dir = await loadDirectory();
  const result: ReplayResult = { journeys: journeys.length, unchanged: 0, changed: 0, asksEarlierMin: 0, asksAdded: 0, asksRemoved: 0, tasksAdded: 0, callsAdded: 0, labsAffected: [], samples: [] };
  const labs = new Set<string>();
  let earlierSum = 0; let earlierN = 0;
  for (const j of journeys) {
    const [before, after] = await Promise.all([replayJourney(j.id, live), replayJourney(j.id, candidate)]);
    const b = new Map(before.map((x) => [key(x.action), x])); const a = new Map(after.map((x) => [key(x.action), x]));
    const diff: ReplayDiff = { orderId: j.orderId, added: [], removed: [], moved: [] };
    for (const [k, x] of a) {
      const prev = b.get(k);
      if (!prev) { diff.added.push(k); if (k.startsWith("ask") || k.startsWith("reminder")) result.asksAdded += 1; if (k.startsWith("create_task")) result.tasksAdded += 1; if (k.startsWith("call")) result.callsAdded += 1; }
      else if (Math.abs(prev.at.getTime() - x.at.getTime()) >= 5 * 60_000) { diff.moved.push({ action: k, from: prev.at.toISOString(), to: x.at.toISOString() }); if (x.at < prev.at) { earlierSum += (prev.at.getTime() - x.at.getTime()) / 60_000; earlierN += 1; } }
    }
    for (const k of b.keys()) if (!a.has(k)) { diff.removed.push(k); if (k.startsWith("ask") || k.startsWith("reminder")) result.asksRemoved += 1; }
    if (diff.added.length || diff.removed.length || diff.moved.length) { result.changed += 1; labs.add(dir.labs.get(j.labId!)?.labName ?? String(j.labId)); if (result.samples.length < 20) result.samples.push(diff); }
    else result.unchanged += 1;
  }
  result.asksEarlierMin = earlierN ? Math.round(earlierSum / earlierN) : 0;
  result.labsAffected = [...labs];
  return result;
}
