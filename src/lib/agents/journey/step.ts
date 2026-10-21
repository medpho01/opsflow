/**
 * step(): the order agent (DESIGN.md §4.3).
 *
 * A pure function. It reads the journey as last saved, the console's current
 * snapshot of the order, the SOP that applies, and the events that arrived
 * since the last wake, and returns what to save and what to do. Nothing in
 * here touches a database, a clock or a network, so the same inputs always
 * give the same outputs, and replay (FR-5.5, FR-14.4) is just running it
 * again over the event log with another SOP version.
 *
 * In order: reconcile with the console (clock resets), close at a terminal
 * status, apply people's and labs' events (facts, promises, take-overs),
 * keep checkpoints, health and the visible plan, propose status writes where
 * the evidence bar is met, run the SOP's ladder for the checkpoint the order
 * waits on, run hand-offs, score risk, and set the next check.
 */
import {
  checkpointDefs, offsetsFor, waitingFrom, TERMINAL_STATUSES, PLACEHOLDER_LAB_ID,
  type CheckpointName, type OrderSnapshot, type WaitingFrom,
} from "./policy";
import { FACT_TO_CHECKPOINT, parsePromiseTime } from "./promises";
import { scoreRisk, type RiskLevel } from "./risk";
import type { SopParams, ActionName, Rung } from "../sop/schema";
import type { LabTier } from "../directory";

const MIN = 60_000;
const H = 60 * MIN;
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

/** Per checkpoint: how many rungs ran, when the last one ran, when the lab last answered. */
export type Attempt = { n: number; at: string | null; answeredAt?: string | null; promiseDue?: string | null; promiseText?: string | null };

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
  riskLevel: RiskLevel;
  riskReasons: string[];
  ownerUserId: number | null;
  pausedUntil: Date | null;
  attempts: Record<string, Attempt>;
  brokenPromises: number;
  rescheduleCount: number;
  consoleFingerprint: string | null;
  consoleSnapshot: OrderSnapshot | null;
  plan: PlanItem[];
  sopVersionId: string | null;
  closedAt: Date | null;
  closeReason: string | null;
};

export type JourneyEvent = { kind: string; at: Date; actor: string; payload: Record<string, unknown> };

export type ProposedAction = {
  desk: "LAB" | "INTAKE" | "STORE";
  action: ActionName;
  params: Record<string, unknown>;
  reason: string;
  evidenceIds?: string[];
  confidence?: number;
  /** Guards against doing the same thing twice across wakes (DESIGN.md §4.7). */
  idemKey: string;
};

export type StepInput = {
  now: Date;
  order: OrderSnapshot;
  journey: JourneyState | null;
  checkpoints: CheckpointState[];
  /** Events recorded since the last wake, oldest first. */
  events: JourneyEvent[];
  /** The Lab desk SOP's parameters for this order (null: desk has no SOP yet → Phase 0 behaviour). */
  sop: SopParams | null;
  sopVersionId?: string | null;
  labTier?: LabTier | null;
  /** Hours since the lab's group last wrote, for risk; null when unknown. */
  labSilentHours?: number | null;
  timeZone?: string;
};

export type StepOutput = {
  journey: JourneyState;
  checkpoints: CheckpointState[];
  newEvents: JourneyEvent[];
  actions: ProposedAction[];
  /** Asks to withdraw from the outbox (reschedule, cancel, answered). */
  withdraw: Array<{ asks?: string[]; reason: string }>;
  risk: ReturnType<typeof scoreRisk> | null;
};

// ── Console snapshot ──────────────────────────────────────────────────────

const ts = (d: Date | null | undefined) => (d ? d.getTime() : 0);

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
    const keepPromise = prior?.dueSource === "PROMISE" && !(opts.recomputePreCollection && def.preCollection);
    const recompute = !prior || (opts.recomputePreCollection && def.preCollection) || (prior.dueSource === "POLICY");
    const dueAt = keepPromise ? prior!.dueAt : recompute ? due : prior!.dueAt;
    const dueSource: CheckpointState["dueSource"] = keepPromise ? "PROMISE" : prior && opts.recomputePreCollection && def.preCollection ? "RESET" : prior?.dueSource === "RESET" ? "RESET" : "POLICY";
    if (isMet) {
      const metAt = order.statusUpdatedAt && order.statusUpdatedAt.getTime() <= now.getTime() ? order.statusUpdatedAt : now;
      out.push({ name: def.name, dueAt, dueSource, metAt, status: "MET" });
      continue;
    }
    out.push({ name: def.name, dueAt, dueSource, metAt: null, status: now.getTime() > dueAt.getTime() ? "BREACHED" : "PENDING" });
  }
  return out;
}

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

