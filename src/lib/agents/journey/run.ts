/**
 * One wake of one journey (DESIGN.md §4.3, step 11): load, read the console,
 * resolve the SOP for this order, run the pure step, then persist the journey,
 * its checkpoints, its risk and its new events in one transaction, withdraw
 * asks the step cancelled, and hand every proposed action to the guard.
 *
 * The worker runs this under a per-order singleton key, so two wakes of the
 * same order never overlap (FR-1.2).
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { fetchOrderSnapshot } from "./window";
import { typicalSlotsFor } from "../slots";
import { step, type Attempt, type CheckpointState, type JourneyEvent, type JourneyState, type ProposedAction } from "./step";
import type { OrderSnapshot } from "./policy";
import { guard, loadGuardState, type GuardState } from "../guard/guard";
import { loadLiveSops, paramsFor, type LiveSop } from "../sop/load";
import { loadDirectory, tierOf, type Directory } from "../directory";
import { withdrawOutbox } from "../executors/dispatcher";
import { caseWorker } from "../caseworker";
import { labChaseable } from "../store/scope";

export type WakeReason = "sweep" | "timer" | "console_change" | "opened" | "person" | "inbound" | "block_start" | "risk_batch";

export type WakeResult = { orderId: number; opened: boolean; closed: boolean; events: number; actions: number; executed: number; review: number; skipped?: string };

export type WakeContext = { now?: Date; order?: OrderSnapshot; guardState?: GuardState; sops?: Map<string, LiveSop>; directory?: Directory; labSilentHours?: number | null };

const asDate = (v: unknown): Date | null => (typeof v === "string" || v instanceof Date ? new Date(v) : null);

export function toJourneyState(row: Prisma.AgentJourneyGetPayload<{ include: { checkpoints: true } }>): JourneyState {
  const snap = row.consoleSnapshot as Record<string, unknown> | null;
  const consoleSnapshot: OrderSnapshot | null = snap ? {
    id: Number(snap.id), orderType: String(snap.orderType), orderStatus: String(snap.orderStatus),
    appointmentTime: asDate(snap.appointmentTime), labId: snap.labId == null ? null : Number(snap.labId), storeId: snap.storeId == null ? null : Number(snap.storeId),
    createdAt: asDate(snap.createdAt) ?? row.openedAt, statusUpdatedAt: asDate(snap.statusUpdatedAt),
    phleboName: String(snap.phleboName ?? ""), patientName: (snap.patientName as string | null) ?? null,
    labName: (snap.labName as string | null) ?? null, storeName: (snap.storeName as string | null) ?? null,
  } : null;
  const rawAttempts = (row.attempts as Record<string, unknown>) ?? {};
  const attempts: Record<string, Attempt> = {};
  for (const [k, v] of Object.entries(rawAttempts)) attempts[k] = typeof v === "number" ? { n: v, at: null } : (v as Attempt);
  const meta = (snap?.__journey as Record<string, unknown> | undefined) ?? {};
  return {
    orderId: row.orderId, orderType: row.orderType, labId: row.labId, storeId: row.storeId, stage: row.stage, subStates: row.subStates,
    waitingFor: (row.waitingFor as JourneyState["waitingFor"]) ?? null, dueAt: row.dueAt, dueSource: (row.dueSource as JourneyState["dueSource"]) ?? null,
    nextCheckAt: row.nextCheckAt, health: row.health as JourneyState["health"], riskLevel: row.riskLevel as JourneyState["riskLevel"], riskReasons: row.riskReasons,
    ownerUserId: row.ownerUserId, pausedUntil: row.pausedUntil, attempts, brokenPromises: row.brokenPromises,
    rescheduleCount: Number(meta.rescheduleCount ?? 0),
    consoleFingerprint: row.consoleFingerprint, consoleSnapshot,
    plan: ((row.plan as unknown[]) ?? []).map((p) => { const i = p as Record<string, unknown>; return { id: String(i.id), label: String(i.label), state: i.state as "DONE" | "NOW" | "NEXT", at: asDate(i.at) }; }),
    sopVersionId: row.sopVersionId, closedAt: row.closedAt, closeReason: row.closeReason,
  };
}

const toCheckpointState = (c: { name: string; dueAt: Date; dueSource: string; metAt: Date | null; status: string }): CheckpointState =>
  ({ name: c.name as CheckpointState["name"], dueAt: c.dueAt, dueSource: c.dueSource as CheckpointState["dueSource"], metAt: c.metAt, status: c.status as CheckpointState["status"] });

/**
 * The same store alert for the same order within two hours is a repeat (Plum, 25 Oct 2026: "sample
 * collected" three times in 20 minutes, "not reachable" twice). A promise or a reschedule repeats
 * only when it says the same thing — a new time is news.
 */
