/**
 * step(): the order agent (DESIGN.md §4.3).
 *
 * A pure function. It reads the journey as last saved, the console's current
 * snapshot of the order, and the events that arrived since the last wake, and
 * returns what to save and what to do. Nothing in here touches a database, a
 * clock or a network, so the same inputs always give the same outputs, and
 * replay (FR-5.5, FR-14.4) is just running it again over the event log.
 *
 * Phase 0 scope: reconcile with the console (including clock resets), keep
 * checkpoints and health, keep the visible plan, close at a terminal status,
 * and propose the one routine action a breached lab checkpoint calls for —
 * an ask — so the guard has something to record in shadow. SOP steps, the
 * ladder, promises and the case worker come in Phase 1.
 */
import {
  checkpointDefs, offsetsFor, waitingFrom, TERMINAL_STATUSES, PLACEHOLDER_LAB_ID,
  type CheckpointName, type OrderSnapshot, type WaitingFrom,
} from "./policy";

const MIN = 60_000;
/** "At risk" this close to a due time (FR-2.4). */
export const AT_RISK_WINDOW_MIN = 15;
/** How long chasing pauses after a person takes an order over (FR-1.8). */
export const TAKEOVER_PAUSE_MIN = 120;
/** A journey with nothing due soon still re-checks this often. */
const IDLE_CHECK_MIN = 60;

export type Health = "ON_TRACK" | "AT_RISK" | "BREACHED";
export type CheckpointStatus = "PENDING" | "MET" | "BREACHED" | "WAIVED";

export type CheckpointState = {
  name: CheckpointName;
  dueAt: Date;
  dueSource: "POLICY" | "PROMISE" | "RESET";
  metAt: Date | null;
  status: CheckpointStatus;
};

export type PlanItem = { id: string; label: string; state: "DONE" | "NOW" | "NEXT"; at?: Date | null };

export type JourneyState = {
  orderId: number;
  orderType: string;
  labId: number | null;
  storeId: number | null;
  stage: string;
  subStates: string[];
  waitingFor: { what: CheckpointName; from: WaitingFrom } | null;
  dueAt: Date | null;
  dueSource: "POLICY" | "PROMISE" | null;
  nextCheckAt: Date | null;
  health: Health;
  ownerUserId: number | null;
  pausedUntil: Date | null;
  attempts: Record<string, number>;
  brokenPromises: number;
  consoleFingerprint: string | null;
  consoleSnapshot: OrderSnapshot | null;
  plan: PlanItem[];
  closedAt: Date | null;
  closeReason: string | null;
};

export type JourneyEvent = { kind: string; at: Date; actor: string; payload: Record<string, unknown> };

export type ProposedAction = {
  desk: "LAB" | "INTAKE" | "STORE";
  action: "ask" | "wait";
  params: Record<string, unknown>;
  reason: string;
  /** Guards against doing the same thing twice across wakes (DESIGN.md §4.7). */
  idemKey: string;
};

export type StepInput = {
  now: Date;
  order: OrderSnapshot;
  /** null when the journey is being opened on this wake. */
  journey: JourneyState | null;
  checkpoints: CheckpointState[];
  /** Events recorded since the last wake, oldest first. */
  events: JourneyEvent[];
};

export type StepOutput = {
  journey: JourneyState;
  checkpoints: CheckpointState[];
  /** Events the step itself produced (console changes, resets, closes). */
  newEvents: JourneyEvent[];
  actions: ProposedAction[];
};

// ── Console snapshot ──────────────────────────────────────────────────────

const ts = (d: Date | null | undefined) => (d ? d.getTime() : 0);

/** What a change in any of these means for the journey (FR-2.7 to 2.14). */
export function fingerprint(o: OrderSnapshot): string {
  return [o.orderStatus, ts(o.appointmentTime), o.labId ?? "", o.orderType, o.phleboName.trim(), ts(o.statusUpdatedAt)].join("|");
}

export type ConsoleChange = "OPENED" | "CANCELLED" | "RESCHEDULED" | "REROUTED" | "TYPE_CHANGED" | "PATIENT_MISSED" | "STATUS_PROGRESS" | "PHLEBO_NAMED" | "OTHER";

