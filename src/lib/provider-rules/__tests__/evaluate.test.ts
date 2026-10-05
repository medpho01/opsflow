import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRule, planOrder, triggerMoment, nextWindowOpening, summaryDue, summaryMatches, conditionMatches } from "../evaluate";
import { BUILT_IN_RULES } from "../builtins";
import { statusesBefore, milestoneTiming } from "../migrate";
import { EMPTY_LEDGER, type LedgerState, type MessageRule, type RuleConversation, type RuleLab, type RuleOrder } from "../types";

const IST = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);

/** A built-in as the engine sees it after seeding. */
function builtIn(key: string, overrides: Partial<MessageRule> = {}): MessageRule {
  const def = BUILT_IN_RULES.find((rule) => rule.builtInKey === key)!;
  return {
    id: key, builtInKey: key, name: def.name, description: null, isActive: true, version: 1,
    kind: (def.kind as MessageRule["kind"]) ?? "ORDER",
    allowedLabIds: [], excludedLabIds: [], allowedOrderTypes: [],
    integrationTypes: (def.integrationTypes as MessageRule["integrationTypes"]) ?? ["NON_API"],
    triggerCondition: def.triggerCondition,
    conversationStatusIn: (def.conversationStatusIn as string[]) ?? [],
    factConditions: (def.factConditions as MessageRule["factConditions"]) ?? [],
    introduces: def.introduces ?? false,
    onlyIfIntroduced: def.onlyIfIntroduced ?? true,
    onlyNewSinceLabConfigured: def.onlyNewSinceLabConfigured ?? false,
    notAfterAppointment: def.notAfterAppointment ?? false,
    stopOnAnswer: def.stopOnAnswer ?? true,
    action: (def.action as MessageRule["action"]) ?? "SEND",
    recipient: (def.recipient as MessageRule["recipient"]) ?? "LAB",
    templateKey: def.templateKey, pollKey: def.pollKey ?? null, priority: def.priority ?? 4,
    repeatEveryMinutes: def.repeatEveryMinutes ?? null, maxSends: def.maxSends ?? 1, catchUpMinutes: def.catchUpMinutes ?? 30,
    sendWindowStartHour: null, sendWindowEndHour: null, milestoneLabel: null,
    summaryHour: def.summaryHour ?? null, summaryMinute: def.summaryMinute ?? null,
    summaryScope: (def.summaryScope as MessageRule["summaryScope"]) ?? null, skipWhenEmpty: def.skipWhenEmpty ?? true,
    ...overrides,
  };
}

const lab: RuleLab = { labId: 7, labName: "Lab 7", integrationType: "NON_API", createdAt: at("2026-10-01T00:00:00Z"), quietWindowMinutes: 10 };
const order = (overrides: Partial<RuleOrder> = {}): RuleOrder => ({
  id: 101, labId: 7, orderType: "HOME_SAMPLE", orderStatus: "CREATED",
  createdAt: at("2026-10-06T04:00:00Z"), statusUpdatedAt: at("2026-10-06T04:00:00Z"),
  appointmentTime: at("2026-10-07T03:00:00Z"), patientName: "P", phleboName: null, phleboNumber: null, metadata: {},
  ...overrides,
});
const waiting: RuleConversation = { id: "w", status: "WAITING_FOR_LAB_CONFIRMATION", introduced: true, lastMessageAt: null };
const none = new Set<string>();
type Extra = Partial<{ conversation: RuleConversation | undefined; ledger: LedgerState; lab: RuleLab; facts: Set<string> }>;
const decide = (rule: MessageRule, o: RuleOrder, now: string, extra: Extra = {}) =>
  decideRule(rule, o, { lab, conversation: waiting, ledger: EMPTY_LEDGER, facts: none, now: at(now), timeZone: IST, ...extra });

describe("new-order message", () => {
  it("goes as soon as the order is placed and opens the conversation", () => {
    const decision = decide(builtIn("NEW_ORDER"), order(), "2026-10-06T04:00:30Z", { conversation: undefined });
    assert.deepEqual([decision.kind, decision.kind === "SEND" && decision.needsConversation], ["SEND", true]);
  });
  it("not twice, and not for orders placed before the lab was configured", () => {
    assert.equal(decide(builtIn("NEW_ORDER"), order(), "2026-10-06T04:00:30Z").kind, "SKIP");
    assert.equal(decide(builtIn("NEW_ORDER"), order({ createdAt: at("2026-09-20T00:00:00Z") }), "2026-10-06T04:00:30Z", { conversation: undefined }).kind, "SKIP");
  });
  it("an order noticed hours late still reaches the lab the same day", () => {
    assert.equal(decide(builtIn("NEW_ORDER"), order(), "2026-10-06T09:00:00Z", { conversation: undefined }).kind, "SEND");
  });
  it("is the one message sent when several are due together", () => {
    const plan = planOrder([builtIn("REMINDER_1H"), builtIn("NEW_ORDER")], order({ createdAt: at("2026-10-06T03:00:00Z") }), {
      lab, conversation: undefined, facts: none, now: at("2026-10-06T04:00:30Z"), timeZone: IST, ledgerFor: () => EMPTY_LEDGER,
    });
    assert.equal(plan.send?.rule.builtInKey, "NEW_ORDER");
  });
});

