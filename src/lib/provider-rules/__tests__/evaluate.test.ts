import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRule, planOrder, triggerMoment, nextWindowOpening, summaryDue, summaryMatches, conditionMatches } from "../evaluate";
import { BUILT_IN_RULES } from "../builtins";
import { statusesBefore, milestoneTiming, milestoneStatuses, milestoneCondition } from "../migrate";
import { batchIntentOf, releaseAt, currentSlot, splitBatchReply, itemLine, shortWhen } from "../batching";
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

describe("the confirmation ladder stops on a text 'ok'", () => {
  const confirmed = new Set(["confirmed"]);
  it("every rung gates on the `confirmed` reply fact", () => {
    for (const key of ["REMINDER_1H", "REMINDER_3H", "ESCALATION_5H", "APPT_24H", "APPT_2H", "APPT_30M", "APPT_10M"]) {
      const rule = builtIn(key);
      assert.ok(rule.factConditions.some((f) => f.kind === "confirmed" && f.present === false), key);
    }
  });
  it("one reply stops the next rungs, not only the one it answered", () => {
    const o = order({ createdAt: at("2026-10-06T04:00:00Z") });
    // 3 h 10 min after the order, still PENDING in LabStack, no reply: the 3 h reminder goes.
    assert.equal(decide(builtIn("REMINDER_3H"), o, "2026-10-06T07:10:00Z").kind, "SEND");
    // The lab wrote "ok" to the 1 h reminder: the 3 h reminder and the 5 h escalation stay quiet…
    const skip3 = decide(builtIn("REMINDER_3H"), o, "2026-10-06T07:10:00Z", { facts: confirmed });
    assert.equal(skip3.kind, "SKIP");
    assert.match((skip3 as { reason: string }).reason, /confirmed/);
    assert.equal(decide(builtIn("ESCALATION_5H"), o, "2026-10-06T09:10:00Z", { facts: confirmed }).kind, "SKIP");
    assert.equal(decide(builtIn("APPT_2H"), o, "2026-10-07T01:00:30Z", { facts: confirmed }).kind, "SKIP");
    // …while the status check after the visit still asks (confirmation ≠ collection).
    assert.equal(decide(builtIn("STATUS_CHECK"), o, "2026-10-07T03:30:30Z", { facts: confirmed }).kind, "SEND");
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
  it("a deadline counted from the previous milestone only counts once that milestone is done", () => {
    // "Sample delivered within 3 h of collection": a scheduled order is not late for delivery.
    assert.deepEqual(milestoneStatuses("SAMPLE_DELIVERED", "PREV_MILESTONE_COMPLETED"), ["SAMPLE_COLLECTED"]);
    assert.deepEqual(milestoneStatuses("REPORT_UPLOADED", "PREV_MILESTONE_COMPLETED"), ["SAMPLE_DELIVERED", "SAMPLE_PROCESSED"]);
    assert.deepEqual(milestoneStatuses("PHLEBO_ASSIGNED", "PREV_MILESTONE_COMPLETED"), ["ORDER_SCHEDULED", "RESCHEDULED"]);
    assert.deepEqual(milestoneStatuses("SAMPLE_COLLECTED", "APPOINTMENT_TIME"), statusesBefore("SAMPLE_COLLECTED"));
  });
  it("collection, delivery and report deadlines never fall before the appointment", () => {
    assert.deepEqual(milestoneCondition("SAMPLE_DELIVERED", "PREV_MILESTONE_COMPLETED", 180),
      { statusIn: ["SAMPLE_COLLECTED"], minutesSinceStatusUpdated: 180, minutesAfterAppointment: 0 });
    assert.deepEqual(milestoneCondition("SAMPLE_COLLECTED", "APPOINTMENT_TIME", 30).minutesAfterAppointment, 30);
    // Before-the-visit stages keep their own timing.
    assert.equal(milestoneCondition("PHLEBO_ASSIGNED", "APPOINTMENT_TIME", -60).minutesAfterAppointment, undefined);
  });
  it("anchors become Task-Rule timings", () => {
    assert.deepEqual(milestoneTiming("ORDER_CREATED", 120), { minutesSinceCreated: 120 });
    assert.deepEqual(milestoneTiming("APPOINTMENT_TIME", 60), { minutesAfterAppointment: 60 });
    assert.deepEqual(milestoneTiming("APPOINTMENT_TIME", -30), { minutesBeforeAppointment: 30 });
  });
});

describe("combined messages", () => {
  it("which rules combine, and with what", () => {
    assert.equal(batchIntentOf(builtIn("STATUS_CHECK")), "STATUS");
    assert.equal(batchIntentOf(builtIn("REMINDER_1H")), "UNCONFIRMED");
    assert.equal(batchIntentOf(builtIn("REMINDER_3H")), "UNCONFIRMED");
    assert.equal(batchIntentOf(builtIn("ESCALATION_5H")), "ESCALATION");
    assert.equal(batchIntentOf(builtIn("REPORT_CHASE")), "REPORT");
    // Never combined: the new-order message, urgent (P0) rules.
    assert.equal(batchIntentOf(builtIn("NEW_ORDER")), null);
    assert.equal(batchIntentOf(builtIn("APPT_10M")), null);
    // Close to the visit: straight away, never held for a slot.
    assert.equal(batchIntentOf(builtIn("APPT_30M")), null);
    assert.equal(batchIntentOf(builtIn("PHLEBO_ETA")), null);
    assert.equal(batchIntentOf(builtIn("ASSIGN_PHLEBO")), "PHLEBO");
    // A custom rule combines with itself only.
    assert.equal(batchIntentOf(builtIn("STATUS_CHECK", { id: "r1", templateKey: "MY_TEMPLATE" })), "RULE:r1");
  });

  it("a daily rhythm per ask, inside working hours", () => {
    const ist = (x: string) => new Date(`${x}+05:30`);
    // Status checks: 11:00, 13:30, 16:00, 18:30.
    assert.deepEqual(releaseAt("STATUS", ist("2026-10-12T09:05:00"), IST), ist("2026-10-12T11:00:00"));
    assert.deepEqual(releaseAt("STATUS", ist("2026-10-12T11:00:00"), IST), ist("2026-10-12T11:00:00"));
    assert.deepEqual(releaseAt("STATUS", ist("2026-10-12T11:01:00"), IST), ist("2026-10-12T13:30:00"));
    // Phlebo asks from 08:30: never at 05:00 again.
    assert.deepEqual(releaseAt("PHLEBO", ist("2026-10-12T05:00:00"), IST), ist("2026-10-12T08:30:00"));
    // Reports at 10:30 and 16:30; after the last slot, tomorrow's first.
    assert.deepEqual(releaseAt("REPORT", ist("2026-10-12T10:40:00"), IST), ist("2026-10-12T16:30:00"));
    assert.deepEqual(releaseAt("REPORT", ist("2026-10-12T19:00:00"), IST), ist("2026-10-13T10:30:00"));
    assert.deepEqual(releaseAt("UNCONFIRMED", ist("2026-10-12T22:10:00"), IST), ist("2026-10-13T09:00:00"));
    assert.deepEqual(currentSlot(ist("2026-10-12T09:44:59"), IST), ist("2026-10-12T09:30:00"));
  });

  it("an item waits for its slot, and waiting is never a miss", () => {
    const rule = builtIn("STATUS_CHECK");
    const o = order({ orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-12T03:05:00Z") }); // 8:35 IST → due 9:05
    const ctx = (now: string) => ({
      lab, conversation: undefined, ledger: EMPTY_LEDGER, facts: new Set<string>(), now: at(now), timeZone: IST,
      releaseAt: (r: MessageRule, dueAt: Date) => releaseAt(batchIntentOf(r)!, dueAt, IST),
    });
    assert.equal(decideRule(rule, o, ctx("2026-10-12T04:00:00Z")).kind, "WAIT"); // 9:30
    assert.equal(decideRule(rule, o, ctx("2026-10-12T05:30:00Z")).kind, "SEND"); // 11:00, the slot
    assert.equal(decideRule(rule, o, ctx("2026-10-13T03:30:00Z")).kind, "SEND"); // held by the day cap: still going next morning
    assert.equal(decideRule(rule, o, ctx("2026-10-13T06:30:00Z")).kind, "MISS"); // more than a day late
  });

  it("reads numbered replies, 'all …', order ids — and never guesses", () => {
    const items = [{ n: 1, orderId: 88704 }, { n: 2, orderId: 88711 }, { n: 3, orderId: 88730 }];
    const read = (text: string) => Object.fromEntries(splitBatchReply(text, items));
    assert.deepEqual(read("1 done, 2 not home, 3 at 5 pm"), { 1: "done", 2: "not home", 3: "at 5 pm" });
    assert.deepEqual(read("1,2 collected. 3 rescheduled to tomorrow"), { 1: "collected", 2: "collected", 3: "rescheduled to tomorrow" });
    assert.deepEqual(read("1) collected\n2) stuck in traffic"), { 1: "collected", 2: "stuck in traffic" });
    assert.deepEqual(read("All done"), { 1: "done", 2: "done", 3: "done" });
    assert.deepEqual(read("88711 patient not available"), { 2: "patient not available" });
    assert.deepEqual(read("ok"), {});
    assert.deepEqual(read("4 done"), {});
    assert.deepEqual(Object.fromEntries(splitBatchReply("collected", [{ n: 1, orderId: 5 }])), { 1: "collected" });
  });

  it("one short line per order", () => {
    const now = at("2026-10-12T03:30:00Z"); // 9:00 IST
    assert.equal(shortWhen(at("2026-10-12T01:30:00Z"), now, IST), "7:00 am");
    assert.equal(shortWhen(at("2026-10-13T01:30:00Z"), now, IST), "tomorrow 7:00 am");
    assert.equal(
      itemLine("STATUS", { n: 1, orderId: 88704, patientName: "Manjusha K", appointment: at("2026-10-12T01:30:00Z") }, now, IST),
      "1. #88704 · Manjusha · 7:00 am",
    );
    assert.equal(
      itemLine("UNCONFIRMED", { n: 2, orderId: 88711, patientName: "Ravi", appointment: at("2026-10-13T02:00:00Z"), confirmUrl: "https://x/c" }, now, IST),
      "2. #88711 · Ravi · tomorrow 7:30 am\n    https://x/c",
    );
    assert.equal(
      itemLine("REPORT", { n: 3, orderId: 88501, patientName: "Kavita", appointment: at("2026-10-11T02:30:00Z") }, now, IST),
      "3. #88501 · Kavita · visit yesterday 8:00 am (25 h ago)",
    );
  });
});
