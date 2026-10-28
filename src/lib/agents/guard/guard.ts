/**
 * The policy guard: the one exit for everything an agent wants to do
 * (DESIGN.md §4.7). Every proposed action passes the same checks in order —
 * menu, hard rules, kill switches, desk state, autonomy level, idempotency —
 * and leaves one `agent_actions` row whatever happened to it (FR-14.1).
 *
 *   OFF desk        → BLOCKED (recorded, not done)
 *   SHADOW desk     → RECORDED (what it would have done)
 *   LIVE + SHADOW   → RECORDED
 *   LIVE + SUGGEST  → REVIEW: a review item for a person's one click
 *   LIVE + ACT_*    → EXECUTED through the executor (dispatcher, tasks, …)
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import type { ProposedAction } from "../journey/step";
import type { ActionName } from "../sop/schema";
import { execute } from "../executors";

export type Level = "SHADOW" | "SUGGEST" | "ACT_NOTIFY" | "ACT";
export type Outcome = "RECORDED" | "REVIEW" | "EXECUTED" | "BLOCKED" | "FAILED";
export type DeskState = "OFF" | "SHADOW" | "LIVE";
export const LEVELS: Level[] = ["SHADOW", "SUGGEST", "ACT_NOTIFY", "ACT"];

/** Actions that may never be proposed, whatever the SOP says (hard rules 1 and 2). */
const FORBIDDEN = new Set(["cancel", "reschedule", "change_tests", "refund", "message_patient", "call_patient"]);
const ALLOWED_TRANSITIONS = new Set(["PHLEBO_STARTED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "PHLEBO_NO_SHOW", "PATIENT_MISSED"]);

/** Default autonomy per action when no row says otherwise (DESIGN.md §3 step 7). */
export const DEFAULT_LEVELS: Partial<Record<ActionName, Level>> = {
  ask: "ACT", reminder: "ACT", manager_whatsapp: "ACT_NOTIFY", call: "ACT_NOTIFY", create_task: "ACT", stuck: "ACT", portal_read: "ACT",
  status_write: "SUGGEST", store_reply: "ACT_NOTIFY", store_alert: "ACT", store_warning: "SUGGEST", ack: "ACT", wait: "ACT",
  // A post to LabStack's own ops group is never a message to a lab or store: always allowed.
  ops_post: "ACT",
  // Handing a store question to a person in the group is how a desk stays within its scope: always allowed.
  store_handoff: "ACT",
};

export type GuardContext = {
  journeyId: string | null;
  orderId: number;
  labId: number | null;
  storeId: number | null;
  labTier?: "A" | "B" | "C" | null;
  sopVersionId?: string | null;
  /** Each desk's allowed-action menu from its live SOP. */
  menus?: Partial<Record<"LAB" | "INTAKE" | "STORE", ActionName[]>>;
  orderType?: string;
  appointmentTime?: Date | null;
  patientName?: string | null;
  labName?: string | null;
  storeName?: string | null;
};

export type GuardResult = { actionId: string; outcome: Outcome; level: Level; blockedBy?: string };

type Settings = { pausedAll: boolean; pausedDesks: string[]; pausedLabIds: number[]; pausedStoreIds: number[] };
type AutonomyRow = { action: string; desk: string; scopeKind: string; scopeKey: string; level: string };

export async function loadGuardState(): Promise<{ settings: Settings; desks: Map<string, DeskState>; scopes: Map<string, string[]>; autonomy: AutonomyRow[] }> {
  const [settings, rows, autonomy] = await Promise.all([
    prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } }),
    prisma.agentDeskState.findMany({ select: { desk: true, scopeKind: true, scopeId: true, state: true, liveIntents: true } }),
    prisma.agentAutonomy.findMany({ select: { action: true, desk: true, scopeKind: true, scopeKey: true, level: true } }),
  ]);
  return {
    settings: { pausedAll: settings.pausedAll, pausedDesks: settings.pausedDesks, pausedLabIds: settings.pausedLabIds, pausedStoreIds: settings.pausedStoreIds },
    desks: new Map(rows.map((r) => [`${r.desk}:${r.scopeKind}:${r.scopeId}`, r.state as DeskState])),
    // STORE desk: the kinds of question it answers itself (empty = every kind).
    scopes: new Map(rows.filter((r) => r.liveIntents.length).map((r) => [`${r.desk}:${r.scopeKind}:${r.scopeId}`, r.liveIntents])),
    autonomy,
  };
}

