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
  checkpointDefs, waitingFrom, TERMINAL_STATUSES, PLACEHOLDER_LAB_ID,
  type CheckpointName, type OrderSnapshot, type WaitingFrom, reached } from "./policy";
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
  /** Is a logged-in portal session set up for this lab? Without one the portal rung is skipped: ask in the group instead. */
  portalReady?: boolean;
  /** When the lab usually collects ("6:00–11:00 am, most at 7–8 am"), for a store asking for slots. */
  slotSummary?: string | null;
  /** Hours since the lab's group last wrote, for risk; null when unknown. */
  labSilentHours?: number | null;
  /** Can the desk chase this lab itself (a connected group with a LIVE lab desk)? Default yes. */
  labChaseable?: boolean;
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
  /** No deterministic step fits: the case worker decides (DESIGN.md §4.6). */
  caseworker: { reason: string; text: string; checkpoint: string | null; factKind?: string | null; intent?: string | null; at: Date } | null;
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

/** Checkpoints an API lab is never asked about: the order reaches it through the API, so "confirm" is not theirs to answer (23 Oct 2026). */
const NOT_FOR_API_LABS = new Set(["confirmed", "visit_confirmed", "sample_at_lab", "samples_received"]);

function buildCheckpoints(order: OrderSnapshot, existing: CheckpointState[], now: Date, opts: { recomputePreCollection: boolean; rebuildAll: boolean; labTier?: LabTier | null; sop?: SopParams | null }): CheckpointState[] {
  const byName = new Map(existing.map((c) => [c.name, c]));
  const out: CheckpointState[] = [];
  for (const def of checkpointDefs(order.orderType)) {
    // When each checkpoint is due is SOP policy (asks.<name>.dueOffsetMin); the policy's default otherwise.
    const due = def.dueAt(order, opts.sop?.asks[def.name]?.dueOffsetMin);
    const prior = opts.rebuildAll ? undefined : byName.get(def.name);
    const isMet = def.met(order);
    if (prior?.status === "MET") { out.push(prior); continue; }
    if (opts.labTier && opts.labTier !== "C" && NOT_FOR_API_LABS.has(def.name) && !isMet) {
      out.push({ name: def.name, dueAt: due ?? now, dueSource: "POLICY", metAt: null, status: "WAIVED" });
      continue;
    }
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
  const startOfDay = (d: Date) => new Date(d.getTime() - localMinutes(d, timeZone) * MIN);
  // Urgent (visit within the ask's urgent window): at once, alone — but never at
  // night. Eight "phlebo needed" messages reached Redcliffe between 03:32 and
  // 05:32 on 25 Oct 2026. A visit before 08:30 is asked about the evening
  // before (20:00); otherwise the ask waits for 07:00.
  if (urgent) {
    const m = localMinutes(now, timeZone);
    if (m >= hm("07:00") && m < hm("21:00")) return { from: now, to: new Date(Math.max(to.getTime(), now.getTime() + 30 * MIN)) };
    const morning = new Date(startOfDay(now).getTime() + (m >= hm("21:00") ? 1440 + hm("07:00") : hm("07:00")) * MIN);
    return { from: morning, to: new Date(Math.max(to.getTime(), morning.getTime() + 30 * MIN)) };
  }
  const clip = (start: string, end: string) => {
    const m = localMinutes(from, timeZone);
    const s = hm(start); const e = hm(end);
    if (m < s) from = new Date(startOfDay(from).getTime() + s * MIN);
    else if (m >= e) from = new Date(startOfDay(from).getTime() + (1440 + s) * MIN);
  };
  if (!slotTied) clip(sop.workingHours.start, sop.workingHours.end);
  // A pre-visit ask whose moment falls in the night, for a visit before 08:30:
  // the evening before at 20:00 (one message), never between 21:00 and 07:00.
  const dueLocal = localMinutes(due, timeZone);
  const fromLocal = localMinutes(from, timeZone);
  if (dueLocal < hm("08:30") && (fromLocal >= hm("21:00") || fromLocal < hm("07:00"))) {
    const eveningBefore = new Date(startOfDay(due).getTime() - 1440 * MIN + hm("20:00") * MIN);
    from = eveningBefore.getTime() >= now.getTime() - 60 * MIN ? new Date(Math.max(eveningBefore.getTime(), now.getTime())) : new Date(startOfDay(due).getTime() + hm("07:00") * MIN);
  }
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
/**
 * Has an API lab's webhook moved this order around its visit? Then LabStack's status is the
 * answer to "phlebo on time? / collected?": updated within 2 h before the visit or any time after.
 * Manual labs (tier C) have no webhook — always ask them.
 */
/** The SOP's default when no SOP is at hand (scripts): an API lab's console counts as answering only while it updated this recently. */
export const CONSOLE_QUIET_MIN = 90;

export function consoleIsLive(order: OrderSnapshot, labTier: LabTier | null | undefined, now: Date, quietMin = CONSOLE_QUIET_MIN): boolean {
  if (!labTier || labTier === "C" || !order.statusUpdatedAt || !order.appointmentTime) return false;
  const from = order.appointmentTime.getTime() - 2 * 3_600_000;
  const updated = order.statusUpdatedAt.getTime();
  // Updated around the visit AND recently: a console that moved at 7:50 and said nothing since
  // is not answering at 10:00 (Orange and Thyrocare got no status asks, 27 Oct 2026). The window
  // is the SOP's consoleQuietMin — the Brain may move it within its bounds.
  return updated >= from && updated <= now.getTime() && now.getTime() - updated <= quietMin * MIN;
}

/** A store reporting that the visit failed, in the SOP's phrases (params.storeExceptionPhrases). */
export function storeExceptionRe(sop: Pick<SopParams, "storeExceptionPhrases"> | null): RegExp | null {
  const phrases = sop?.storeExceptionPhrases?.filter((p) => p.trim()) ?? [];
  if (!phrases.length) return null;
  try { return new RegExp(`\\b(${phrases.join("|")})\\b`, "i"); } catch { return null; }
}

/** What the store reads in a relay: RNR named as such, and the slots the lab offers (Orange, 26 Oct 2026). */
export function relayDetail(f: { kind: string; value: string; fullText?: string }): string {
  if (f.kind !== "patient_unavailable") return f.value.slice(0, 160);
  const text = f.fullText ?? f.value;
  const reason = /\bRNR\b|ring no response|did not (respond|answer)|no response/i.test(text) ? "RNR — the customer did not answer the phlebo's call" : f.value.slice(0, 80);
  const slots = [...new Set([...text.matchAll(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*(?:-|to|–)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))?)/gi)].map((m) => m[1].replace(/\s+/g, " ").toLowerCase()))].slice(0, 6);
  return slots.length ? `${reason}; lab offers ${slots.join(", ")} — reply with the customer's preferred slot` : reason;
}