export const LABELS: Record<CheckpointName, string> = {
  confirmed: "Lab confirms the order", phlebo_assigned: "Phlebo assigned", phlebo_reached: "Phlebo reaches the patient",
  sample_collected: "Sample collected", sample_at_lab: "Sample reaches the lab", report_delivered: "Report delivered",
  visit_confirmed: "Visit confirmed", patient_visited: "Patient visits the centre",
  kit_dispatched: "Kit dispatched", kit_delivered: "Kit delivered", kit_picked_up: "Kit picked up", samples_received: "Samples received at the lab",
};

function planOf(checkpoints: CheckpointState[], now: Date, next: CheckpointState | undefined, rung: string | null): PlanItem[] {
  let nowSeen = false;
  return checkpoints.filter((c) => c.status !== "WAIVED").map((c) => {
    if (c.status === "MET") return { id: c.name, label: LABELS[c.name], state: "DONE" as const, at: c.metAt };
    const state = nowSeen ? "NEXT" : "NOW";
    nowSeen = true;
    const late = now.getTime() > c.dueAt.getTime();
    const suffix = c === next && rung ? ` — ${rung.replace("_", " ")}` : late ? " — overdue" : "";
    return { id: c.name, label: `${LABELS[c.name]}${suffix}`, state, at: c.dueAt };
  });
}

// ── Send windows (DESIGN.md §4.15) ────────────────────────────────────────

function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return (get("hour") % 24) * 60 + get("minute");
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

/** The window an ask about `checkpoint` may go in: from due − lead to due + grace, clipped to working hours for asks not tied to a near slot, and never in the night floor unless urgent. */
export function sendWindow(now: Date, due: Date, sop: SopParams, ask: SopParams["asks"][string], slotTied: boolean, urgent: boolean, timeZone: string): { from: Date; to: Date } {
  let from = new Date(Math.max(now.getTime(), due.getTime() - ask.leadMin * MIN));
  const to = new Date(due.getTime() + ask.graceMin * MIN);
  // Urgent (visit within the ask's urgent window): at once, alone, whatever the hour (FR-6.5).
  if (urgent) return { from: now, to: new Date(Math.max(to.getTime(), now.getTime() + 30 * MIN)) };
  const startOfDay = (d: Date) => new Date(d.getTime() - localMinutes(d, timeZone) * MIN);
  const clip = (start: string, end: string) => {
    const m = localMinutes(from, timeZone);
    const s = hm(start); const e = hm(end);
    if (m < s) from = new Date(startOfDay(from).getTime() + s * MIN);
    else if (m >= e) from = new Date(startOfDay(from).getTime() + (1440 + s) * MIN);
  };
  if (!slotTied) clip(sop.workingHours.start, sop.workingHours.end);
  // Night floor: 22:00–05:00 wraps midnight.
  const m = localMinutes(from, timeZone);
  const fs = hm(sop.nightFloor.start); const fe = hm(sop.nightFloor.end);
  if (fs > fe ? (m >= fs || m < fe) : (m >= fs && m < fe)) {
    from = new Date(startOfDay(from).getTime() + (m >= fs ? 1440 + fe : fe) * MIN);
  }
  return { from, to: new Date(Math.max(to.getTime(), from.getTime() + 30 * MIN)) };
}

// ── The step ──────────────────────────────────────────────────────────────