/** A store reply outside the desk's live scope is handed to a person instead (28 Oct 2026). */
export function outOfScope(state: Pick<GuardState, "scopes">, action: ProposedAction, ctx: GuardContext): string | null {
  if (action.desk !== "STORE" || !["store_reply", "ack"].includes(action.action) || ctx.storeId == null) return null;
  const intent = typeof action.params.intent === "string" ? action.params.intent : null;
  if (!intent) return null;
  const live = state.scopes.get(`STORE:STORE:${ctx.storeId}`);
  return live && !live.includes(intent) ? intent : null;
}
export type GuardState = Awaited<ReturnType<typeof loadGuardState>>;

function deskStateFor(state: GuardState, action: ProposedAction, ctx: GuardContext): DeskState {
  const scopeKind = action.desk === "STORE" ? "STORE" : "LAB";
  const scopeId = scopeKind === "STORE" ? ctx.storeId : ctx.labId;
  if (scopeId == null) return "OFF";
  return state.desks.get(`${action.desk}:${scopeKind}:${scopeId}`) ?? "OFF";
}

/**
 * The autonomy level for an action: the most specific row wins (STORE/LAB, then TIER, then ALL),
 * but a lab or store row may only lower what the tier says (decision 2, 21 Oct) unless it was
 * promoted on its own sample (promotedAt set, which the API enforces).
 */
export function levelFor(state: Pick<GuardState, "autonomy">, action: ProposedAction, ctx: GuardContext): Level {
  const rows = state.autonomy.filter((r) => r.action === action.action && r.desk === action.desk);
  const find = (kind: string, key: string | number | null | undefined) => (key == null ? undefined : rows.find((r) => r.scopeKind === kind && r.scopeKey === String(key))?.level as Level | undefined);
  const all = find("ALL", "*") ?? DEFAULT_LEVELS[action.action] ?? "SHADOW";
  const tier = find("TIER", ctx.labTier) ?? all;
  const specific = action.desk === "STORE" ? find("STORE", ctx.storeId) : find("LAB", ctx.labId);
  let level: Level = specific ?? tier;
  if (specific && LEVELS.indexOf(specific) > LEVELS.indexOf(tier)) level = specific; // promoted on its own sample
  // The two risky transitions and anything the SOP marks always-suggest never go above SUGGEST on their own.
  if (action.params.alwaysSuggest === true && LEVELS.indexOf(level) > LEVELS.indexOf("SUGGEST")) level = "SUGGEST";
  if (action.action === "status_write" && action.params.meetsBar === false) level = "SUGGEST";
  return level;
}

export function hardRuleViolation(action: ProposedAction): string | null {
  if (FORBIDDEN.has(action.action as string)) return `hard rule: agents never ${action.action}`;
  if (action.action === "status_write") {
    const to = String((action.params as { to?: unknown }).to ?? "");
    if (!ALLOWED_TRANSITIONS.has(to)) return `hard rule: transition ${to || "(none)"} is not on the allowed list`;
  }
  return null;
}

