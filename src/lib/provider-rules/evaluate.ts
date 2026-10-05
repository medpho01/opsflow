/**
 * The message-rules decision: for one rule and one open order, right now —
 * send, wait, record a miss, or nothing.
 *
 * Pure: no Prisma, no Date.now(), no env. The engine does the I/O; this is the
 * part that decides whether a real lab's phone buzzes, so it is tested alone.
 *
 * The rule's TriggerCondition is evaluated by the SAME function Task Rules use
 * (engine/taskCreator.evaluateTrigger), so "N min after created", "N min
 * before/after the appointment", "N min since the status changed" and field
 * conditions mean exactly what they mean there.
 */
import type { RawOrder } from "@/lib/engine/labstack";
import { evaluateTrigger } from "@/lib/engine/taskCreator";
import type { TriggerCondition } from "@/types";
import type { LedgerState, MessageRule, RuleConversation, RuleLab, RuleOrder } from "./types";

export type RuleDecision =
  /** The rule does not apply to this order now (scope, condition, or done). */
  | { kind: "SKIP"; reason: string }
  /** It applies, but not this minute (repeat gap, send window, conversation not started). */
  | { kind: "WAIT"; reason: string }
  /** Its first moment is older than the catch-up window — record it, do not send. */
  | { kind: "MISS"; occurrence: number; moment: Date; reason: string }
  /** Send occurrence N now. `needsShell` = create a check-only conversation first. */
  | { kind: "SEND"; occurrence: number; moment: Date; needsShell: boolean };

const MS_PER_MIN = 60_000;
const addMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MS_PER_MIN);

/** Statuses a check-only conversation is created in, mirroring LabStack. */
export function shellConversationStatus(orderStatus: string): "WAITING_FOR_LAB_CONFIRMATION" | "LAB_ACCEPTED" {
  return orderStatus === "PENDING" || orderStatus === "CREATED" ? "WAITING_FOR_LAB_CONFIRMATION" : "LAB_ACCEPTED";
}

/**
 * When the condition first became true by its timing fields: the latest of
 * the moments its timing fields describe. A rule with no timing field fires
 * on entering the status, so its moment is the last status change.
 */
export function triggerMoment(cond: TriggerCondition, order: RuleOrder): Date {
  const moments: Date[] = [];
  if (typeof cond.minutesSinceCreated === "number") moments.push(addMinutes(order.createdAt, cond.minutesSinceCreated));
  if (typeof cond.minutesSinceStatusUpdated === "number" && order.statusUpdatedAt) {
    moments.push(addMinutes(order.statusUpdatedAt, cond.minutesSinceStatusUpdated));
  }
  if (order.appointmentTime) {
    if (typeof cond.minutesBeforeAppointment === "number") moments.push(addMinutes(order.appointmentTime, -cond.minutesBeforeAppointment));
    if (typeof cond.minutesAfterAppointment === "number") moments.push(addMinutes(order.appointmentTime, cond.minutesAfterAppointment));
  }
  if (moments.length === 0) return order.statusUpdatedAt ?? order.createdAt;
  return new Date(Math.max(...moments.map((m) => m.getTime())));
}

function localHour(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone }).format(at);
  return Number(hour) % 24;
}