export async function repeatsRecentAlert(orderId: number, action: ProposedAction, now: Date): Promise<boolean> {
  if (action.desk !== "STORE" || action.action !== "store_alert") return false;
  const template = String(action.params.template ?? "");
  const recent = await prisma.agentAction.findMany({
    where: { orderId, action: "store_alert", outcome: { in: ["EXECUTED", "RECORDED", "REVIEW"] }, createdAt: { gte: new Date(now.getTime() - 2 * 3_600_000) }, params: { path: ["template"], equals: template } },
    select: { params: true }, take: 20,
  }).catch(() => []);
  if (!recent.length) return false;
  if (template !== "STORE_LAB_PROMISE" && template !== "STORE_LAB_RESCHEDULED") return true;
  const said = (x: Record<string, unknown>) => String(x.detail ?? x.text ?? "").trim().toLowerCase();
  return recent.some((r) => said(r.params as Record<string, unknown>) === said(action.params));
}

/** Wake one journey. The sweep passes shared context to save reads. */
export async function wakeJourney(orderId: number, reason: WakeReason, opts: WakeContext = {}): Promise<WakeResult> {
  const now = opts.now ?? new Date();
  const empty = (skipped: string): WakeResult => ({ orderId, opened: false, closed: false, events: 0, actions: 0, executed: 0, review: 0, skipped });
  const row = await prisma.agentJourney.findUnique({ where: { orderId }, include: { checkpoints: true } });
  if (row?.closedAt) return { ...empty("journey closed"), closed: true };

  // Read the order now, not from the job: a queued wake carries the snapshot of when it was
  // queued, and a backlog made the agent act on 20-minute-old statuses (26 Oct 2026: a
  // reminder at 8:16 for an order LabStack marked collected at 7:56).
  let order = (await fetchOrderSnapshot(orderId).catch(() => null)) ?? opts.order ?? null;
  if (!order && row) order = toJourneyState(row).consoleSnapshot;
  if (!order) return empty("order not in the replica");

  const pending = row ? await prisma.agentJourneyEvent.findMany({ where: { journeyId: row.id, applied: false }, orderBy: { at: "asc" } }) : [];
  const events: JourneyEvent[] = pending.map((e) => ({ kind: e.kind, at: e.at, actor: e.actor, payload: (e.payload as Record<string, unknown>) ?? {} }));

  const [sops, directory, guardState] = await Promise.all([opts.sops ?? loadLiveSops(), opts.directory ?? loadDirectory(), opts.guardState ?? loadGuardState()]);
  const labChaseableNow = await labChaseable(order.labId, guardState.desks).catch(() => false);
  const labTier = tierOf(directory, order.labId);
  // A portal rung only makes sense with a logged-in session; otherwise the ask goes to the group.
  const portalReady = order.labId != null && labTier !== "C"
    ? !!(await prisma.agentPortalSession.findUnique({ where: { labId: order.labId }, select: { status: true } }).then((s) => s?.status === "OK").catch(() => false))
    : false;
  const labSop = sops.get("LAB") ?? null;
  const sopParams = paramsFor(labSop, { labTier, labId: order.labId, storeId: order.storeId, orderType: order.orderType });

  // A store asking for slots gets the lab's usual hours (slots.ts); fetched only when asked.
  const slotSummary = events.some((e) => e.kind === "store_message" && (e.payload as { intent?: string }).intent === "slot") && order.labId != null
    ? await typicalSlotsFor(order.labId, order.labName).catch(() => null) : null;
  const out = step({
    now, order, journey: row ? toJourneyState(row) : null, checkpoints: row ? row.checkpoints.map(toCheckpointState) : [], events,
    sop: sopParams, sopVersionId: labSop?.versionId ?? null, labTier, portalReady, slotSummary, labSilentHours: opts.labSilentHours ?? null, timeZone: process.env.TIMEZONE || "Asia/Kolkata", labChaseable: labChaseableNow,
  });
  const j = out.journey;
  const snapshot = j.consoleSnapshot ? { ...j.consoleSnapshot, __journey: { rescheduleCount: j.rescheduleCount } } : null;
  const data = {
    orderType: j.orderType, labId: j.labId, storeId: j.storeId, stage: j.stage, subStates: j.subStates,
    waitingFor: (j.waitingFor ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull, dueAt: j.dueAt, dueSource: j.dueSource, nextCheckAt: j.nextCheckAt,
    health: j.health, riskLevel: j.riskLevel, riskReasons: j.riskReasons, ownerUserId: j.ownerUserId, pausedUntil: j.pausedUntil,
    attempts: j.attempts as Prisma.InputJsonValue, brokenPromises: j.brokenPromises, sopVersionId: j.sopVersionId,
    consoleFingerprint: j.consoleFingerprint, consoleSnapshot: snapshot as unknown as Prisma.InputJsonValue,
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
    const opening: JourneyEvent[] = row ? [] : [{ kind: "opened", at: now, actor: "SYSTEM", payload: { reason, orderStatus: order!.orderStatus, appointmentTime: order!.appointmentTime } }];
    const toWrite = [...opening, ...out.newEvents];
    if (toWrite.length) {
      await tx.agentJourneyEvent.createMany({ data: toWrite.map((e) => ({ journeyId: saved.id, at: e.at, kind: e.kind, actor: e.actor, payload: e.payload as Prisma.InputJsonValue, applied: true })) });
    }
    for (const e of out.newEvents.filter((x) => x.kind === "promise")) {
      const p = e.payload as { kind: string; checkpoint: string; dueAt: Date; text: string; superseded: boolean };
      if (p.superseded) await tx.agentPromise.updateMany({ where: { orderId, status: "OPEN", checkpoint: p.checkpoint }, data: { status: "SUPERSEDED", resolvedAt: now } });
      await tx.agentPromise.create({ data: { orderId, labId: order!.labId, journeyId: saved.id, kind: p.kind, checkpoint: p.checkpoint, dueAt: p.dueAt, text: p.text, status: "OPEN" } });
    }
    for (const e of out.newEvents.filter((x) => x.kind === "promise_broken")) {
      await tx.agentPromise.updateMany({ where: { orderId, status: "OPEN", checkpoint: String((e.payload as { checkpoint: string }).checkpoint) }, data: { status: "BROKEN", resolvedAt: now } });
    }
    for (const c of out.checkpoints.filter((x) => x.status === "MET")) {
      await tx.agentPromise.updateMany({ where: { orderId, status: "OPEN", checkpoint: c.name }, data: { status: "KEPT", resolvedAt: now } });
    }
    if (out.risk && (!row || row.riskLevel !== out.risk.level || reason === "risk_batch")) {
      await tx.agentOrderRisk.create({ data: { journeyId: saved.id, orderId, level: out.risk.level, score: out.risk.score, reasons: out.risk.reasons, predictedDelayMin: out.risk.predictedDelayMin, cannotDoToday: out.risk.cannotDoToday } });
    }
    return saved.id;
  });

  for (const w of out.withdraw) await withdrawOutbox(orderId, w.reason, w.asks, { keepForStore: w.keepForStore }).catch(() => 0);

  let executed = 0; let review = 0;
  // A ladder rung counts as an ask only when it actually went out. In shadow (or
  // blocked) the step still proposes it, but the lab never saw it — the rung must
  // not climb, or a desk switched LIVE later starts at "manager" for asks nobody made.
  const LADDER = new Set(["ask", "reminder", "manager_whatsapp", "call", "create_task", "stuck", "portal_read"]);
  const before = row ? toJourneyState(row).attempts : {};
  const attempts: Record<string, Attempt> = { ...j.attempts };
  let attemptsChanged = false;
  if (out.actions.length) {
    const state = guardState;
    for (const action of out.actions) {
      if (await repeatsRecentAlert(orderId, action, now)) continue;
      const r = await guard(action, {
        journeyId, orderId, labId: j.labId, storeId: j.storeId, labTier, sopVersionId: labSop?.versionId ?? null,
        menus: {
          LAB: sopParams?.menu,
          STORE: paramsFor(sops.get("STORE"), { labTier, labId: order.labId, storeId: order.storeId, orderType: order.orderType })?.menu,
          INTAKE: paramsFor(sops.get("INTAKE"), { labTier, labId: order.labId, storeId: order.storeId, orderType: order.orderType })?.menu,
        },
        orderType: order.orderType, appointmentTime: order.appointmentTime, patientName: order.patientName, labName: order.labName, storeName: order.storeName,
      }, state);
      if (r.outcome === "EXECUTED") executed += 1; else if (r.outcome === "REVIEW") review += 1;
      const checkpoint = typeof action.params.checkpoint === "string" ? action.params.checkpoint : null;
      if (r.outcome !== "EXECUTED" && action.desk === "LAB" && LADDER.has(action.action) && checkpoint && attempts[checkpoint]) {
        attempts[checkpoint] = { ...attempts[checkpoint], n: before[checkpoint]?.n ?? 0 };
        attemptsChanged = true;
      }
    }
  }
  if (attemptsChanged) await prisma.agentJourney.update({ where: { id: journeyId }, data: { attempts: attempts as Prisma.InputJsonValue } });
  // The case worker (FR-1.6): only when no step fit. Its choice goes through the same guard,
  // where it starts in suggest mode, so a person approves each one until it earns its way up.
  if (out.caseworker && !j.closedAt) {
    try {
      const allowed = [...new Set([...(sopParams?.menu ?? []), ...(paramsFor(sops.get("STORE"), { labTier, labId: order.labId, storeId: order.storeId, orderType: order.orderType })?.menu ?? [])])];
      const proposed = await caseWorker({ ...out.caseworker, orderId }, journeyId, allowed);
      if (proposed) {
        const state = guardState;
        const r = await guard({ ...proposed, params: { ...proposed.params, alwaysSuggest: true } }, {
          journeyId, orderId, labId: j.labId, storeId: j.storeId, labTier, sopVersionId: labSop?.versionId ?? null,
          orderType: order.orderType, appointmentTime: order.appointmentTime, patientName: order.patientName, labName: order.labName, storeName: order.storeName,
        }, state);
        if (r.outcome === "EXECUTED") executed += 1; else if (r.outcome === "REVIEW") review += 1;
      }
    } catch (error) {
      console.warn(`[Agents] case worker for ${orderId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return { orderId, opened: !row, closed: !!j.closedAt, events: out.newEvents.length, actions: out.actions.length, executed, review };
}

/** Record something that happened to an order (a fact, a person's action) and wake it. */
export async function recordJourneyEvent(orderId: number, event: JourneyEvent, wake = true): Promise<boolean> {
  const journey = await prisma.agentJourney.findUnique({ where: { orderId }, select: { id: true, closedAt: true } });
  if (!journey || journey.closedAt) return false;
  await prisma.agentJourneyEvent.create({ data: { journeyId: journey.id, at: event.at, kind: event.kind, actor: event.actor, payload: event.payload as Prisma.InputJsonValue, applied: false } });
  if (wake) await wakeJourney(orderId, "inbound").catch((error) => console.error(`[Agents] wake after ${event.kind} failed:`, error instanceof Error ? error.message : error));
  return true;
}