/** Decide, record, and (when live) execute one action. A repeat is reported as BLOCKED, never done twice. */
export async function guard(action: ProposedAction, ctx: GuardContext, state: GuardState): Promise<GuardResult> {
  let level: Level = levelFor(state, action, ctx);
  let outcome: Outcome = "RECORDED";
  let blockedBy: string | undefined;

  const violation = hardRuleViolation(action);
  if (violation) { outcome = "BLOCKED"; blockedBy = violation; }
  else if (action.action !== "ops_post" && action.action !== "store_handoff" && ctx.menus?.[action.desk] && !ctx.menus[action.desk]!.includes(action.action)) { outcome = "BLOCKED"; blockedBy = `not on the ${action.desk} desk's menu`; }
  else if (state.settings.pausedAll) { outcome = "BLOCKED"; blockedBy = "kill switch: everything paused"; }
  else if (state.settings.pausedDesks.includes(action.desk)) { outcome = "BLOCKED"; blockedBy = `kill switch: ${action.desk} desk paused`; }
  else if (ctx.labId != null && state.settings.pausedLabIds.includes(ctx.labId)) { outcome = "BLOCKED"; blockedBy = "kill switch: lab paused"; }
  else if (ctx.storeId != null && state.settings.pausedStoreIds.includes(ctx.storeId)) { outcome = "BLOCKED"; blockedBy = "kill switch: store paused"; }
  else {
    const desk = deskStateFor(state, action, ctx);
    const handoff = desk === "LIVE" ? outOfScope(state, action, ctx) : null;
    if (desk === "OFF") { outcome = "BLOCKED"; blockedBy = `desk ${action.desk} is off for this ${action.desk === "STORE" ? "store" : "lab"}`; }
    else if (handoff) {
      // Recorded as the draft it is (the self-evaluation reads it); a person in the group is tagged instead.
      outcome = "RECORDED"; blockedBy = `${handoff} is not live for this store — handed to the team`;
      const quoted = typeof action.params.quotedWaId === "string" ? action.params.quotedWaId : null;
      await guard({ desk: "STORE", action: "store_handoff", params: { orderId: ctx.orderId, storeId: ctx.storeId, intent: handoff, quotedWaId: quoted }, reason: `store ${handoff} request: not in the desk's live scope`, idemKey: `${action.idemKey}:handoff` }, ctx, state).catch(() => undefined);
    }
    else if (desk === "SHADOW" || level === "SHADOW") { level = desk === "SHADOW" ? "SHADOW" : level; outcome = "RECORDED"; }
    else if (level === "SUGGEST") outcome = "REVIEW";
    else outcome = "EXECUTED";
  }

  let row: { id: string };
  try {
    row = await prisma.agentAction.create({
      data: {
        journeyId: ctx.journeyId, orderId: ctx.orderId, desk: action.desk, action: action.action,
        params: action.params as Prisma.InputJsonValue, reason: action.reason, evidenceIds: action.evidenceIds ?? [],
        sopVersionId: ctx.sopVersionId ?? null, level, outcome: outcome === "EXECUTED" ? "PENDING" : outcome, blockedBy: blockedBy ?? null, idemKey: action.idemKey,
      },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.agentAction.findUnique({ where: { idemKey: action.idemKey }, select: { id: true } });
      return { actionId: existing?.id ?? "", outcome: "BLOCKED", level, blockedBy: "already done (idempotency key)" };
    }
    throw error;
  }

  if (outcome === "REVIEW") {
    await prisma.agentReviewItem.create({
      data: {
        kind: action.action, desk: action.desk, orderId: ctx.orderId, journeyId: ctx.journeyId, actionId: row.id,
        proposal: { ...action.params, reason: action.reason, order: { id: ctx.orderId, patientName: ctx.patientName ?? null, labName: ctx.labName ?? null, storeName: ctx.storeName ?? null, appointmentTime: ctx.appointmentTime ?? null } } as Prisma.InputJsonValue,
        confidence: action.confidence ?? null, storeId: ctx.storeId, labId: ctx.labId,
        dueAt: (action.params.dueAt as Date | undefined) ?? ctx.appointmentTime ?? null, weight: 1,
      },
    });
    return { actionId: row.id, outcome, level, blockedBy };
  }

  if (outcome === "EXECUTED") {
    try {
      const done = await execute(action, { ...ctx, actionId: row.id, level });
      await prisma.agentAction.update({ where: { id: row.id }, data: { outcome: done.outcome, blockedBy: done.note ?? null } });
      return { actionId: row.id, outcome: done.outcome === "FAILED" ? "FAILED" : "EXECUTED", level, blockedBy: done.note };
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      await prisma.agentAction.update({ where: { id: row.id }, data: { outcome: "FAILED", blockedBy: note.slice(0, 300) } });
      return { actionId: row.id, outcome: "FAILED", level, blockedBy: note };
    }
  }
  return { actionId: row.id, outcome, level, blockedBy };
}