export function classifyChange(before: OrderSnapshot | null, after: OrderSnapshot): ConsoleChange[] {
  if (!before) return ["OPENED"];
  const changes: ConsoleChange[] = [];
  if (TERMINAL_STATUSES.has(after.orderStatus) && after.orderStatus !== "REPORT_DELIVERED") changes.push("CANCELLED");
  if (ts(before.appointmentTime) !== ts(after.appointmentTime)) changes.push("RESCHEDULED");
  if (before.labId !== after.labId) changes.push("REROUTED");
  if (before.orderType !== after.orderType) changes.push("TYPE_CHANGED");
  if (after.orderStatus === "PATIENT_MISSED" && before.orderStatus !== "PATIENT_MISSED") changes.push("PATIENT_MISSED");
  if (before.orderStatus !== after.orderStatus && !changes.includes("CANCELLED") && !changes.includes("PATIENT_MISSED")) changes.push("STATUS_PROGRESS");
  if (!before.phleboName.trim() && after.phleboName.trim()) changes.push("PHLEBO_NAMED");
  if (changes.length === 0) changes.push("OTHER");
  return changes;
}

// ── Checkpoints ───────────────────────────────────────────────────────────

/** The full checkpoint set for this order from policy, keeping what is already met. */
function buildCheckpoints(order: OrderSnapshot, existing: CheckpointState[], now: Date, opts: { recomputePreCollection: boolean; rebuildAll: boolean }): CheckpointState[] {
  const offsets = offsetsFor(order.labId);
  const byName = new Map(existing.map((c) => [c.name, c]));
  const out: CheckpointState[] = [];
  for (const def of checkpointDefs(order.orderType)) {
    const due = def.dueAt(order, offsets);
    const prior = opts.rebuildAll ? undefined : byName.get(def.name);
    const isMet = def.met(order);
    if (prior?.status === "MET") { out.push(prior); continue; }
    if (!due) {
      if (isMet) out.push({ name: def.name, dueAt: now, dueSource: "POLICY", metAt: now, status: "MET" });
      continue;
    }
    const recompute = !prior || (opts.recomputePreCollection && def.preCollection) || prior.dueSource === "POLICY";
    const dueAt = recompute ? due : prior.dueAt;
    const dueSource: CheckpointState["dueSource"] = prior && opts.recomputePreCollection && def.preCollection ? "RESET" : prior?.dueSource ?? "POLICY";
    if (isMet) {
      // Met: at the console's own time when its status is exactly this stage, else when we saw it.
      const metAt = order.statusUpdatedAt && order.statusUpdatedAt.getTime() <= now.getTime() ? order.statusUpdatedAt : now;
      out.push({ name: def.name, dueAt, dueSource, metAt, status: "MET" });
      continue;
    }
    out.push({ name: def.name, dueAt, dueSource, metAt: null, status: now.getTime() > dueAt.getTime() ? "BREACHED" : "PENDING" });
  }
  return out;
}