/** start..end in local hours; start > end wraps midnight; equal or unset = always open. */
export function inSendWindow(rule: Pick<MessageRule, "sendWindowStartHour" | "sendWindowEndHour">, at: Date, timeZone: string): boolean {
  const { sendWindowStartHour: start, sendWindowEndHour: end } = rule;
  if (start == null || end == null || start === end) return true;
  const hour = localHour(at, timeZone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * The first instant at or after `at` inside the send window. Steps in
 * quarter-hours, because local hours do not start on UTC hours everywhere —
 * 08:00 in India is 02:30 UTC.
 */
export function nextWindowOpening(rule: Pick<MessageRule, "sendWindowStartHour" | "sendWindowEndHour">, at: Date, timeZone: string): Date {
  if (inSendWindow(rule, at, timeZone)) return at;
  const QUARTER = 15 * MS_PER_MIN;
  const start = Math.floor(at.getTime() / QUARTER) * QUARTER;
  for (let step = 1; step <= 48 * 4; step += 1) {
    const candidate = new Date(start + step * QUARTER);
    if (inSendWindow(rule, candidate, timeZone)) return candidate;
  }
  return at;
}

export type DecideContext = {
  /** The lab's config, or undefined when the lab is not configured (or not live). */
  lab: RuleLab | undefined;
  conversation: RuleConversation | undefined;
  ledger: LedgerState;
  now: Date;
  timeZone: string;
};

export function decideRule(rule: MessageRule, order: RuleOrder, ctx: DecideContext): RuleDecision {
  const { lab, conversation, ledger, now, timeZone } = ctx;

  // ── Scope ──────────────────────────────────────────────────────────────
  if (!rule.isActive) return { kind: "SKIP", reason: "rule paused" };
  if (!lab) return { kind: "SKIP", reason: "lab not configured" };
  if (rule.allowedLabIds.length > 0 && !rule.allowedLabIds.includes(order.labId)) return { kind: "SKIP", reason: "lab not in scope" };
  if (rule.excludedLabIds.includes(order.labId)) return { kind: "SKIP", reason: "lab excluded" };
  if (rule.allowedOrderTypes.length > 0 && !rule.allowedOrderTypes.includes(order.orderType)) {
    return { kind: "SKIP", reason: `order type ${order.orderType} not in scope` };
  }
  if (rule.requiresLabSetting && !lab[rule.requiresLabSetting]) return { kind: "SKIP", reason: `${rule.requiresLabSetting} is off for this lab` };
  if (rule.notAfterAppointment && order.appointmentTime && order.appointmentTime.getTime() <= now.getTime()) {
    return { kind: "SKIP", reason: "appointment has passed" };
  }

  // ── Condition (the Task Rule evaluator) ───────────────────────────────
  const verdict = evaluateTrigger(order as unknown as RawOrder, rule.triggerCondition, now);
  if (!verdict.matches) return { kind: "SKIP", reason: verdict.reason };

  // ── Already done? ─────────────────────────────────────────────────────
  const repeats = rule.repeatEveryMinutes != null && rule.repeatEveryMinutes > 0;
  const limit = repeats ? rule.maxSends : 1;
  if (ledger.count >= limit) return { kind: "SKIP", reason: "all sends done" };

  // ── Conversation ──────────────────────────────────────────────────────
  let needsShell = false;
  let conversationStatus = conversation?.status ?? null;
  if (rule.onlyIfIntroduced && !conversation?.introduced) {
    return { kind: "SKIP", reason: "the lab was never sent this order" };
  }
  if (!conversation) {
    // Only orders placed before the lab was configured get a check-only
    // conversation here. A newer order without one is the poller's to start —
    // creating it here would swallow the new-order message.
    if (order.createdAt.getTime() >= lab.createdAt.getTime()) return { kind: "WAIT", reason: "waiting for the new-order message" };
    needsShell = true;
    conversationStatus = shellConversationStatus(order.orderStatus);
  }
  if (rule.conversationStatusIn.length > 0 && !rule.conversationStatusIn.includes(conversationStatus!)) {
    return { kind: "SKIP", reason: `conversation is ${conversationStatus}` };
  }

  // ── Timing ────────────────────────────────────────────────────────────
  const occurrence = ledger.count + 1;
  const moment = triggerMoment(rule.triggerCondition, order);
  if (occurrence === 1) {
    // Measured from the first moment the rule was ALLOWED to send, so a send
    // window does not turn every overnight trigger into a miss.
    const allowedFrom = nextWindowOpening(rule, moment, timeZone);
    const lateBy = (now.getTime() - allowedFrom.getTime()) / MS_PER_MIN;
    if (lateBy > rule.catchUpMinutes) {
      return { kind: "MISS", occurrence, moment, reason: `due ${Math.round(lateBy)} min ago, catch-up window is ${rule.catchUpMinutes} min` };
    }
  } else if (ledger.lastAt && now.getTime() - ledger.lastAt.getTime() < rule.repeatEveryMinutes! * MS_PER_MIN) {
    return { kind: "WAIT", reason: "repeat interval not reached" };
  }
  if (!inSendWindow(rule, now, timeZone)) return { kind: "WAIT", reason: "outside the send window" };

  return { kind: "SEND", occurrence, moment, needsShell };
}

export type OrderPlan = {
  /** The one message to send for this order this tick, if any. */
  send: { rule: MessageRule; decision: Extract<RuleDecision, { kind: "SEND" }> } | null;
  /** Misses to record. */
  misses: Array<{ rule: MessageRule; decision: Extract<RuleDecision, { kind: "MISS" }> }>;
  /** Why the would-be winner is held back, if it is. */
  heldBack: string | null;
};

/**
 * At most one message per order per tick: the most urgent rule (lowest P)
 * wins, the rest wait for a later tick. The lab's quiet window holds back
 * everything but a P0 when this order was messaged moments ago.
 */
export function planOrder(
  rules: MessageRule[],
  order: RuleOrder,
  ctx: Omit<DecideContext, "ledger"> & { ledgerFor: (ruleId: string) => LedgerState },
): OrderPlan {
  const plan: OrderPlan = { send: null, misses: [], heldBack: null };
  const candidates: Array<{ rule: MessageRule; decision: Extract<RuleDecision, { kind: "SEND" }> }> = [];
  for (const rule of rules) {
    const decision = decideRule(rule, order, { ...ctx, ledger: ctx.ledgerFor(rule.id) });
    if (decision.kind === "SEND") candidates.push({ rule, decision });
    else if (decision.kind === "MISS") plan.misses.push({ rule, decision });
  }
  if (candidates.length === 0) return plan;

  candidates.sort((a, b) =>
    a.rule.priority - b.rule.priority || a.decision.moment.getTime() - b.decision.moment.getTime());
  const winner = candidates[0];

  const quiet = ctx.lab?.quietWindowMinutes ?? 0;
  const last = ctx.conversation?.lastMessageAt;
  if (last && quiet > 0 && winner.rule.priority > 0 && ctx.now.getTime() - last.getTime() < quiet * MS_PER_MIN) {
    plan.heldBack = `quiet window: last message ${Math.round((ctx.now.getTime() - last.getTime()) / MS_PER_MIN)} min ago`;
    return plan;
  }
  plan.send = winner;
  return plan;
}
