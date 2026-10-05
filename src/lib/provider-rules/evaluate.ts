/**
 * The message-rules decisions, pure: no Prisma, no Date.now(), no env.
 *
 *   decideRule     — one ORDER rule × one open order, right now: send, wait,
 *                    record a miss, or nothing.
 *   planOrder      — all ORDER rules × one order: at most one message per tick.
 *   summaryDue     — one SUMMARY rule × one lab: is today's slot open and unsent?
 *   summaryMatches — does an order belong in a summary?
 *
 * The rule's condition is evaluated by the SAME function Task Rules use
 * (engine/taskCreator.evaluateTrigger), plus statusNotIn, so "N min after
 * created", "N min before/after the appointment", "N min since the status
 * changed" and field conditions mean exactly what they mean there.
 */
import type { RawOrder } from "@/lib/engine/labstack";
import { evaluateTrigger } from "@/lib/engine/taskCreator";
import type { LedgerState, MessageRule, RuleCondition, RuleConversation, RuleLab, RuleOrder } from "./types";

export type RuleDecision =
  /** The rule does not apply to this order now (scope, condition, or done). */
  | { kind: "SKIP"; reason: string }
  /** It applies, but not this minute (repeat gap, send window). */
  | { kind: "WAIT"; reason: string }
  /** Its first moment is older than the catch-up window — record it, do not send. */
  | { kind: "MISS"; occurrence: number; moment: Date; reason: string }
  /** Send occurrence N now. `needsConversation` = open one first. */
  | { kind: "SEND"; occurrence: number; moment: Date; needsConversation: boolean };

const MS_PER_MIN = 60_000;
const addMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MS_PER_MIN);

/** The conversation state a newly opened conversation starts in, mirroring LabStack. */
export function newConversationStatus(orderStatus: string): "WAITING_FOR_LAB_CONFIRMATION" | "LAB_ACCEPTED" {
  return orderStatus === "PENDING" || orderStatus === "CREATED" ? "WAITING_FOR_LAB_CONFIRMATION" : "LAB_ACCEPTED";
}

/** The Task-Rule condition plus statusNotIn. An empty statusIn means any status. */
export function conditionMatches(cond: RuleCondition, order: RuleOrder, now: Date): { matches: boolean; reason: string } {
  if (cond.statusNotIn?.includes(order.orderStatus)) return { matches: false, reason: `order is ${order.orderStatus}` };
  const effective = { ...cond, statusIn: cond.statusIn?.length ? cond.statusIn : [order.orderStatus] };
  const verdict = evaluateTrigger(order as unknown as RawOrder, effective, now);
  return verdict.matches ? { matches: true, reason: "" } : { matches: false, reason: verdict.reason };
}

/**
 * When the condition first became true by its timing fields: the latest of
 * the moments its timing fields describe. A rule with no timing field fires
 * on entering the status, so its moment is the last status change.
 */
export function triggerMoment(cond: RuleCondition, order: RuleOrder): Date {
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

function localParts(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).formatToParts(at);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24,
    minute: Number(parts.find((p) => p.type === "minute")?.value ?? "0"),
  };
}

/** `2026-10-06` in the operating timezone. */
export function localDayKey(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-CA", { timeZone });
}

/** start..end in local hours; start > end wraps midnight; equal or unset = always open. */
export function inSendWindow(rule: Pick<MessageRule, "sendWindowStartHour" | "sendWindowEndHour">, at: Date, timeZone: string): boolean {
  const { sendWindowStartHour: start, sendWindowEndHour: end } = rule;
  if (start == null || end == null || start === end) return true;
  const { hour } = localParts(at, timeZone);
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
  /** Fact kinds the lab has reported for this order (reply understanding). */
  facts: ReadonlySet<string>;
  now: Date;
  timeZone: string;
};

/** Scope checks shared by ORDER and SUMMARY rules. */
export function inScope(rule: MessageRule, labId: number, lab: RuleLab | undefined): string | null {
  if (!rule.isActive) return "rule paused";
  if (!lab) return "lab not configured";
  if (rule.integrationTypes.length > 0 && !rule.integrationTypes.includes(lab.integrationType)) return `lab receives orders via ${lab.integrationType}`;
  if (rule.allowedLabIds.length > 0 && !rule.allowedLabIds.includes(labId)) return "lab not in scope";
  if (rule.excludedLabIds.includes(labId)) return "lab excluded";
  return null;
}