/** Lab facts the store is told about the moment they land, and the template for each. */
const STORE_RELAY: Record<string, string> = {
  patient_unavailable: "STORE_PATIENT_UNREACHABLE", sample_collected: "STORE_COLLECTED", new_appointment_time: "STORE_LAB_RESCHEDULED",
  cannot_fulfil: "STORE_LAB_CANNOT", report_shared: "STORE_REPORT_SHARED",
};

/**
 * The time a store asked for, if it named one (26 Oct 2026: "reschedule to tomorrow same slot"
 * reached Orange as "10:00 am" — the parser's default for a bare "tomorrow"):
 *  - "same slot" / "same time" is the order's current visit time, on the day asked;
 *  - a day with no time ("tomorrow") is no time at all — never an invented 10 am;
 *  - otherwise the clock time written ("at 10:45 am", "tomorrow 8 am", "at 7").
 */
export function requestedTime(text: string, at: Date, appointment: Date | null, tz: string): Date | null {
  const tomorrow = /\btomorrow\b|\bkal\b|\bnext day\b/i.test(text);
  if (/\bsame (slot|time)\b/i.test(text) && appointment) {
    const clock = appointment.toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    return parsePromiseTime(`${tomorrow ? "tomorrow " : ""}${clock}`, at, tz);
  }
  const hasClock = /\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])|\b\d{1,2}[:.]\d{2}\b|\bat \d{1,2}\b/i.test(text);
  return hasClock ? parsePromiseTime(text, at, tz) : null;
}

/**
 * What the store is told unprompted, made coherent (Plum readiness replay, 26 Oct 2026). Applied
 * to every step's store alerts:
 *  - a sample left behind is not "customer not reachable": it gets the sample-owed wording;
 *  - "age mismatch" and other detail fixes are not "the lab cannot do this one";
 *  - a change the customer made (through the store's own API) is not news to the store;
 *  - a "reschedule" relayed from a lab message needs a concrete new time, not a request
 *    ("please reschedule after 8 am");
 *  - one lab message gives one alert: the strongest of what it said ("collected by 2:38"
 *    + "rescheduled to 28th" → the reschedule), and the same template never twice.
 */
const ALERT_RANK: Record<string, number> = {
  STORE_PATIENT_UNREACHABLE: 5, STORE_SAMPLE_OWED: 5, STORE_LAB_CANNOT: 5, STORE_LAB_DATA_CHECK: 5, STORE_LAB_CANCELLED: 6,
  STORE_LAB_RESCHEDULED: 4, STORE_REPORT_SHARED: 3, STORE_COLLECTED: 2, STORE_LAB_PROMISE: 1,
};
const SAMPLE_LEFT = /\b(urine|stool|sputum|swab)\b[^.\n]{0,40}\b(not|pending|missed|left|skipped)\b|\b(not|pending)\b[^.\n]{0,20}\b(urine|stool|sputum|swab)\b/i;
const DATA_FIX = /\bmismatch\b|\b(wrong|incorrect)\b|\b(age|gender|dob|date of birth)\b/i;
const CUSTOMER_MADE = /customer requested|requested (through|via|by) (the )?(api|customer|user)|cancell?ation/i;
const CONCRETE_TIME = /\d|\b(today|tomorrow|tonight|mon|tue|wed|thu|fri|sat|sun)/i;
const A_REQUEST = /\b(please|kindly|pls|request(ed|s)?|wants?|asks?|asked)\b/i;

export function curateStoreAlerts(actions: ProposedAction[]): ProposedAction[] {
  const out: ProposedAction[] = [];
  const best = new Map<string, number>(); // lab message → index in out
  for (const original of actions) {
    if (original.desk !== "STORE" || original.action !== "store_alert") { out.push(original); continue; }
    const p = { ...original.params };
    const said = `${String(p.detail ?? "")} ${String(p.text ?? "")}`;
    const fact = String(p.fact ?? "");
    if (p.template === "STORE_PATIENT_UNREACHABLE" && SAMPLE_LEFT.test(said)) {
      const sample = /\b(urine|stool|sputum|swab)\b/i.exec(said)?.[1]?.toLowerCase() ?? "a";
      p.template = "STORE_SAMPLE_OWED"; p.detail = `${sample} sample not collected`;
    }
    if (p.template === "STORE_LAB_CANNOT" && DATA_FIX.test(said)) p.template = "STORE_LAB_DATA_CHECK";
    if (fact.startsWith("console_") && CUSTOMER_MADE.test(said)) continue;
    if (p.template === "STORE_LAB_RESCHEDULED" && !fact.startsWith("console_")) {
      const value = String(p.detail ?? p.text ?? "");
      if (A_REQUEST.test(value) || !CONCRETE_TIME.test(value) || CUSTOMER_MADE.test(value)) continue;
    }
    const action = { ...original, params: p };
    const at = p.at instanceof Date ? p.at.toISOString() : String(p.at ?? "");
    const key = fact.startsWith("console_") ? `console:${fact}:${p.template}` : `msg:${at}`;
    const rank = ALERT_RANK[String(p.template)] ?? 0;
    const prior = best.get(key);
    if (prior == null) { best.set(key, out.length); out.push(action); continue; }
    const kept = out[prior];
    if (rank > (ALERT_RANK[String(kept.params.template)] ?? 0)) out[prior] = action;
  }
  return out;
}