describe("reminders", () => {
  it("1h reminder: due 1 hour after the order while unconfirmed", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T04:59:00Z").kind, "SKIP");
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:00:30Z").kind, "SEND");
  });
  it("stops once LabStack shows the order confirmed", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order({ orderStatus: "ORDER_SCHEDULED" }), "2026-10-06T05:01:00Z").kind, "SKIP");
  });
  it("never after the appointment, and only for orders the lab was told about", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order({ appointmentTime: at("2026-10-06T04:30:00Z") }), "2026-10-06T05:01:00Z").kind, "SKIP");
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:01:00Z", { conversation: undefined }).kind, "SKIP");
  });
  it("only for the lab types in scope", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:01:00Z", { lab: { ...lab, integrationType: "API" } }).kind, "SKIP");
  });
});

describe("status check", () => {
  const preConfig = order({ createdAt: at("2026-09-20T00:00:00Z"), orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-06T04:00:00Z") });
  it("goes 30 min after the appointment, opening a conversation if there is none", () => {
    const decision = decide(builtIn("STATUS_CHECK"), preConfig, "2026-10-06T04:30:30Z", { conversation: undefined });
    assert.deepEqual([decision.kind, decision.kind === "SEND" && decision.needsConversation], ["SEND", true]);
  });
  it("is skipped once the sample is collected — in LabStack or by the lab's reply", () => {
    assert.equal(decide(builtIn("STATUS_CHECK"), { ...preConfig, orderStatus: "SAMPLE_COLLECTED" }, "2026-10-06T04:30:30Z").kind, "SKIP");
    assert.equal(decide(builtIn("STATUS_CHECK"), preConfig, "2026-10-06T04:30:30Z", { facts: new Set(["sample_collected"]) }).kind, "SKIP");
  });
});

describe("phlebo checks", () => {
  const confirmed = order({ orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-06T08:00:00Z") });
  it("asks for a phlebo 2 h before, and repeats every 30 min until one is named", () => {
    const rule = builtIn("ASSIGN_PHLEBO", { isActive: true });
    assert.equal(decide(rule, confirmed, "2026-10-06T06:00:30Z").kind, "SEND");
    assert.equal(decide(rule, confirmed, "2026-10-06T06:20:00Z", { ledger: { count: 1, lastAt: at("2026-10-06T06:00:30Z"), answered: false } }).kind, "WAIT");
    assert.equal(decide(rule, confirmed, "2026-10-06T06:31:00Z", { ledger: { count: 1, lastAt: at("2026-10-06T06:00:30Z"), answered: false } }).kind, "SEND");
    assert.equal(decide(rule, confirmed, "2026-10-06T06:31:00Z", { facts: new Set(["phlebo_name"]) }).kind, "SKIP");
    assert.equal(decide(rule, { ...confirmed, orderStatus: "PHLEBO_ASSIGNED" }, "2026-10-06T06:00:30Z").kind, "SKIP");
  });
  it("a poll answer or reply stops the repeats", () => {
    const rule = builtIn("ASSIGN_PHLEBO", { isActive: true });
    assert.equal(decide(rule, confirmed, "2026-10-06T06:31:00Z", { ledger: { count: 1, lastAt: at("2026-10-06T06:00:30Z"), answered: true } }).kind, "SKIP");
  });
});

describe("report chase", () => {
  const collected = order({ orderStatus: "SAMPLE_COLLECTED", appointmentTime: at("2026-10-05T04:00:00Z") });
  it("12 h after the appointment, until the report is shared", () => {
    const rule = builtIn("REPORT_CHASE", { isActive: true });
    assert.equal(decide(rule, collected, "2026-10-05T16:00:30Z").kind, "SEND");
    assert.equal(decide(rule, collected, "2026-10-05T16:00:30Z", { facts: new Set(["report_shared"]) }).kind, "SKIP");
  });
});

describe("retroactive changes", () => {
  it("a moment older than the catch-up window is recorded as missed, not sent", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T06:00:00Z").kind, "MISS");
  });
  it("an edited timing applies on the next decision", () => {
    const edited = builtIn("REMINDER_1H", { triggerCondition: { statusIn: ["PENDING", "CREATED"], minutesSinceCreated: 30 } });
    assert.equal(decide(edited, order(), "2026-10-06T04:31:00Z").kind, "SEND");
  });
});

describe("conditions", () => {
  it("'status is not' and an empty 'status is' work together", () => {
    assert.equal(conditionMatches({ statusIn: [], statusNotIn: ["PHLEBO_ASSIGNED"] }, order(), at("2026-10-06T05:00:00Z")).matches, true);
    assert.equal(conditionMatches({ statusIn: [], statusNotIn: ["CREATED"] }, order(), at("2026-10-06T05:00:00Z")).matches, false);
  });
  it("the trigger moment is the latest timing field", () => {
    assert.equal(triggerMoment({ statusIn: [], minutesSinceCreated: 60, minutesBeforeAppointment: 1440 }, order()).toISOString(), "2026-10-06T05:00:00.000Z");
  });
});

describe("send window", () => {
  const rule = builtIn("REMINDER_1H", { sendWindowStartHour: 8, sendWindowEndHour: 21 });
  const late = order({ createdAt: at("2026-10-06T17:00:00Z"), statusUpdatedAt: at("2026-10-06T17:00:00Z"), appointmentTime: at("2026-10-08T03:00:00Z") });
  it("waits overnight, then sends at the opening instead of counting the night as late", () => {
    assert.equal(decide(rule, late, "2026-10-06T18:01:00Z").kind, "WAIT");
    assert.equal(nextWindowOpening(rule, at("2026-10-06T18:00:00Z"), IST).toISOString(), "2026-10-07T02:30:00.000Z");
    assert.equal(decide(rule, late, "2026-10-07T02:40:00Z").kind, "SEND");
  });
});

describe("one message per order per tick", () => {
  const ctx = { lab, conversation: waiting, facts: none, now: at("2026-10-06T05:00:30Z"), timeZone: IST, ledgerFor: () => EMPTY_LEDGER };
  it("the most urgent rule wins; the quiet window holds back all but P0", () => {
    assert.equal(planOrder([builtIn("REMINDER_1H"), builtIn("REMINDER_1H", { id: "urgent", priority: 0 })], order(), ctx).send?.rule.id, "urgent");
    const recent = { ...waiting, lastMessageAt: at("2026-10-06T04:55:00Z") };
    assert.equal(planOrder([builtIn("REMINDER_1H")], order(), { ...ctx, conversation: recent }).send, null);
  });
});

describe("summaries", () => {
  const rule = builtIn("SUMMARY_TOMORROW");
  it("are due from their local time, once, within the catch-up window", () => {
    assert.equal(summaryDue(rule, at("2026-10-06T13:29:00Z"), IST, false), false); // 18:59 IST
    assert.equal(summaryDue(rule, at("2026-10-06T13:30:00Z"), IST, false), true); // 19:00 IST
    assert.equal(summaryDue(rule, at("2026-10-06T13:35:00Z"), IST, true), false);
    assert.equal(summaryDue(rule, at("2026-10-06T17:00:00Z"), IST, false), false); // 22:30, too late
  });
  it("tomorrow's list holds tomorrow's appointments only", () => {
    const now = at("2026-10-06T13:30:00Z");
    assert.equal(summaryMatches(rule, order({ appointmentTime: at("2026-10-07T03:00:00Z") }), none, now, IST), true);
    assert.equal(summaryMatches(rule, order({ appointmentTime: at("2026-10-06T10:00:00Z") }), none, now, IST), false);
  });
  it("pending reports: collected over 12 h ago and not shared", () => {
    const pending = builtIn("SUMMARY_PENDING_REPORTS");
    const now = at("2026-10-06T04:30:00Z");
    const o = order({ orderStatus: "SAMPLE_PROCESSED", appointmentTime: at("2026-10-05T03:00:00Z") });
    assert.equal(summaryMatches(pending, o, none, now, IST), true);
    assert.equal(summaryMatches(pending, o, new Set(["report_shared"]), now, IST), false);
  });
});

describe("converting the delivery-deadline watchers", () => {
  it("'still before the milestone' becomes a status list", () => {
    assert.deepEqual(statusesBefore("PHLEBO_ASSIGNED"), ["PENDING", "CREATED", "ORDER_SCHEDULED", "RESCHEDULED"]);
    assert.ok(statusesBefore("REPORT_UPLOADED").includes("SAMPLE_PROCESSED"));
  });
  it("anchors become Task-Rule timings", () => {
    assert.deepEqual(milestoneTiming("ORDER_CREATED", 120), { minutesSinceCreated: 120 });
    assert.deepEqual(milestoneTiming("APPOINTMENT_TIME", 60), { minutesAfterAppointment: 60 });
    assert.deepEqual(milestoneTiming("APPOINTMENT_TIME", -30), { minutesBeforeAppointment: 30 });
  });
});