export function decideRule(rule: MessageRule, order: RuleOrder, ctx: DecideContext): RuleDecision {
  const { lab, conversation, ledger, facts, now, timeZone } = ctx;

  // ── Scope ──────────────────────────────────────────────────────────────
  const outOfScope = inScope(rule, order.labId, lab);
  if (outOfScope) return { kind: "SKIP", reason: outOfScope };
  if (rule.allowedOrderTypes.length > 0 && !rule.allowedOrderTypes.includes(order.orderType)) {
    return { kind: "SKIP", reason: `order type ${order.orderType} not in scope` };
  }
  if (rule.onlyNewSinceLabConfigured && order.createdAt.getTime() < lab!.createdAt.getTime()) {
    return { kind: "SKIP", reason: "order placed before the lab was configured" };
  }
  if (rule.notAfterAppointment && order.appointmentTime && order.appointmentTime.getTime() <= now.getTime()) {
    return { kind: "SKIP", reason: "appointment has passed" };
  }

  // ── Condition (the Task Rule evaluator) and reply facts ───────────────
  const condition = conditionMatches(rule.triggerCondition, order, now);
  if (!condition.matches) return { kind: "SKIP", reason: condition.reason };
  for (const fact of rule.factConditions) {
    if (facts.has(fact.kind) !== fact.present) {
      return { kind: "SKIP", reason: fact.present ? `the lab has not reported ${fact.kind}` : `the lab reported ${fact.kind}` };
    }
  }

  // ── Already done or answered? ─────────────────────────────────────────
  const repeats = rule.repeatEveryMinutes != null && rule.repeatEveryMinutes > 0;
  const limit = repeats ? rule.maxSends : 1;
  if (ledger.count >= limit) return { kind: "SKIP", reason: "all sends done" };
  if (rule.stopOnAnswer && ledger.answered) return { kind: "SKIP", reason: "the lab answered" };

  // ── Conversation ──────────────────────────────────────────────────────
  if (rule.introduces && conversation?.introduced) return { kind: "SKIP", reason: "the lab already has this order" };
  if (!rule.introduces && rule.onlyIfIntroduced && !conversation?.introduced) {
    return { kind: "SKIP", reason: "the lab was never sent this order" };
  }
  const conversationStatus = conversation?.status ?? newConversationStatus(order.orderStatus);
  if (rule.conversationStatusIn.length > 0 && !rule.conversationStatusIn.includes(conversationStatus)) {
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

  return { kind: "SEND", occurrence, moment, needsConversation: !conversation };
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
 * At most one message per order per tick: an introduction first, then the
 * most urgent rule (lowest P); the rest wait for a later tick. The lab's quiet
 * window holds back everything but a P0 when this order was messaged moments ago.
 */
export function planOrder(
  rules: MessageRule[],
  order: RuleOrder,
  ctx: Omit<DecideContext, "ledger"> & { ledgerFor: (ruleId: string) => LedgerState },
): OrderPlan {
  const plan: OrderPlan = { send: null, misses: [], heldBack: null };
  const candidates: Array<{ rule: MessageRule; decision: Extract<RuleDecision, { kind: "SEND" }> }> = [];
  for (const rule of rules) {
    if (rule.kind !== "ORDER") continue;
    const decision = decideRule(rule, order, { ...ctx, ledger: ctx.ledgerFor(rule.id) });
    if (decision.kind === "SEND") candidates.push({ rule, decision });
    else if (decision.kind === "MISS") plan.misses.push({ rule, decision });
  }
  if (candidates.length === 0) return plan;

  candidates.sort((a, b) =>
    Number(b.rule.introduces) - Number(a.rule.introduces)
    || a.rule.priority - b.rule.priority
    || a.decision.moment.getTime() - b.decision.moment.getTime());
  const winner = candidates[0];

  const quiet = ctx.lab?.quietWindowMinutes ?? 0;
  const last = ctx.conversation?.lastMessageAt;
  if (!winner.rule.introduces && last && quiet > 0 && winner.rule.priority > 0 && ctx.now.getTime() - last.getTime() < quiet * MS_PER_MIN) {
    plan.heldBack = `quiet window: last message ${Math.round((ctx.now.getTime() - last.getTime()) / MS_PER_MIN)} min ago`;
    return plan;
  }
  plan.send = winner;
  return plan;
}

/** YYYYMMDD of the local day, as the summary ledger's occurrence. */
export function summaryOccurrence(now: Date, timeZone: string): number {
  return Number(localDayKey(now, timeZone).replaceAll("-", ""));
}

/**
 * Is a SUMMARY rule's slot open for a lab right now? Open from its local
 * time for `catchUpMinutes` — after a restart the next tick catches up, but a
 * summary hours late is a wrong message, not a late one.
 */
export function summaryDue(rule: MessageRule, now: Date, timeZone: string, alreadySentToday: boolean): boolean {
  if (rule.kind !== "SUMMARY" || rule.summaryHour == null || alreadySentToday) return false;
  const { hour, minute } = localParts(now, timeZone);
  const minutesPast = hour * 60 + minute - (rule.summaryHour * 60 + (rule.summaryMinute ?? 0));
  return minutesPast >= 0 && minutesPast <= Math.max(rule.catchUpMinutes, 1);
}

/** Does this order belong in this summary? Scope by appointment day, then the rule's condition and facts. */
export function summaryMatches(rule: MessageRule, order: RuleOrder, facts: ReadonlySet<string>, now: Date, timeZone: string): boolean {
  if (rule.allowedOrderTypes.length > 0 && !rule.allowedOrderTypes.includes(order.orderType)) return false;
  if (rule.summaryScope === "APPOINTMENT_TOMORROW" || rule.summaryScope === "APPOINTMENT_TODAY") {
    if (!order.appointmentTime) return false;
    const target = rule.summaryScope === "APPOINTMENT_TODAY" ? now : addMinutes(now, 24 * 60);
    if (localDayKey(order.appointmentTime, timeZone) !== localDayKey(target, timeZone)) return false;
  }
  if (!conditionMatches(rule.triggerCondition, order, now).matches) return false;
  return rule.factConditions.every((fact) => facts.has(fact.kind) === fact.present);
}