const startOfLocalDay = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
const LABELS_TIME = (d: Date, tz: string) => d.toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });

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
  // The store asked for a change that is still pending: a move the console now shows is theirs.
  const storeAskedToMove = journey.subStates.includes("change_pending");
  const requestedMove = journey.subStates.find((s) => s.startsWith("requested:"))?.slice(10) ?? null;
  if (changed) {
    const resets = changes.includes("RESCHEDULED") || changes.includes("REROUTED");
    const rebuild = changes.includes("TYPE_CHANGED");
    const oldDue = Object.fromEntries(checkpoints.map((c) => [c.name, c.dueAt.toISOString()]));
    checkpoints = waiveImplied(buildCheckpoints(order, checkpoints, now, { recomputePreCollection: resets, rebuildAll: rebuild, labTier: input.labTier, sop: input.sop }));
    if (resets || rebuild) {
      journey = { ...journey, attempts: {}, subStates: journey.subStates.filter((s) => s !== "change_pending" && !s.startsWith("requested:")), rescheduleCount: journey.rescheduleCount + (changes.includes("RESCHEDULED") ? 1 : 0) };
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
    // The console already has the answer (an API lab's webhook, 26 Oct 2026): the store hears it
    // from LabStack, no WhatsApp ask needed. Patient missed, or the lab moved the visit.
    const tzc = input.timeZone ?? "Asia/Kolkata";
    const note = order.statusNote ? ` — ${order.statusNote.slice(0, 120)}` : "";
    if (before && order.storeId != null && changes.includes("PATIENT_MISSED")) {
      actions.push({ desk: "STORE", action: "store_alert", params: { template: "STORE_PATIENT_UNREACHABLE", orderId: order.id, storeId: order.storeId, fact: "console_patient_missed", detail: `the lab marked the patient missed${note}`, at: now.toISOString() }, reason: `LabStack: PATIENT_MISSED${note}`, idemKey: `console-missed:${order.id}:${order.statusUpdatedAt?.getTime() ?? now.getTime()}` });
      withdraw.push({ asks: ["ETA", "PHLEBO", "STATUS"], reason: "patient missed (console)" });
    }
    // The lab cancelled (27 Oct 2026: Orange's kit order died as "non-serviceable", Thyrocare
    // cancelled after the sample was taken, and nobody heard until the store escalated). The
    // store is told, with the reason; our ops group is told when the sample was already collected
    // (a new order id is needed) or the area was not serviceable. A cancellation the customer made
    // through the store's own API is theirs: curateStoreAlerts drops that alert.
    if (before && changes.includes("CANCELLED") && !TERMINAL_STATUSES.has(before.orderStatus)) {
      const reason = (order.statusNote ?? "").trim().slice(0, 140);
      const byCustomer = /customer requested|requested (through|via|by) (the )?(api|customer|user)/i.test(reason);
      const collectedBefore = reached(before.orderStatus, "SAMPLE_COLLECTED") || checkpoints.some((c) => c.name === "sample_collected" && c.status === "MET");
      const nsa = /\bNSA\b|non.?serviceable|not serviceable/i.test(reason);
      const idem = `console-cancel:${order.id}:${order.statusUpdatedAt?.getTime() ?? now.getTime()}`;
      if (order.storeId != null) {
        actions.push({ desk: "STORE", action: "store_alert", params: { template: "STORE_LAB_CANCELLED", orderId: order.id, storeId: order.storeId, fact: "console_cancelled", detail: reason || "no reason given", at: now.toISOString() }, reason: `LabStack: CANCELLED${reason ? ` — ${reason}` : ""}`, idemKey: idem });
      }
      if (!byCustomer || collectedBefore) {
        const why = collectedBefore ? "the sample was already collected — the lab needs a new order id to process it" : nsa ? "the area is marked non-serviceable — needs another lab or a centre visit" : `reason: ${reason || "none given"}`;
        actions.push({ desk: "LAB", action: "ops_post", params: { kind: "OPS_CANCEL", orderId: order.id, text: `⛔ *${order.labName ?? "The lab"} cancelled #${order.id}* · ${(order.patientName ?? "").trim().split(/\s+/)[0] || "patient"}${order.area ? ` · ${order.area}` : ""}${order.appointmentTime ? ` · visit ${LABELS_TIME(order.appointmentTime, tzc)}` : ""}\n${why}\n\nReply *on it* to take it.` }, reason: `LabStack: CANCELLED — ${why}`, idemKey: `${idem}:ops` });
      }
    }
    const movedByLab = before && (changes.includes("RESCHEDULED") || (order.orderStatus === "RESCHEDULED" && before.orderStatus !== "RESCHEDULED"));
    if (movedByLab && order.storeId != null && order.appointmentTime) {
      const when = order.appointmentTime.toLocaleString("en-IN", { timeZone: tzc, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      // A move the store itself asked for is confirmed as done — no patient name, no "patient
      // unavailable", no "please let the customer know" (28 Oct 2026: Plum asked for 9 am and read
      // "The lab has rescheduled… Patient unavailable"; Sushma then confirmed it again by hand).
      // "As requested" only when the console landed on the time the store asked for (within 15 min);
      // a move to another time is the lab's news, and the store must hear the difference (28 Oct
      // 2026: asked 9:45, moved to 8:30, told "done — moved to 8:30 as requested").
      const matchesRequest = !requestedMove || Math.abs(order.appointmentTime.getTime() - new Date(requestedMove).getTime()) <= 15 * MIN;
      if (storeAskedToMove && matchesRequest) actions.push({ desk: "STORE", action: "ack", params: { template: "STORE_CONFIRMED_CHANGE", orderId: order.id, storeId: order.storeId, change: `moved to ${when} as requested`, intent: "status" }, reason: `LabStack: visit moved to ${when} as the store asked`, idemKey: `console-moved:${order.id}:${order.appointmentTime.getTime()}` });
      else actions.push({ desk: "STORE", action: "store_alert", params: { template: "STORE_LAB_RESCHEDULED", orderId: order.id, storeId: order.storeId, fact: "console_rescheduled", detail: `now ${when}${note}`, at: now.toISOString() }, reason: `LabStack: visit moved to ${when}${note}`, idemKey: `console-moved:${order.id}:${order.appointmentTime.getTime()}` });
    }
  } else {
    checkpoints = waiveImplied(buildCheckpoints(order, checkpoints, now, { recomputePreCollection: false, rebuildAll: false, labTier: input.labTier, sop: input.sop }));
  }

  // 2. Terminal: stop everything (FR-1.9, FR-2.8).
  if (TERMINAL_STATUSES.has(order.orderStatus)) {
    const reason = order.orderStatus === "REPORT_DELIVERED" ? "REPORT_DELIVERED" : "CANCELLED";
    if (!journey.closedAt) { newEvents.push({ kind: "closed", at: now, actor: "SYSTEM", payload: { reason } }); withdraw.push({ reason: reason.toLowerCase() }); }
    return {
      journey: { ...journey, closedAt: journey.closedAt ?? now, closeReason: reason, waitingFor: null, dueAt: null, dueSource: null, nextCheckAt: null, health: "ON_TRACK", plan: planOf(checkpoints, now, undefined, null) },
      checkpoints, newEvents, actions: curateStoreAlerts(actions), withdraw, risk: null, caseworker: null,
    };
  }

  // 3. Events: people, facts, promises.
  const attempts: Record<string, Attempt> = { ...journey.attempts };
  const factsSeen: Array<{ kind: string; value: string; confidence: number; source: string; named: boolean; id: string | null; at: Date; fullText?: string }> = [];
  const storeMessages: Array<{ intent: string; text: string; messageId: string; waMsgId: string | null; at: Date; samples?: Record<string, string>; requestTime?: string | null; thread?: { kind: string; waitingOn: string; openedAt: string } | null }> = [];
  let caseworker: StepOutput["caseworker"] = null;
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
      const context = typeof ev.payload.context === "string" ? ev.payload.context : "";
      // Under a re-collection ask ("… · urine sample pending — slot for re-collection?"), the lab's
      // time is a promise for the missed sample, not an ETA or a fresh collection (25 Oct 2026).
      const recollect = /re-collection/i.test(context) ? (/\b(urine|stool|sputum|swab)\b/i.exec(context)?.[1]?.toLowerCase() ?? "sample") : null;
      // "the blood has been collected" under that ask is old news, not a fresh collection.
      if (recollect && kind === "sample_collected" && !parsePromiseTime(String(ev.payload.fullText ?? value), ev.at, tz)) continue;
      if (recollect && order.storeId != null && ["eta", "new_appointment_time", "note", "sample_collected"].includes(kind)) {
        const when = parsePromiseTime(value, ev.at, tz) ?? parsePromiseTime(String(ev.payload.fullText ?? ""), ev.at, tz);
        if (when) {
          actions.push({ desk: "STORE", action: "store_alert", params: { template: "STORE_LAB_PROMISE", orderId: order.id, storeId: order.storeId, fact: "recollection_promise", detail: `${recollect} re-collection by ${LABELS_TIME(when, tz)}`, at: ev.at.toISOString() }, reason: `lab offers ${recollect} re-collection by ${LABELS_TIME(when, tz)}`, idemKey: `recollect-promise:${order.id}:${when.getTime()}` });
          newEvents.push({ kind: "promise", at: ev.at, actor: "LAB", payload: { kind: "recollection", checkpoint: "sample_collected", dueAt: when, text: value.slice(0, 200), superseded: false } });
          continue; // not a fresh "collected", not an ETA
        }
      }
      const named = ev.payload.attributedBy !== "ONLY_OPEN";
      factsSeen.push({ kind, value, confidence, source, named, id: (ev.payload.factId as string | null) ?? null, at: ev.at, fullText: typeof ev.payload.fullText === "string" ? ev.payload.fullText : value });
      // The lab says the visit failed (RNR, not home): "phlebo on time?" and "phlebo needed?" are moot.
      if (kind === "patient_unavailable") withdraw.push({ asks: ["ETA", "PHLEBO"], reason: "patient unreachable" });
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
          // The store hears the promise too ("lab says report by 6 pm"), so it stops asking.
          if (order.storeId != null && (map.checkpoint === "report_delivered" || map.checkpoint === "phlebo_reached" || map.checkpoint === "sample_collected")) {
            actions.push({ desk: "STORE", action: "store_alert", params: { template: "STORE_LAB_PROMISE", orderId: order.id, storeId: order.storeId, fact: "promise", text: `${LABELS[map.checkpoint].toLowerCase()} by ${LABELS_TIME(promiseAt, tz)}`, at: ev.at.toISOString() }, reason: `lab promised ${map.checkpoint} by ${LABELS_TIME(promiseAt, tz)}`, idemKey: `promise-relay:${order.id}:${map.checkpoint}:${promiseAt.getTime()}` });
          }
        } else {
          attempts[map.checkpoint] = { ...a, answeredAt: ev.at.toISOString() };
        }
      }
    } else if (ev.kind === "store_message") {
      storeMessages.push({ intent: String(ev.payload.intent ?? "other"), text: String(ev.payload.text ?? ""), messageId: String(ev.payload.messageId ?? ""), waMsgId: (ev.payload.waMsgId as string | null) ?? null, at: ev.at, samples: (ev.payload.samples as Record<string, string> | undefined) ?? {}, requestTime: (ev.payload.requestTime as string | null | undefined) ?? null, thread: (ev.payload.thread as { kind: string; waitingOn: string; openedAt: string } | null | undefined) ?? null });
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

  // A checkpoint the console met since the last wake makes its queued ask — and any escalation
  // for it — moot (27 Oct 2026: Orange's phlebo started at 5:07, the manager escalation queued
  // overnight still went to the ops group at 7:00).
  for (const c of checkpoints) {
    if (c.status !== "MET" || input.checkpoints.find((p) => p.name === c.name)?.status === "MET") continue;
    const intent = sop?.asks[c.name]?.intent;
    withdraw.push({ asks: [...(intent ? [intent] : []), "ESCALATION"], reason: `${LABELS[c.name]} met (console)` });
  }

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
      // What the lab said reaches the store that placed the order, at once (25 Oct 2026: ops
      // relayed "customer not available" by hand). Fixed behaviour; the SOP adds, never removes.
      const relay = STORE_RELAY[f.kind];
      if (relay && order.storeId != null && f.source !== "store_msg" && !sop.handoffs.some((x) => x.onFact === f.kind && x.do === "store_alert")) {
        actions.push({ desk: "STORE", action: "store_alert", params: { template: relay, orderId: order.id, storeId: order.storeId, fact: f.kind, detail: relayDetail(f), at: f.at.toISOString() }, reason: `lab says ${f.kind.replace(/_/g, " ")}: "${f.value.slice(0, 60)}"`, idemKey: `relay:${order.id}:${f.kind}:${f.id ?? f.at.getTime()}` });
      }
      // A lab that cannot do the order needs a person now, not just the store (27 Oct 2026).
      if (f.kind === "cannot_fulfil" && f.source !== "store_msg") {
        actions.push({ desk: "LAB", action: "ops_post", params: { kind: "OPS_CANCEL", orderId: order.id, text: `⛔ *${order.labName ?? "The lab"} cannot do #${order.id}* · ${(order.patientName ?? "").trim().split(/\s+/)[0] || "patient"}${order.area ? ` · ${order.area}` : ""}${slot ? ` · visit ${LABELS_TIME(slot, tz)}` : ""}\n"${f.value.slice(0, 160)}"\nNeeds another lab, a centre visit, or a new slot.\n\nReply *on it* to take it.` }, reason: `lab cannot fulfil: "${f.value.slice(0, 60)}"`, idemKey: `ops-cannot:${order.id}:${f.id ?? f.at.getTime()}` });
      }
      for (const h of sop.handoffs.filter((x) => x.onFact === f.kind && x.do !== "status_write")) {
        const key = `${h.do}:${order.id}:${f.kind}:${f.id ?? f.at.getTime()}`;
        if (h.do === "store_alert") {
          actions.push({ desk: "STORE", action: "store_alert", params: { template: h.template ?? "STORE_PATIENT_UNREACHABLE", orderId: order.id, storeId: order.storeId, fact: f.kind, text: f.value.slice(0, 200), detail: relayDetail(f), at: f.at }, reason: `lab says ${f.kind.replace("_", " ")}: "${f.value.slice(0, 60)}"`, evidenceIds: f.id ? [f.id] : [], idemKey: key });
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
        if (order.orderStatus === "PATIENT_MISSED") return { statusLine: `the lab marked the patient as missed${order.statusNote ? ` (${order.statusNote.slice(0, 80)})` : ""}.`, nextLine: "Please share a new slot." };
        if (order.orderStatus === "RESCHEDULED") return { statusLine: `rescheduled to ${fmtDay(slot)}${order.statusNote ? ` (${order.statusNote.slice(0, 80)})` : ""}.`, nextLine: "" };
        if (collected?.status === "MET") return { statusLine: `sample collected ${fmt(collected.metAt)}.`, nextLine: report ? `Report expected by ${fmtDay(report.dueAt)}.` : "" };
        if (order.phleboName.trim()) return { statusLine: `phlebo ${order.phleboName.trim()} assigned for ${fmtDay(slot)}.`, nextLine: "" };
        if (checkpoints.find((c) => c.name === "confirmed")?.status === "MET") return { statusLine: `confirmed by the lab for ${fmtDay(slot)}.`, nextLine: "" };
        return null;
      })();
      const quote = m.waMsgId ? { quotedWaId: m.waMsgId } : {};
      // A nudge on a request still open ("is this done?" after a reschedule ask): say where it is,
      // not "noted" again (27 Oct 2026).
      if (m.thread && m.thread.kind !== "status" && (m.intent === "status" || m.intent === "other")) {
        const who = m.thread.waitingOn === "LAB" ? (order.labName ?? "the lab") : "our team";
        const since = LABELS_TIME(new Date(m.thread.openedAt), tz);
        actions.push({ desk: "STORE", action: "store_reply", params: { text: `#${order.id}: your ${m.thread.kind.replace("_", " ")} request (asked at ${since}) is with ${who} — we'll confirm here the moment it's done.`, orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: `store nudged an open ${m.thread.kind} request`, idemKey: `${key}:thread` });
        continue;
      }
      // A sample left behind ("urine samples not collected, slots please", Plum, 25 Oct 2026) wins
      // over whatever the message otherwise looks like: never answer it with "sample collected".
      const missedSample = Object.entries(m.samples ?? {}).find(([k, s]) => s === "missed" && k !== "blood")?.[0];
      const left = missedSample ? [missedSample] : m.text.match(/\b(urine|stool|sputum|swab|second|remaining|balance)\b[^.\n]{0,40}\b(not|pending|missed|left|skipped)\b|\bnot collected\b/i);
      if (left && order.labId != null && sop && !["reschedule", "cancel", "change_tests", "complaint"].includes(m.intent)) {
        const sampleWord = missedSample ?? /\b(urine|stool|sputum|swab)\b/i.exec(m.text)?.[1]?.toLowerCase();
        const note = `${sampleWord ? `${sampleWord} sample` : "a sample"} pending — slot for re-collection?`;
        const window = sendWindow(now, now, sop, { intent: "STATUS", leadMin: 0, graceMin: 480, urgentWithinMin: 0, nightBefore: false }, true, false, tz);
        actions.push({ desk: "LAB", action: "ask", params: { checkpoint: "sample_collected", orderId: order.id, labId: order.labId, attempt: 1, dueAt: now, rung: "ask", intent: "STATUS", counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent: true, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, note }, forStore: true }, reason: `store says ${sampleWord ?? "a"} sample was not collected${/slot/i.test(m.text) ? " and asks for slots" : ""}`, idemKey: `${key}:recollect` });
        const collectedLine = collected?.status === "MET" ? `blood collected ${fmt(collected.metAt)}; ` : "";
        const hours = input.slotSummary ? ` ${input.slotSummary}.` : "";
        actions.push({ desk: "STORE", action: "store_reply", params: { text: `#${order.id}: ${collectedLine}${sampleWord ? `${sampleWord} sample` : "a sample"} pending — asking the lab for a re-collection slot now.${hours} Share a preferred time and we'll book it.`, orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: `store says ${sampleWord ?? "a"} sample was not collected; the lab is being asked`, idemKey: `${key}:recollect-ack` });
        continue;
      }
      // The store reports the visit failed ("94669 - phlebo no show", Plum, 27 Oct 2026). Whatever the
      // console shows, the lab is asked now with the store's words, and the store hears we are on
      // it — unless the console already says the lab could not reach the patient, which answers it.
      if (sop && storeExceptionRe(sop)?.test(m.text) && order.labId != null && order.orderStatus !== "PATIENT_MISSED" && collected?.status !== "MET" && !["reschedule", "cancel", "change_tests"].includes(m.intent)) {
        const cp = next?.name ?? "sample_collected";
        const window = sendWindow(now, now, sop, { intent: "STATUS", leadMin: 0, graceMin: 240, urgentWithinMin: 0, nightBefore: false }, true, true, tz);
        actions.push({ desk: "LAB", action: "ask", params: { checkpoint: cp, orderId: order.id, labId: order.labId, attempt: (attempts[cp]?.n ?? 0) + 1, dueAt: now, rung: "ask", intent: "STATUS", counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent: true, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, phlebo: order.phleboName || null, note: `store reports: "${m.text.replace(/\s+/g, " ").slice(0, 80)}" — what happened? ETA or a new slot?` }, forStore: true }, reason: `store reports the visit failed: "${m.text.slice(0, 60)}"`, idemKey: `${key}:exception` });
        actions.push({ desk: "STORE", action: "store_reply", params: { template: "STORE_CHECKING", orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: "store reports the visit failed; the lab is being asked now", idemKey: `${key}:exception-ack` });
        continue;
      }
      switch (m.intent) {
        case "slot": {
          if (input.slotSummary) {
            actions.push({ desk: "STORE", action: "store_reply", params: { text: `#${order.id}: ${input.slotSummary}. Share a preferred time and we'll book it.`, orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: "store asked for slots; answered from the lab's usual hours", idemKey: `${key}:slots` });
            break;
          }
        }
        // falls through
        case "status": case "report": {
          const slotPassed = slot != null && now.getTime() > slot.getTime() + 30 * MIN;
          // A console that says the patient was missed or the visit was moved explains a passed slot itself.
          const consoleExplains = order.orderStatus === "PATIENT_MISSED" || order.orderStatus === "RESCHEDULED";
          // The report's due time has passed with no report: never "expected by <a time gone by>",
          // whatever the question was called (28 Oct 2026, 4:12 pm: "sample collected 7:38 am.
          // Report expected by Tue, 27 Oct" — the store had just written "the TAT is breached").
          const reportOverdue = collected?.status === "MET" && !!report && report.status !== "MET" && now.getTime() > report.dueAt.getTime();
          // The lab is asked about the next milestone — or, when the report is overdue, about the
          // report itself, whatever sits between (the console may still show "sample at lab").
          const chase = (reason: string, overdue = false) => {
            const cp = overdue ? report! : next;
            if (cp && sop && (overdue || from === "LAB") && sop.asks[cp.name] && (overdue || !consoleIsLive(order, input.labTier, now, sop.consoleQuietMin))) {
              const ask = sop.asks[cp.name];
              const urgent = overdue || slotPassed || (minutesToSlot != null && minutesToSlot <= ask.urgentWithinMin);
              const window = sendWindow(now, now, sop, { ...ask, leadMin: 0, graceMin: 240 }, true, urgent, tz);
              actions.push({ desk: "LAB", action: "ask", params: { checkpoint: cp.name, orderId: order.id, labId: order.labId, attempt: (attempts[cp.name]?.n ?? 0) + 1, dueAt: cp.dueAt, rung: "ask", intent: ask.intent, counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, milestone: LABELS[cp.name], dueAt: cp.dueAt, phlebo: order.phleboName || null, ...(overdue ? { note: `report was due ${fmtDay(cp.dueAt)} — the store is waiting` } : {}) }, forStore: true }, reason, idemKey: `${key}:chase` });
            }
          };
          if (reportOverdue) {
            // Once a day per order, not once per message: the store heard it, and a second
            // "overdue — chasing" on the same order reads as a bot going round in circles
            // (28 Oct 2026, #94284 twice). The lab is chased when the desk can; otherwise a person
            // is tagged, because "chasing Thyrocare now" with no Thyrocare desk is a claim nobody acts on.
            const day = now.toLocaleDateString("en-CA", { timeZone: tz });
            const due = fmtDay(report!.dueAt);
            if (input.labChaseable !== false) {
              actions.push({ desk: "STORE", action: "store_reply", params: { text: `#${order.id}: sample collected ${fmt(collected!.metAt)}; the report was due ${due} and is overdue — chasing ${order.labName ?? "the lab"} now, will update here.`, orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: `store asked for ${m.intent}; the report is overdue since ${due}`, idemKey: `store:${order.id}:overdue:${day}` });
              chase(`store asked about #${order.id}; the report is overdue`, true);
            } else {
              actions.push({ desk: "STORE", action: "store_handoff", params: { orderId: order.id, storeId: order.storeId, intent: "report", note: `report overdue (was due ${due}) — please chase ${order.labName ?? "the lab"} and update the store`, ...quote }, reason: `store asked for ${m.intent}; the report is overdue since ${due} and ${order.labName ?? "the lab"} has no desk to chase it through`, idemKey: `store:${order.id}:overdue-handoff:${day}` });
              actions.push({ desk: "STORE", action: "create_task", params: { taskType: "AGENT_REPORT_UPLOAD", orderId: order.id, cause: "REPORT_OVERDUE", evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: `#${order.id}: report overdue since ${due} — chase ${order.labName ?? "the lab"}, upload the report, tell the store`, dueInMinutes: 60 }, reason: `report overdue since ${due}; the store is asking`, idemKey: `store:${order.id}:overdue-task:${day}` });
            }
            break;
          }
          const canAnswer = known && (consoleExplains || !(m.intent !== "report" && slotPassed && collected?.status !== "MET"));
          if (canAnswer) {
            actions.push({ desk: "STORE", action: "store_reply", params: { template: "STORE_STATUS_ANSWER", orderId: order.id, storeId: order.storeId, intent: m.intent, ...known, ...quote }, reason: `store asked for ${m.intent}; the console knows`, idemKey: `${key}:answer` });
          } else {
            actions.push({ desk: "STORE", action: "store_reply", params: { template: "STORE_CHECKING", orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: `store asked for ${m.intent}; the console does not know yet`, idemKey: `${key}:checking` });
            chase(`store asked about #${order.id} and the console does not know`);
          }
          break;
        }
        case "reschedule": case "cancel": case "change_tests": {
          const taskType = m.intent === "reschedule" ? "AGENT_RESCHEDULE" : m.intent === "cancel" ? "AGENT_CANCEL" : "AGENT_ORDER_CHANGE";
          const requested = requestedTime(m.text, m.at, order.appointmentTime, tz);
          const tomorrowOnly = !requested && /\btomorrow\b|\bkal\b|\bnext day\b/i.test(m.text);
          actions.push({ desk: "STORE", action: "ack", params: { template: "STORE_NOTED", orderId: order.id, storeId: order.storeId, intent: m.intent, ...quote }, reason: `store asked to ${m.intent.replace("_", " ")}`, idemKey: `${key}:noted` });
          // The lab hears it too, with the time, so it can confirm or push back before the
          // booking is changed ("94103 — urine collection at 10:45?", Plum, 25 Oct 2026).
          if (order.labId != null && sop && (m.intent !== "change_tests")) {
            const whenText = requested ? LABELS_TIME(requested, tz) + (requested.toDateString() !== now.toDateString() ? ` ${requested.toLocaleDateString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })}` : "") : null;
            const sample = /\b(urine|stool|sputum|swab)\b/i.exec(m.text)?.[1]?.toLowerCase();
            const note = m.intent === "cancel" ? "store asks to cancel — please stand down"
              : tomorrowOnly ? `${sample ? `${sample} re-collection` : "reschedule"} requested for tomorrow — which slot?`
              : `${sample ? `${sample} re-collection` : "reschedule"} requested${whenText ? ` at ${whenText}` : ""} — ok?`;
            const window = sendWindow(now, now, sop, { intent: "STATUS", leadMin: 0, graceMin: 480, urgentWithinMin: 0, nightBefore: false }, true, false, tz);
            actions.push({ desk: "LAB", action: "ask", params: { checkpoint: next?.name ?? "sample_collected", orderId: order.id, labId: order.labId, attempt: 1, dueAt: now, rung: "ask", intent: "STATUS", counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent: false, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, note }, forStore: true }, reason: `store asked to ${m.intent}${whenText ? ` at ${whenText}` : ""}; the lab is told`, idemKey: `${key}:lab-heads-up` });
          }
          actions.push({ desk: "STORE", action: "create_task", params: { taskType, orderId: order.id, cause: `STORE_${m.intent.toUpperCase()}`, evidence: [{ kind: "store_msg", at: m.at.toISOString(), text: m.text.slice(0, 300) }], action: m.intent === "reschedule" ? `Reschedule #${order.id}${requested ? ` to ${fmtDay(requested)}` : " as the store asked"} in the console` : m.intent === "cancel" ? `Cancel #${order.id} in the console` : `Change #${order.id}'s tests as the store asked, then tell the lab`, verify: m.intent === "reschedule" ? (requested ? { kind: "slot_equals", value: requested.toISOString() } : { kind: "none" }) : m.intent === "cancel" ? { kind: "status_at_least", value: "CANCELED" } : { kind: "none" }, dueInMinutes: 30 }, reason: `store asked to ${m.intent.replace("_", " ")}: "${m.text.slice(0, 80)}"`, idemKey: `${key}:task` });
          if (!journey.subStates.includes("change_pending")) journey = { ...journey, subStates: [...journey.subStates, "change_pending"] };
          // The time asked for, so the console's move can be checked against it.
          journey = { ...journey, subStates: [...journey.subStates.filter((s) => !s.startsWith("requested:")), ...(requested && m.intent === "reschedule" ? [`requested:${requested.toISOString()}`] : [])] };
          break;
        }
        case "complaint":
          // A person answers a complaint, and is tagged now — not a task nobody in the group sees.
          actions.push({ desk: "STORE", action: "store_handoff", params: { orderId: order.id, storeId: order.storeId, intent: "complaint", ...quote }, reason: "store complained; a person answers", idemKey: `${key}:complaint-handoff` });
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

  // 5c. When no deterministic step fits, the case worker decides (FR-1.6): a lab-raised problem
  //     the hand-offs do not cover, a store message nobody could place, or an exhausted ladder.
  if (sop && !taken && !journey.closedAt) {
    const covered = new Set([...Object.keys(FACT_TO_CHECKPOINT), ...sop.handoffs.map((h) => h.onFact)]);
    const odd = factsSeen.find((f) => !covered.has(f.kind) && f.kind !== "note" && f.value.trim().length > 3) ?? factsSeen.find((f) => f.kind === "note" && f.value.trim().length > 12 && next != null);
    const stray = storeMessages.find((m) => m.intent === "other" && m.text.trim().length > 8);
    const exhausted = next && brokenPromises >= sop.brokenPromisesSkip && (attempts[next.name]?.n ?? 0) >= sop.ladder.length;
    if (odd) caseworker = { reason: `lab said something the SOP has no step for (${odd.kind})`, text: odd.value, checkpoint: next?.name ?? null, factKind: odd.kind, at: odd.at };
    else if (stray) caseworker = { reason: "store message with no clear intent", text: stray.text, checkpoint: next?.name ?? null, intent: "other", at: stray.at };
    else if (exhausted) caseworker = { reason: `${brokenPromises} broken promises and the ladder is exhausted for ${next!.name}`, text: `console shows ${order.orderStatus}; due ${next!.dueAt.toISOString()}`, checkpoint: next!.name, at: now };
  }

  // 5d. 20:30 the evening before an early visit at a manual lab with no phlebo named: the store
  //     hears tonight, not when the customer calls at 7 am. Once per order per evening; SUGGEST by default.
  if (sop && !taken && order.storeId != null && (input.labTier ?? "C") === "C" && slot != null && !order.phleboName.trim()) {
    const m = localMinutes(now, tz);
    const minutesAhead = (slot.getTime() - now.getTime()) / MIN;
    if (m >= hm("20:30") && m < hm("21:00") && minutesAhead > 6 * 60 && minutesAhead < 14 * 60 && localMinutes(slot, tz) < hm("09:00")) {
      const day = startOfLocalDay(now, tz);
      actions.push({ desk: "STORE", action: "store_warning", params: { orderId: order.id, storeId: order.storeId, slot, reasons: ["no phlebo named for an early visit"], predictedDelayMin: 60, cannotDoToday: false }, reason: `visit ${LABELS_TIME(slot, tz)} tomorrow; ${order.labName ?? "the lab"} has not named a phlebo by 20:30`, idemKey: `eve-warning:${order.id}:${day}` });
    }
  }

  // 6. The ladder for the checkpoint the order waits on (FR-8.7).
  let rungLabel: string | null = null;
  if (sop && next && !taken) {
    const ask = sop.asks[next.name];
    const a = attempts[next.name] ?? { n: 0, at: null };
    // The evening before (from 18:00): any visit before 09:00 tomorrow at a lab that answers in the
    // group, risky or not — the morning is too late to find out nobody is coming (25 Oct 2026).
    const earlyTomorrow = slot != null && localMinutes(slot, tz) < hm("09:00");
    const nightBefore = ask?.nightBefore && (journey.riskLevel !== "LOW" || earlyTomorrow) && minutesToSlot != null && minutesToSlot > 10 * 60 && minutesToSlot < 20 * 60 && localMinutes(now, tz) >= hm("18:00");
    const due = next.dueAt;
    const started = now.getTime() >= due.getTime() - (ask?.leadMin ?? 0) * MIN || nightBefore;
    const lastAt = a.at ? Date.parse(a.at) : null;
    // A report chase climbs its ladder a day at a time — a 20-day backlog must not reach "stuck"
    // by lunch (27 Oct 2026). Everything else keeps the SOP's gap.
    const gapMin = next.name === "report_delivered" ? Math.max(sop.rungGapMin, sop.reportRungGapMin) : sop.rungGapMin;
    const gapOk = lastAt == null || now.getTime() - lastAt >= gapMin * MIN;
    const answeredAt = a.answeredAt ? Date.parse(a.answeredAt) : null;
    const holding = answeredAt != null && now.getTime() - answeredAt < sop.answerHoldMin * MIN && next.dueSource !== "RESET";
    // No portal session: there is nothing to read, so the ask goes straight to the group.
    const ladder = input.portalReady ? sop.ladder : sop.ladder.filter((r) => r !== "portal_read");
    // A pre-visit checkpoint still open two hours after the visit is not a chase
    // any more ("phlebo on time?" for a visit five days past went out on 24 Oct
    // 2026): the visit happened or it did not, and LabStack does not say — one
    // task for a person, then the journey waits for the console.
    const preVisit = checkpointDefs(order.orderType).find((d) => d.name === next.name)?.preCollection === true;
    // An API lab whose webhook updated this order around the visit has told us where it is: no
    // WhatsApp ask for the visit checkpoints; ask only when the console has gone quiet (26 Oct 2026).
    const consoleAnswers = preVisit && consoleIsLive(order, input.labTier, now, sop?.consoleQuietMin);
    // An API lab asked "phlebo needed?" ten minutes before the visit answers "collection in
    // progress" (Orange, 25 Oct 2026): LabStack has not caught up. Inside the last quarter
    // hour it is not worth a message (Orange assigns at slot − 30 min, so −30…−15 is fair).
    const apiPhleboTooLate = input.labTier != null && input.labTier !== "C" && next.name === "phlebo_assigned" && minutesToSlot != null && minutesToSlot < 15;
    const visitLongPast = preVisit && minutesToSlot != null && minutesToSlot < -120;
    // An API lab's console names the phlebo and starts the visit by itself: before the visit the
    // group gets an ask and one reminder, never a manager escalation (27 Oct 2026: ten Orange
    // orders reached the ops group at 7:00 with their phlebos already on the way). Once the visit
    // is two hours past with no update, the lab is asked in its group — an ask and a reminder —
    // and only then is a person told (28 Oct 2026: "Collection stuck" tasks reached the ops group
    // at two hours with the lab never asked; such things are chased with the lab).
    const apiLadderCapped = input.labTier != null && input.labTier !== "C" && preVisit && minutesToSlot != null && minutesToSlot >= -120 && a.n > Math.max(0, ladder.indexOf("reminder"));
    const askedSinceVisit = a.n >= Math.max(1, ladder.indexOf("reminder") + 1);
    if (visitLongPast && from === "LAB" && a.n < 99 && askedSinceVisit) {
      rungLabel = "task";
      actions.push({ desk: "LAB", action: "create_task", params: {
        checkpoint: next.name, orderId: order.id, labId: order.labId, attempt: 1, dueAt: due, rung: "task",
        taskType: STUCK_TASK[next.name] ?? "AGENT_COLLECTION_STUCK", cause: "VISIT_PASSED_NO_UPDATE",
        evidence: [{ kind: "console", at: now.toISOString(), text: `visit ${Math.round(-minutesToSlot / 60)} h ago; the console still shows ${order.orderStatus}; the lab was asked ${a.n} time(s) with no answer` }],
        action: `Call ${order.labName ?? "the lab"} about #${order.id}: the visit was ${Math.round(-minutesToSlot / 60)} h ago, LabStack still shows ${order.orderStatus.toLowerCase().replace(/_/g, " ")}, and the group has not answered ${a.n} ask(s)`,
      }, reason: `${LABELS[next.name]} still open ${Math.round(-minutesToSlot / 60)} h after the visit; the console shows ${order.orderStatus}; ${a.n} ask(s) unanswered`, idemKey: `visit-passed:${order.id}:${next.name}` });
      attempts[next.name] = { ...a, n: 99, at: now.toISOString() };
      journey = { ...journey, attempts };
    } else if (sop && from === "LAB" && ask && (a.n >= 99 || a.n >= ladder.length) && (!a.at || now.getTime() - Date.parse(a.at) >= sop.reaskEveryMin * MIN) && !consoleIsLive(order, input.labTier, now, sop.consoleQuietMin)) {
      // The ladder ran out, or the visit is long past with a person told: the lab is still asked,
      // once a day, in the routine combined list, until the console moves (27 Oct 2026). Always a
      // STATUS ask — "what happened with this visit?" — whatever checkpoint is open.
      rungLabel = "reask";
      const window = sendWindow(now, now, sop, { ...ask, intent: "STATUS", leadMin: 0, graceMin: 720, urgentWithinMin: 0, nightBefore: false }, false, false, tz);
      actions.push({ desk: "LAB", action: "ask", params: {
        checkpoint: next.name, orderId: order.id, labId: order.labId, attempt: a.n, dueAt: due, rung: "ask", intent: "STATUS", counterparty: `LAB:${order.labId}`,
        windowFrom: window.from, windowTo: window.to, urgent: false,
        line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, milestone: LABELS[next.name], dueAt: due, phlebo: order.phleboName || null },
      }, reason: `${LABELS[next.name]} still open after every ask; asked again (every ${Math.round(sop.reaskEveryMin / 60)} h until the console moves)`, idemKey: `reask:${order.id}:${next.name}:${startOfLocalDay(now, tz)}` });
      attempts[next.name] = { ...a, at: now.toISOString() };
      journey = { ...journey, attempts };
    } else if (from === "LAB" && ask && started && gapOk && !holding && !apiPhleboTooLate && !consoleAnswers && !apiLadderCapped) {
      let rungIndex = a.n;
      if (brokenPromises >= sop.brokenPromisesSkip && rungIndex > 0 && rungIndex < ladder.length - 1) rungIndex += 1;
      const rung = ladder[Math.min(rungIndex, ladder.length - 1)];
      rungLabel = rung;
      // Urgent before the visit when it is close; urgent after it while it is recent — a visit an
      // hour past with the console quiet is asked about within minutes, not at the next slot
      // (27 Oct 2026). Report chases never are: they keep their two daily slots.
      const urgent = minutesToSlot != null && next.name !== "report_delivered" && (
        (minutesToSlot >= 0 && minutesToSlot <= ask.urgentWithinMin) || (minutesToSlot < 0 && -minutesToSlot <= sop.urgentAfterVisitMin));
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
            actions.push({ desk: "LAB", action: rung, params: { ...common, intent: ask.intent, counterparty: `LAB:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, milestone: LABELS[next.name], dueAt: due, phlebo: order.phleboName || null } }, reason: why, idemKey: idem });
            break;
          case "manager_whatsapp":
            actions.push({ desk: "LAB", action: "manager_whatsapp", params: { ...common, intent: "ESCALATION", counterparty: `MANAGER:${order.labId}`, windowFrom: window.from, windowTo: window.to, urgent, line: { orderId: order.id, patientName: order.patientName, appointment: order.appointmentTime, labRef: order.labRef ?? null, mobile: order.mobile ?? null, area: order.area ?? null, milestone: LABELS[next.name], dueAt: due } }, reason: `${why}; ${a.n} asks unanswered`, idemKey: idem });
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
    // Not at night: a warning raised at 23:00 ("lab silent for 3 h") is noise, and it would wait
    // until morning anyway — the morning's risk check raises it again if it still holds.
    const localHour = Number(now.toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false })) % 24;
    const night = localHour >= 21 || localHour < 7;
    if (sop && !taken && !night && risk.level === "HIGH" && target && target.status !== "MET" && order.storeId != null && minutesToSlot != null && minutesToSlot > sop.warnStoreBeforeMin && minutesToSlot <= 24 * 60) {
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
    if (sop && a?.at && now.getTime() > next.dueAt.getTime()) candidates.push(Date.parse(a.at) + (next.name === "report_delivered" ? Math.max(sop.rungGapMin, sop.reportRungGapMin) : sop.rungGapMin) * MIN);
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
  return { journey, checkpoints, newEvents, actions: curateStoreAlerts(actions), withdraw, risk, caseworker };
}