/** Earlier checkpoints a later met one implies are done, without their own console signal. */
function waiveImplied(checkpoints: CheckpointState[]): CheckpointState[] {
  const lastMet = checkpoints.map((c, i) => (c.status === "MET" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  return checkpoints.map((c, i) => (i < lastMet && c.status !== "MET" ? { ...c, status: "WAIVED" } : c));
}

function healthOf(next: CheckpointState | undefined, now: Date): Health {
  if (!next) return "ON_TRACK";
  if (now.getTime() > next.dueAt.getTime()) return "BREACHED";
  if (next.dueAt.getTime() - now.getTime() <= AT_RISK_WINDOW_MIN * MIN) return "AT_RISK";
  return "ON_TRACK";
}

const LABELS: Record<CheckpointName, string> = {
  confirmed: "Lab confirms the order", phlebo_assigned: "Phlebo assigned", phlebo_reached: "Phlebo reaches the patient",
  sample_collected: "Sample collected", sample_at_lab: "Sample reaches the lab", report_delivered: "Report delivered",
  visit_confirmed: "Visit confirmed", patient_visited: "Patient visits the centre",
  kit_dispatched: "Kit dispatched", kit_delivered: "Kit delivered", kit_picked_up: "Kit picked up", samples_received: "Samples received at the lab",
};

function planOf(checkpoints: CheckpointState[], now: Date): PlanItem[] {
  let nowSeen = false;
  return checkpoints.filter((c) => c.status !== "WAIVED").map((c) => {
    if (c.status === "MET") return { id: c.name, label: LABELS[c.name], state: "DONE" as const, at: c.metAt };
    const state = nowSeen ? "NEXT" : "NOW";
    nowSeen = true;
    const late = now.getTime() > c.dueAt.getTime();
    return { id: c.name, label: late ? `${LABELS[c.name]} — overdue` : LABELS[c.name], state, at: c.dueAt };
  });
}

// ── The step ──────────────────────────────────────────────────────────────

export function step(input: StepInput): StepOutput {
  const { now, order, events } = input;
  const newEvents: JourneyEvent[] = [];
  const actions: ProposedAction[] = [];
  const before = input.journey?.consoleSnapshot ?? null;
  const fp = fingerprint(order);

  const base: JourneyState = input.journey ?? {
    orderId: order.id, orderType: order.orderType, labId: order.labId, storeId: order.storeId,
    stage: order.orderStatus, subStates: [], waitingFor: null, dueAt: null, dueSource: null, nextCheckAt: null,
    health: "ON_TRACK", ownerUserId: null, pausedUntil: null, attempts: {}, brokenPromises: 0,
    consoleFingerprint: null, consoleSnapshot: null, plan: [], closedAt: null, closeReason: null,
  };
  let journey: JourneyState = { ...base, orderType: order.orderType, labId: order.labId, storeId: order.storeId, stage: order.orderStatus };
  let checkpoints = input.checkpoints;

  // 1. Reconcile with the console (FR-2.7 to 2.15).
  const changed = fp !== journey.consoleFingerprint;
  const changes = changed ? classifyChange(before, order) : [];
  if (changed) {
    const resets = changes.includes("RESCHEDULED") || changes.includes("REROUTED");
    const rebuild = changes.includes("TYPE_CHANGED");
    const oldDue = Object.fromEntries(checkpoints.map((c) => [c.name, c.dueAt.toISOString()]));
    checkpoints = waiveImplied(buildCheckpoints(order, checkpoints, now, { recomputePreCollection: resets, rebuildAll: rebuild }));
    if (resets || rebuild) {
      // Ask attempts start again for the new slot or lab (FR-2.7, 2.9).
      journey = { ...journey, attempts: {}, subStates: journey.subStates.filter((s) => s !== "change_pending") };
    }
    newEvents.push({
      kind: "console_change", at: now, actor: "CONSOLE",
      payload: {
        changes, from: before ? { status: before.orderStatus, appointmentTime: before.appointmentTime, labId: before.labId } : null,
        to: { status: order.orderStatus, appointmentTime: order.appointmentTime, labId: order.labId },
        ...(resets || rebuild ? { dueBefore: oldDue, dueAfter: Object.fromEntries(checkpoints.map((c) => [c.name, c.dueAt.toISOString()])) } : {}),
      },
    });
    journey = { ...journey, consoleFingerprint: fp, consoleSnapshot: order };
  } else {
    checkpoints = waiveImplied(buildCheckpoints(order, checkpoints, now, { recomputePreCollection: false, rebuildAll: false }));
  }

  // 2. Terminal: stop everything (FR-1.9, FR-2.8).
  if (TERMINAL_STATUSES.has(order.orderStatus)) {
    const reason = order.orderStatus === "REPORT_DELIVERED" ? "REPORT_DELIVERED" : "CANCELLED";
    if (!journey.closedAt) newEvents.push({ kind: "closed", at: now, actor: "SYSTEM", payload: { reason } });
    return {
      journey: { ...journey, closedAt: journey.closedAt ?? now, closeReason: reason, waitingFor: null, dueAt: null, dueSource: null, nextCheckAt: null, health: "ON_TRACK", plan: planOf(checkpoints, now) },
      checkpoints, newEvents, actions,
    };
  }

  // 3. Events from people, labs and stores (Phase 0: take over and hand back only).
  for (const ev of events) {
    if (ev.kind === "takeover") {
      const userId = Number(ev.payload.userId);
      journey = { ...journey, ownerUserId: Number.isFinite(userId) ? userId : journey.ownerUserId, pausedUntil: new Date(ev.at.getTime() + TAKEOVER_PAUSE_MIN * MIN) };
    } else if (ev.kind === "handback") {
      journey = { ...journey, ownerUserId: null, pausedUntil: null };
    } else if (ev.kind === "person_action") {
      if (journey.ownerUserId != null) journey = { ...journey, pausedUntil: new Date(ev.at.getTime() + TAKEOVER_PAUSE_MIN * MIN) };
    }
  }
  if (journey.pausedUntil && journey.pausedUntil.getTime() <= now.getTime()) journey = { ...journey, ownerUserId: null, pausedUntil: null };

  // 4. Where the order is and what it waits for.
  if (order.orderStatus === "PATIENT_MISSED" && !journey.subStates.includes("patient_missed")) {
    journey = { ...journey, subStates: [...journey.subStates, "patient_missed"] };
  }
  const next = checkpoints.find((c) => c.status === "PENDING" || c.status === "BREACHED");
  const defs = checkpointDefs(order.orderType);
  const nextDef = next ? defs.find((d) => d.name === next.name) : undefined;
  const from: WaitingFrom = order.orderStatus === "PATIENT_MISSED" ? "OPS" : nextDef ? waitingFrom(nextDef, order) : "LAB";
  const health = healthOf(next, now);
  const plan = planOf(checkpoints, now);

  // 5. Next check: just before the next due time, at it, or an idle re-check.
  const candidates = [now.getTime() + IDLE_CHECK_MIN * MIN];
  if (next) {
    const atRisk = next.dueAt.getTime() - AT_RISK_WINDOW_MIN * MIN;
    if (atRisk > now.getTime()) candidates.push(atRisk);
    if (next.dueAt.getTime() > now.getTime()) candidates.push(next.dueAt.getTime());
  }
  if (journey.pausedUntil && journey.pausedUntil.getTime() > now.getTime()) candidates.push(journey.pausedUntil.getTime());
  const nextCheckAt = new Date(Math.min(...candidates));

  journey = {
    ...journey,
    waitingFor: next ? { what: next.name, from } : null,
    dueAt: next?.dueAt ?? null, dueSource: next ? "POLICY" : null,
    nextCheckAt, health, plan,
  };

  // 6. Routine action (Phase 0): a breached checkpoint the lab owns gets one ask per rung.
  //    Taken-over orders only observe (FR-1.8).
  const taken = journey.ownerUserId != null && journey.pausedUntil != null && journey.pausedUntil.getTime() > now.getTime();
  if (next && health === "BREACHED" && !taken) {
    const attempt = (journey.attempts[next.name] ?? 0) + 1;
    if (from === "LAB" && attempt === 1) {
      actions.push({
        desk: "LAB", action: "ask",
        params: { checkpoint: next.name, labId: order.labId, orderId: order.id, attempt, dueAt: next.dueAt },
        reason: `${LABELS[next.name]} was due ${Math.round((now.getTime() - next.dueAt.getTime()) / MIN)} min ago and the console shows ${order.orderStatus}`,
        idemKey: `ask:${order.id}:${next.name}:${next.dueAt.getTime()}:${attempt}`,
      });
      journey = { ...journey, attempts: { ...journey.attempts, [next.name]: attempt } };
    } else if (from === "OPS" && order.labId === PLACEHOLDER_LAB_ID && attempt === 1) {
      actions.push({
        desk: "INTAKE", action: "ask",
        params: { checkpoint: next.name, orderId: order.id, attempt, needs: "a real lab" },
        reason: "The order is still on the placeholder lab",
        idemKey: `route:${order.id}:${next.dueAt.getTime()}`,
      });
      journey = { ...journey, attempts: { ...journey.attempts, [next.name]: attempt } };
    }
  }

  return { journey, checkpoints, newEvents, actions };
}
