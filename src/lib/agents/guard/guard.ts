/**
 * The policy guard: the one exit for everything an agent wants to do
 * (DESIGN.md §4.7). Every proposed action passes the same checks in order —
 * hard rules, kill switches, desk state, autonomy level, idempotency — and
 * leaves one `agent_actions` row whatever happened to it (FR-14.1).
 *
 * Phase 0: every desk is OFF unless set, every level is SHADOW. Nothing is
 * executed; the guard records what the agent would have done. Executors
 * (dispatcher, console writer, tasks, calls) plug in at `execute` in Phase 1.
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import type { ProposedAction } from "../journey/step";

export type Level = "SHADOW" | "SUGGEST" | "ACT_NOTIFY" | "ACT";
export type Outcome = "RECORDED" | "REVIEW" | "EXECUTED" | "BLOCKED" | "FAILED";
export type DeskState = "OFF" | "SHADOW" | "LIVE";

/** Actions that may never be proposed, whatever the SOP says (hard rules 1 and 2). */
const FORBIDDEN = new Set(["cancel", "reschedule", "change_tests", "refund", "message_patient", "call_patient"]);
const ALLOWED_TRANSITIONS = new Set(["PHLEBO_STARTED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "PHLEBO_NO_SHOW", "PATIENT_MISSED"]);

export type GuardContext = {
  journeyId: string | null;
  orderId: number;
  labId: number | null;
  storeId: number | null;
  sopVersionId?: string | null;
};

export type GuardResult = { actionId: string; outcome: Outcome; level: Level; blockedBy?: string };

type Settings = { pausedAll: boolean; pausedDesks: string[]; pausedLabIds: number[]; pausedStoreIds: number[] };

export async function loadGuardState(): Promise<{ settings: Settings; desks: Map<string, DeskState> }> {
  const [settings, rows] = await Promise.all([
    prisma.agentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } }),
    prisma.agentDeskState.findMany({ select: { desk: true, scopeKind: true, scopeId: true, state: true } }),
  ]);
  return {
    settings: { pausedAll: settings.pausedAll, pausedDesks: settings.pausedDesks, pausedLabIds: settings.pausedLabIds, pausedStoreIds: settings.pausedStoreIds },
    desks: new Map(rows.map((r) => [`${r.desk}:${r.scopeKind}:${r.scopeId}`, r.state as DeskState])),
  };
}

export type GuardState = Awaited<ReturnType<typeof loadGuardState>>;

function deskStateFor(state: GuardState, action: ProposedAction, ctx: GuardContext): DeskState {
  const scopeKind = action.desk === "STORE" ? "STORE" : "LAB";
  const scopeId = scopeKind === "STORE" ? ctx.storeId : ctx.labId;
  if (scopeId == null) return "OFF";
  return state.desks.get(`${action.desk}:${scopeKind}:${scopeId}`) ?? "OFF";
}

/** Phase 0: the autonomy matrix is not built yet; everything is shadow. */
function levelFor(_action: ProposedAction, _ctx: GuardContext): Level {
  return "SHADOW";
}

export function hardRuleViolation(action: ProposedAction): string | null {
  if (FORBIDDEN.has(action.action)) return `hard rule: agents never ${action.action}`;
  if (action.action === "status_write" as string) {
    const to = String((action.params as { to?: unknown }).to ?? "");
    if (!ALLOWED_TRANSITIONS.has(to)) return `hard rule: transition ${to || "(none)"} is not on the allowed list`;
  }
  return null;
}

/** Decide and record one action. Never throws on a duplicate: a repeat is reported as BLOCKED. */
export async function guard(action: ProposedAction, ctx: GuardContext, state: GuardState): Promise<GuardResult> {
  let level: Level = levelFor(action, ctx);
  let outcome: Outcome = "RECORDED";
  let blockedBy: string | undefined;

  const violation = hardRuleViolation(action);
  if (violation) { outcome = "BLOCKED"; blockedBy = violation; }
  else if (state.settings.pausedAll) { outcome = "BLOCKED"; blockedBy = "kill switch: everything paused"; }
  else if (state.settings.pausedDesks.includes(action.desk)) { outcome = "BLOCKED"; blockedBy = `kill switch: ${action.desk} desk paused`; }
  else if (ctx.labId != null && state.settings.pausedLabIds.includes(ctx.labId)) { outcome = "BLOCKED"; blockedBy = "kill switch: lab paused"; }
  else if (ctx.storeId != null && state.settings.pausedStoreIds.includes(ctx.storeId)) { outcome = "BLOCKED"; blockedBy = "kill switch: store paused"; }
  else {
    const desk = deskStateFor(state, action, ctx);
    if (desk === "OFF") { outcome = "BLOCKED"; blockedBy = `desk ${action.desk} is off for this ${action.desk === "STORE" ? "store" : "lab"}`; }
    else if (desk === "SHADOW") { level = "SHADOW"; outcome = "RECORDED"; }
    else {
      // LIVE: the autonomy level decides. Phase 0 has no executors, so even LIVE records.
      outcome = level === "SHADOW" ? "RECORDED" : level === "SUGGEST" ? "REVIEW" : "RECORDED";
    }
  }

  try {
    const row = await prisma.agentAction.create({
      data: {
        journeyId: ctx.journeyId, orderId: ctx.orderId, desk: action.desk, action: action.action,
        params: action.params as Prisma.InputJsonValue, reason: action.reason, evidenceIds: [],
        sopVersionId: ctx.sopVersionId ?? null, level, outcome, blockedBy: blockedBy ?? null, idemKey: action.idemKey,
      },
      select: { id: true },
    });
    return { actionId: row.id, outcome, level, blockedBy };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.agentAction.findUnique({ where: { idemKey: action.idemKey }, select: { id: true } });
      return { actionId: existing?.id ?? "", outcome: "BLOCKED", level, blockedBy: "already done (idempotency key)" };
    }
    throw error;
  }
}