const RUNG_TO_ACTION: Record<Rung, ActionName> = {
  portal_read: "portal_read", ask: "ask", reminder: "reminder", manager_whatsapp: "manager_whatsapp", call: "call", task: "create_task", stuck: "stuck",
};
const STUCK_TASK: Partial<Record<CheckpointName, string>> = {
  confirmed: "AGENT_COLLECTION_STUCK", visit_confirmed: "AGENT_COLLECTION_STUCK", phlebo_assigned: "AGENT_COLLECTION_STUCK", phlebo_reached: "AGENT_COLLECTION_STUCK",
  sample_collected: "AGENT_COLLECTION_STUCK", sample_at_lab: "AGENT_REPORT_STUCK", report_delivered: "AGENT_REPORT_STUCK",
  patient_visited: "AGENT_COLLECTION_STUCK", samples_received: "AGENT_REPORT_STUCK", kit_dispatched: "AGENT_COLLECTION_STUCK", kit_delivered: "AGENT_COLLECTION_STUCK", kit_picked_up: "AGENT_COLLECTION_STUCK",
};

export function step(input: StepInput): StepOutput {
  const { now, order, events, sop } = input;
  const tz = input.timeZone ?? "Asia/Kolkata";
  const newEvents: JourneyEvent[] = [];
  const actions: ProposedAction[] = [];
  const withdraw: StepOutput["withdraw"] = [];
  const before = input.journey?.consoleSnapshot ?? null;
  const fp = fingerprint(order);

  const base: JourneyState = input.journey ?? {
    orderId: order.id, orderType: order.orderType, labId: order.labId, storeId: order.storeId,
    stage: order.orderStatus, subStates: [], waitingFor: null, dueAt: null, dueSource: null, nextCheckAt: null,
    health: "ON_TRACK", riskLevel: "LOW", riskReasons: [], ownerUserId: null, pausedUntil: null, attempts: {}, brokenPromises: 0, rescheduleCount: 0,
    consoleFingerprint: null, consoleSnapshot: null, plan: [], sopVersionId: null, closedAt: null, closeReason: null,
  };
  let journey: JourneyState = { ...base, orderType: order.orderType, labId: order.labId, storeId: order.storeId, stage: order.orderStatus, sopVersionId: input.sopVersionId ?? base.sopVersionId };
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
      journey = { ...journey, attempts: {}, subStates: journey.subStates.filter((s) => s !== "change_pending"), rescheduleCount: journey.rescheduleCount + (changes.includes("RESCHEDULED") ? 1 : 0) };
      withdraw.push({ reason: changes.includes("REROUTED") ? "re-routed to another lab" : "rescheduled" });
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
    if (!journey.closedAt) { newEvents.push({ kind: "closed", at: now, actor: "SYSTEM", payload: { reason } }); withdraw.push({ reason: reason.toLowerCase() }); }
    return {
      journey: { ...journey, closedAt: journey.closedAt ?? now, closeReason: reason, waitingFor: null, dueAt: null, dueSource: null, nextCheckAt: null, health: "ON_TRACK", plan: planOf(checkpoints, now, undefined, null) },
      checkpoints, newEvents, actions, withdraw, risk: null,
    };
  }

  // 3. Events: people, facts, promises.
  const attempts: Record<string, Attempt> = { ...journey.attempts };
  const factsSeen: Array<{ kind: string; value: string; confidence: number; source: string; named: boolean; id: string | null; at: Date }> = [];
  const storeMessages: Array<{ intent: string; text: string; messageId: string; waMsgId: string | null; at: Date }> = [];
  for (const ev of events) {
    if (ev.kind === "takeover") {
      const userId = Number(ev.payload.userId);
      journey = { ...journey, ownerUserId: Number.isFinite(userId) ? userId : journey.ownerUserId, pausedUntil: new Date(ev.at.getTime() + TAKEOVER_PAUSE_MIN * MIN) };
    } else if (ev.kind === "handback") {
      journey = { ...journey, ownerUserId: null, pausedUntil: null };
    } else if (ev.kind === "person_action") {
      if (journey.ownerUserId != null) journey = { ...journey, pausedUntil: new Date(ev.at.getTime() + TAKEOVER_PAUSE_MIN * MIN) };
    } else if (ev.kind === "fact") {
      const kind = String(ev.payload.kind ?? "");
      const value = String(ev.payload.value ?? "");
      const confidence = Number(ev.payload.confidence ?? 0.6);
      const source = String(ev.payload.source ?? "lab_reply");
      const named = ev.payload.attributedBy !== "ONLY_OPEN";
      factsSeen.push({ kind, value, confidence, source, named, id: (ev.payload.factId as string | null) ?? null, at: ev.at });
      const map = FACT_TO_CHECKPOINT[kind];
      if (map && sop) {
        const cp = checkpoints.find((c) => c.name === map.checkpoint);
        const a = attempts[map.checkpoint] ?? { n: 0, at: null };
        const promiseAt = map.promise === "custom" ? null : parsePromiseTime(value, ev.at, tz) ?? (map.promise === "confirm" ? null : new Date(ev.at.getTime() + sop.defaultPromiseMin * MIN));
        if (cp && cp.status !== "MET" && promiseAt && promiseAt.getTime() > now.getTime() - sop.promiseGraceMin * MIN) {
          const newDue = new Date(promiseAt.getTime() + sop.promiseGraceMin * MIN);
          const superseded = cp.dueSource === "PROMISE";
          checkpoints = checkpoints.map((c) => (c.name === cp.name ? { ...c, dueAt: newDue, dueSource: "PROMISE", status: now.getTime() > newDue.getTime() ? "BREACHED" : "PENDING" } : c));
          attempts[map.checkpoint] = { ...a, answeredAt: ev.at.toISOString(), promiseDue: promiseAt.toISOString(), promiseText: value.slice(0, 120) };
          newEvents.push({ kind: "promise", at: ev.at, actor: "LAB", payload: { kind: map.promise, checkpoint: map.checkpoint, dueAt: promiseAt, text: value.slice(0, 200), superseded } });
          withdraw.push({ asks: undefined, reason: `lab promised ${map.checkpoint} by ${promiseAt.toISOString()}` });
        } else {
          attempts[map.checkpoint] = { ...a, answeredAt: ev.at.toISOString() };
        }
      }
    } else if (ev.kind === "store_message") {
      storeMessages.push({ intent: String(ev.payload.intent ?? "other"), text: String(ev.payload.text ?? ""), messageId: String(ev.payload.messageId ?? ""), waMsgId: (ev.payload.waMsgId as string | null) ?? null, at: ev.at });
    }
  }
  if (journey.pausedUntil && journey.pausedUntil.getTime() <= now.getTime()) journey = { ...journey, ownerUserId: null, pausedUntil: null };

  // Promises that passed unmet are broken (FR-2.3); the policy due returns and the ladder continues.
  let brokenPromises = journey.brokenPromises;
  checkpoints = checkpoints.map((c) => {
    const a = attempts[c.name];
    if (c.dueSource !== "PROMISE" || c.status === "MET" || !a?.promiseDue) return c;
    if (now.getTime() <= c.dueAt.getTime()) return c;
    brokenPromises += 1;
    newEvents.push({ kind: "promise_broken", at: now, actor: "SYSTEM", payload: { checkpoint: c.name, promisedAt: a.promiseDue, text: a.promiseText ?? null, total: brokenPromises } });
    attempts[c.name] = { ...a, promiseDue: null, promiseText: null, answeredAt: null };
    return { ...c, dueSource: "RESET", status: "BREACHED" };
  });
  journey = { ...journey, attempts, brokenPromises };

  // 4. Where the order is and what it waits for.
  if (order.orderStatus === "PATIENT_MISSED" && !journey.subStates.includes("patient_missed")) journey = { ...journey, subStates: [...journey.subStates, "patient_missed"] };
  const next = checkpoints.find((c) => c.status === "PENDING" || c.status === "BREACHED");
  const defs = checkpointDefs(order.orderType);
  const nextDef = next ? defs.find((d) => d.name === next.name) : undefined;
  const from: WaitingFrom = order.orderStatus === "PATIENT_MISSED" ? "OPS" : nextDef ? waitingFrom(nextDef, order) : "LAB";
  const health = healthOf(next, now);
  const taken = journey.ownerUserId != null && journey.pausedUntil != null && journey.pausedUntil.getTime() > now.getTime();
  const slot = order.appointmentTime;
  const minutesToSlot = slot ? (slot.getTime() - now.getTime()) / MIN : null;

  // 5. Status writes from evidence (FR-3.2): a fact that meets the bar for an allowed transition the console has not reached.
  if (sop && !taken) {
    for (const f of factsSeen) {
      const handoff = sop.handoffs.find((h) => h.onFact === f.kind && h.do === "status_write");
      const transition = handoff?.transition;
      if (!transition) continue;
      const bar = sop.evidenceBar[transition];
      if (!bar || !bar.sources.includes(f.source)) continue;
      const alreadyThere = (transition === "SAMPLE_COLLECTED" && checkpoints.find((c) => c.name === "sample_collected")?.status === "MET")
        || (transition === "SAMPLE_DELIVERED" && checkpoints.find((c) => c.name === "sample_at_lab")?.status === "MET");
      if (alreadyThere) continue;
      const meets = f.confidence >= bar.minConfidence && (!bar.needsOrderNamed || f.named);
      actions.push({
        desk: "LAB", action: "status_write",
        params: { to: transition, orderId: order.id, evidence: { kind: f.kind, source: f.source, value: f.value, confidence: f.confidence, factId: f.id, at: f.at }, meetsBar: meets, alwaysSuggest: bar.alwaysSuggest },
        reason: meets ? `${f.source.replace("_", " ")} says "${f.value.slice(0, 60)}" at ${f.confidence.toFixed(2)} confidence (bar ${bar.minConfidence})`
          : `${f.source.replace("_", " ")} says "${f.value.slice(0, 60)}" but ${f.confidence < bar.minConfidence ? `confidence ${f.confidence.toFixed(2)} is below the bar ${bar.minConfidence}` : "the order was not named"}`,
        evidenceIds: f.id ? [f.id] : [], confidence: f.confidence,
        idemKey: `write:${order.id}:${transition}:${f.id ?? f.at.getTime()}`,
      });
    }
    // Other hand-offs (FR-8.9, FR-11): a lab-raised problem starts a store alert or a task.
    for (const f of factsSeen) {
      for (const h of sop.handoffs.filter((x) => x.onFact === f.kind && x.do !== "status_write")) {
        const key = `${h.do}:${order.id}:${f.kind}:${f.id ?? f.at.getTime()}`;
        if (h.do === "store_alert") {
          actions.push({ desk: "STORE", action: "store_alert", params: { template: h.template ?? "STORE_PATIENT_UNREACHABLE", orderId: order.id, storeId: order.storeId, fact: f.kind, text: f.value.slice(0, 200), at: f.at }, reason: `lab says ${f.kind.replace("_", " ")}: "${f.value.slice(0, 60)}"`, evidenceIds: f.id ? [f.id] : [], idemKey: key });
        } else if (h.do === "create_task") {
          actions.push({ desk: "LAB", action: "create_task", params: { taskType: h.taskType ?? "AGENT_CONSOLE_UPDATE", orderId: order.id, cause: f.kind.toUpperCase(), evidence: [{ kind: f.source, at: f.at.toISOString(), text: f.value.slice(0, 200) }], action: h.taskType === "AGENT_REPORT_UPLOAD" ? "Check the lab's portal and upload the report to the console" : `Act on the lab's message: "${f.value.slice(0, 120)}"` }, reason: `lab says ${f.kind.replace("_", " ")}`, evidenceIds: f.id ? [f.id] : [], idemKey: key });
        }
      }
    }
  }

  // 5b. The Store desk (FR-9.3 to 9.6): every store message ends in an answer, a chase, or a task.
  if (!taken && order.storeId != null) {
    for (const m of storeMessages) {
      const key = `store:${order.id}:${m.messageId}`;
      const collected = checkpoints.find((c) => c.name === "sample_collected" || c.name === "patient_visited");
      const report = checkpoints.find((c) => c.name === "report_delivered");
      const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "");
      const fmtDay = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
      const known = (() => {
        if (order.orderStatus === "REPORT_DELIVERED") return { statusLine: "report delivered.", nextLine: "" };
        if (order.orderStatus === "PATIENT_MISSED") return { statusLine: "the lab marked the patient as missed.", nextLine: "Please share a new slot." };
        if (collected?.status === "MET") return { statusLine: `sample collected ${fmt(collected.metAt)}.`, nextLine: report ? `Report expected by ${fmtDay(report.dueAt)}.` : "" };
        if (order.phleboName.trim()) return { statusLine: `phlebo ${order.phleboName.trim()} assigned for ${fmtDay(slot)}.`, nextLine: "" };
        if (checkpoints.find((c) => c.name === "confirmed")?.status === "MET") return { statusLine: `confirmed by the lab for ${fmtDay(slot)}.`, nextLine: "" };
        return null;
      })();
      const quote = m.waMsgId ? { quotedWaId: m.waMsgId } : {};
      switch (m.intent) {
        case "status": case "slot": case "report": {
          const slotPassed = slot != null && now.getTime() > slot.getTime() + 30 * MIN;
          const canAnswer = known && !(m.intent === "report" && collected?.status === "MET" && report && report.status !== "MET" && now.getTime() > report.dueAt.getTime()) && !(m.intent !== "report" && slotPassed && collected?.status !== "MET");
          if (canAnswer) {
            actions.push({ desk: "STORE", action: "store_reply", params: { template: "STORE_STATUS_ANSWER", orderId: order.id, storeId: order.storeId, ...known, ...quote }, reason: `store asked for ${m.intent}; the console knows`, idemKey: `${key}:answer` });
          } else {
            actions.push({ desk: "STORE", action: "store_reply", params: { template: "STORE_CHECKING", orderId: order.id, storeId: order.storeId, ...quote }, reason: `store asked for ${m.intent}; the console does not know yet`, idemKey: `${key}:checking` });
            if (next && sop && from === "LAB" && sop.asks[next.name]) {
              const ask = sop.asks[next.name];
              const urgent = slotPassed || (minutesToSlot != null && minutesToSlot <= ask.urgentWithinMin);
              const window = sendWindow(now, now, sop, { ...ask, leadMin: 0, graceMin: 240 }, true, urgent, tz);
              actions.push({ desk: "LAB", action: "ask", params: { checkpoint: next.name, orderId: order.id, labId: order.labId, attempt: (attempts[next.name]?.n ?? 0) + 1, dueAt: next.dueAt, rung: "ask", intent: ask.intent, counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, phlebo: order.phleboName || null }, forStore: true }, reason: `store asked about #${order.id} and the console does not know`, idemKey: `${key}:chase` });
            }
          }
          break;
        }
        case "reschedule": case "cancel": case "change_tests": {
          const taskType = m.intent === "reschedule" ? "AGENT_RESCHEDULE" : m.intent === "cancel" ? "AGENT_CANCEL" : "AGENT_ORDER_CHANGE";
          const requested = parsePromiseTime(m.text, m.at, tz);
          actions.push({ desk: "STORE", action: "ack", params: { template: "STORE_NOTED", orderId: order.id, storeId: order.storeId, ...quote }, reason: `store asked to ${m.intent.replace("_", " ")}`, idemKey: `${key}:noted` });
          actions.push({ desk: "STORE", action: "create_task", params: { taskType, orderId: order.id, cause: `STORE_${m.intent.toUpperCase()}`, evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: m.intent === "reschedule" ? `Reschedule #${order.id}${requested ? ` to ${fmtDay(requested)}` : " as the store asked"} in the console` : m.intent === "cancel" ? `Cancel #${order.id} in the console` : `Change #${order.id}'s tests as the store asked, then tell the lab`, verify: m.intent === "reschedule" ? (requested ? { kind: "slot_equals", value: requested.toISOString() } : { kind: "none" }) : m.intent === "cancel" ? { kind: "status_at_least", value: "CANCELED" } : { kind: "none" }, dueInMinutes: 30 }, reason: `store asked to ${m.intent.replace("_", " ")}: "${m.text.slice(0, 80)}"`, idemKey: `${key}:task` });
          if (!journey.subStates.includes("change_pending")) journey = { ...journey, subStates: [...journey.subStates, "change_pending"] };
          break;
        }
        case "complaint":
          actions.push({ desk: "STORE", action: "create_task", params: { taskType: "AGENT_COMPLAINT", orderId: order.id, cause: "STORE_COMPLAINT", evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: `Reply to the store's complaint about #${order.id}; the timeline and a draft are on the task`, draft: true, dueInMinutes: 120 }, reason: "store complained", idemKey: `${key}:complaint` });
          break;
        case "serviceability":
          actions.push({ desk: "STORE", action: "create_task", params: { taskType: "AGENT_SERVICEABILITY", orderId: order.id, cause: "SERVICEABILITY", evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: `Check serviceability for the store's request on #${order.id}` }, reason: "store asked about serviceability", idemKey: `${key}:network` });
          break;
        case "new_booking":
          actions.push({ desk: "STORE", action: "create_task", params: { taskType: "AGENT_NEW_BOOKING", orderId: order.id, cause: "NEW_BOOKING", evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: "Create the booking the store asked for" }, reason: "store asked for a booking", idemKey: `${key}:booking` });
          break;
        default: break;
      }
    }
  }

  // 6. The ladder for the checkpoint the order waits on (FR-8.7).
  let rungLabel: string | null = null;
  if (sop && next && !taken) {
    const ask = sop.asks[next.name];
    const a = attempts[next.name] ?? { n: 0, at: null };
    const nightBefore = ask?.nightBefore && (journey.riskLevel !== "LOW") && minutesToSlot != null && minutesToSlot > 10 * 60 && minutesToSlot < 20 * 60 && localMinutes(now, tz) >= hm("18:00");
    const due = next.dueAt;
    const started = now.getTime() >= due.getTime() - (ask?.leadMin ?? 0) * MIN || nightBefore;
    const lastAt = a.at ? Date.parse(a.at) : null;
    const gapOk = lastAt == null || now.getTime() - lastAt >= sop.rungGapMin * MIN;
    const answeredAt = a.answeredAt ? Date.parse(a.answeredAt) : null;
    const holding = answeredAt != null && now.getTime() - answeredAt < sop.answerHoldMin * MIN && next.dueSource !== "RESET";
    const ladder = sop.ladder;
    if (from === "LAB" && ask && started && gapOk && !holding) {
      let rungIndex = a.n;
      if (brokenPromises >= sop.brokenPromisesSkip && rungIndex > 0 && rungIndex < ladder.length - 1) rungIndex += 1;
      const rung = ladder[Math.min(rungIndex, ladder.length - 1)];
      rungLabel = rung;
      const urgent = minutesToSlot != null && minutesToSlot >= 0 && minutesToSlot <= ask.urgentWithinMin;
      const window = sendWindow(now, due, sop, ask, minutesToSlot != null && Math.abs(minutesToSlot) <= 180, urgent, tz);
      const common = { checkpoint: next.name, orderId: order.id, labId: order.labId, attempt: rungIndex + 1, dueAt: due, rung };
      const overdue = Math.round((now.getTime() - due.getTime()) / MIN);
      const why = overdue >= 0 ? `${LABELS[next.name]} was due ${overdue} min ago; the console shows ${order.orderStatus}` : `${LABELS[next.name]} is due in ${-overdue} min; asked ${nightBefore ? "the evening before (risk)" : "ahead"}`;
      const idem = `${rung}:${order.id}:${next.name}:${due.getTime()}:${rungIndex + 1}`;
      const isTerminalRung = rungIndex >= ladder.length - 1 && (rung === "stuck" || rung === "task");
      if (isTerminalRung && a.n >= ladder.length) {
        // Already at the top: nothing more to do until the console or a person moves it.
      } else {
        switch (rung) {
          case "portal_read": actions.push({ desk: "LAB", action: "portal_read", params: { ...common }, reason: why, idemKey: idem }); break;
          case "ask": case "reminder":
            actions.push({ desk: "LAB", action: rung, params: { ...common, intent: ask.intent, counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, phlebo: order.phleboName || null } }, reason: why, idemKey: idem });
            break;
          case "manager_whatsapp":
            actions.push({ desk: "LAB", action: "manager_whatsapp", params: { ...common, intent: "ESCALATION", counterparty: `MANAGER:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime } }, reason: `${why}; ${a.n} asks unanswered`, idemKey: idem });
            break;
          case "call":
            actions.push({ desk: "LAB", action: "call", params: { ...common, labId: order.labId }, reason: `${why}; ${a.n} asks unanswered`, idemKey: idem });
            break;
          case "task":
            actions.push({ desk: "LAB", action: "create_task", params: { ...common, taskType: STUCK_TASK[next.name] ?? "AGENT_COLLECTION_STUCK", cause: `${next.name.toUpperCase()}_STUCK`, evidence: [{ kind: "ladder", at: now.toISOString(), text: `${a.n} asks to the lab unanswered since ${a.at ?? "today"}` }], action: `Decide for #${order.id}: ${LABELS[next.name].toLowerCase()} is stuck at ${order.labName ?? "the lab"}` }, reason: `${why}; the lab did not answer ${a.n} asks`, idemKey: idem });
            break;
          case "stuck":
            actions.push({ desk: "LAB", action: "stuck", params: { ...common }, reason: `${why}; ladder exhausted`, idemKey: idem });
            break;
        }
        attempts[next.name] = { ...a, n: rungIndex + 1, at: now.toISOString() };
        journey = { ...journey, attempts };
      }
    } else if (from === "OPS" && order.labId === PLACEHOLDER_LAB_ID && minutesToSlot != null && minutesToSlot <= 72 * 60 && a.n === 0) {
      actions.push({ desk: "INTAKE", action: "create_task", params: { checkpoint: next.name, orderId: order.id, taskType: "AGENT_FIND_LAB", cause: "PLACEHOLDER_LAB", evidence: [{ kind: "console", text: `on the placeholder lab, slot ${slot?.toISOString() ?? "unknown"}` }], action: `Assign a serviceable lab for #${order.id}` }, reason: "The order is still on the placeholder lab within 72 h of its slot", idemKey: `route:${order.id}:${ts(slot)}` });
      attempts[next.name] = { n: 1, at: now.toISOString() };
      journey = { ...journey, attempts };
    }
  }

  // 7. Risk (FR-16.2) and the early warning to the store (FR-16.4).
  const risk = sop ? scoreRisk({
    now, order, checkpoints, subStates: journey.subStates, rescheduleCount: journey.rescheduleCount,
    labSilentHours: input.labSilentHours ?? null, weights: sop.riskWeights, thresholds: sop.riskThresholds,
  }) : null;
  if (risk) {
    journey = { ...journey, riskLevel: risk.level, riskReasons: risk.reasons };
    const target = checkpoints.find((c) => c.name === "sample_collected" || c.name === "patient_visited" || c.name === "kit_delivered");
    if (sop && !taken && risk.level === "HIGH" && target && target.status !== "MET" && order.storeId != null && minutesToSlot != null && minutesToSlot > sop.warnStoreBeforeMin && minutesToSlot <= 24 * 60) {
      actions.push({
        desk: "STORE", action: "store_warning",
        params: { orderId: order.id, storeId: order.storeId, slot, reasons: risk.reasons, cannotDoToday: risk.cannotDoToday, predictedDelayMin: risk.predictedDelayMin },
        reason: `high risk: ${risk.reasons.join(", ")}`, idemKey: `warn:${order.id}:${ts(slot)}`,
      });
    }
  }

  // 8. Next check.
  const candidates = [now.getTime() + IDLE_CHECK_MIN * MIN];
  if (next) {
    const atRisk = next.dueAt.getTime() - AT_RISK_WINDOW_MIN * MIN;
    if (atRisk > now.getTime()) candidates.push(atRisk);
    if (next.dueAt.getTime() > now.getTime()) candidates.push(next.dueAt.getTime());
    const a = attempts[next.name];
    if (sop && a?.at && now.getTime() > next.dueAt.getTime()) candidates.push(Date.parse(a.at) + sop.rungGapMin * MIN);
    if (sop && a?.answeredAt) candidates.push(Date.parse(a.answeredAt) + sop.answerHoldMin * MIN);
  }
  if (journey.pausedUntil && journey.pausedUntil.getTime() > now.getTime()) candidates.push(journey.pausedUntil.getTime());
  const nextCheckAt = new Date(Math.min(...candidates.filter((c) => c > now.getTime())));

  journey = {
    ...journey,
    waitingFor: next ? { what: next.name, from } : null,
    dueAt: next?.dueAt ?? null, dueSource: next ? (next.dueSource === "PROMISE" ? "PROMISE" : "POLICY") : null,
    nextCheckAt, health, plan: planOf(checkpoints, now, next, rungLabel),
  };
  return { journey, checkpoints, newEvents, actions, withdraw, risk };
}
