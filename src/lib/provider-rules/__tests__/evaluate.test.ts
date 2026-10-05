import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRule, planOrder, triggerMoment, nextWindowOpening } from "../evaluate";
import { BUILT_IN_RULES, convertLegacyRule } from "../builtins";
import { templateFor } from "../engine";
import type { MessageRule, RuleConversation, RuleLab, RuleOrder } from "../types";
import type { ConfigRow } from "@/lib/non-api-labs/scheduler";
import type { CommunicationRule } from "@/lib/non-api-labs/rules";

const IST = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);

/** A built-in as the engine sees it after seeding. */
function builtIn(key: string, overrides: Partial<MessageRule> = {}): MessageRule {
  const def = BUILT_IN_RULES.find((rule) => rule.builtInKey === key)!;
  return {
    id: key, builtInKey: key, name: def.name, description: null, isActive: true, version: 1, sourceKey: "orders",
    allowedLabIds: [], excludedLabIds: [], allowedOrderTypes: [],
    triggerCondition: def.triggerCondition as MessageRule["triggerCondition"],
    conversationStatusIn: (def.conversationStatusIn as string[]) ?? [],
    onlyIfIntroduced: def.onlyIfIntroduced ?? true,
    notAfterAppointment: def.notAfterAppointment ?? false,
    requiresLabSetting: (def.requiresLabSetting as MessageRule["requiresLabSetting"]) ?? null,
    action: (def.action as MessageRule["action"]) ?? "SEND",
    recipient: (def.recipient as MessageRule["recipient"]) ?? "LAB",
    templateKey: def.templateKey, templateSlot: (def.templateSlot as MessageRule["templateSlot"]) ?? null,
    pollKey: def.pollKey ?? null, priority: def.priority ?? 4,
    repeatEveryMinutes: null, maxSends: 1, catchUpMinutes: 30, sendWindowStartHour: null, sendWindowEndHour: null,
    ...overrides,
  };
}

const lab: RuleLab = {
  labId: 7, createdAt: at("2026-10-01T00:00:00Z"), quietWindowMinutes: 10,
  appointmentRemindersEnabled: false, postAppointmentCheckEnabled: true,
};
const order = (overrides: Partial<RuleOrder> = {}): RuleOrder => ({
  id: 101, labId: 7, orderType: "HOME_SAMPLE", orderStatus: "CREATED",
  createdAt: at("2026-10-06T04:00:00Z"), statusUpdatedAt: at("2026-10-06T04:00:00Z"),
  appointmentTime: at("2026-10-07T03:00:00Z"), patientName: "P", metadata: {},
  ...overrides,
});
const waiting: RuleConversation = { id: "w", status: "WAITING_FOR_LAB_CONFIRMATION", introduced: true, lastMessageAt: null };
const fresh = { count: 0, lastAt: null };
const decide = (rule: MessageRule, o: RuleOrder, now: string, extra: Partial<{ conversation: RuleConversation | undefined; ledger: typeof fresh; lab: RuleLab }> = {}) =>
  decideRule(rule, o, { lab, conversation: waiting, ledger: fresh, now: at(now), timeZone: IST, ...extra });

describe("built-in reminders behave like the legacy ladder", () => {
  it("1h reminder: due 1 hour after the order while unconfirmed", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T04:59:00Z").kind, "SKIP");
    const due = decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:00:30Z");
    assert.equal(due.kind, "SEND");
  });

  it("stops once LabStack shows the order confirmed", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order({ orderStatus: "ORDER_SCHEDULED" }), "2026-10-06T05:01:00Z").kind, "SKIP");
  });

  it("never after the appointment", () => {
    const o = order({ appointmentTime: at("2026-10-06T04:30:00Z") });
    assert.equal(decide(builtIn("REMINDER_1H"), o, "2026-10-06T05:01:00Z").kind, "SKIP");
  });

  it("only for orders the lab was told about", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:01:00Z", { conversation: undefined }).kind, "SKIP");
  });

  it("is sent once", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:05:00Z", { ledger: { count: 1, lastAt: at("2026-10-06T05:00:00Z") } }).kind, "SKIP");
  });

  it("appointment pings follow the lab's switch", () => {
    const o = order({ appointmentTime: at("2026-10-06T07:00:00Z") });
    assert.equal(decide(builtIn("APPT_2H"), o, "2026-10-06T05:00:30Z").kind, "SKIP");
    assert.equal(decide(builtIn("APPT_2H"), o, "2026-10-06T05:00:30Z", { lab: { ...lab, appointmentRemindersEnabled: true } }).kind, "SEND");
  });
});

describe("status check", () => {
  const preConfig = order({ createdAt: at("2026-09-20T00:00:00Z"), orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-06T04:00:00Z") });

  it("goes 30 min after the appointment, even for an order placed before the lab was configured", () => {
    const decision = decide(builtIn("STATUS_CHECK"), preConfig, "2026-10-06T04:30:30Z", { conversation: undefined });
    assert.deepEqual([decision.kind, decision.kind === "SEND" && decision.needsShell], ["SEND", true]);
  });

  it("waits for the poller on a new order that has no conversation yet", () => {
    const newer = order({ createdAt: at("2026-10-06T04:00:00Z"), orderStatus: "ORDER_SCHEDULED", appointmentTime: at("2026-10-06T04:10:00Z") });
    assert.equal(decide(builtIn("STATUS_CHECK"), newer, "2026-10-06T04:40:30Z", { conversation: undefined }).kind, "WAIT");
  });

  it("is skipped once the sample is collected", () => {
    assert.equal(decide(builtIn("STATUS_CHECK"), { ...preConfig, orderStatus: "SAMPLE_COLLECTED" }, "2026-10-06T04:30:30Z").kind, "SKIP");
  });
});

describe("retroactive changes", () => {
  it("a moment older than the catch-up window is recorded as missed, not sent", () => {
    const decision = decide(builtIn("REMINDER_1H"), order(), "2026-10-06T06:00:00Z");
    assert.equal(decision.kind, "MISS");
  });

  it("a moment inside the window is still sent", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T05:20:00Z").kind, "SEND");
  });

  it("a moment still ahead is simply not due yet", () => {
    assert.equal(decide(builtIn("REMINDER_1H"), order(), "2026-10-06T04:20:00Z").kind, "SKIP");
  });

  it("an edited timing applies on the next decision", () => {
    const edited = builtIn("REMINDER_1H", { triggerCondition: { statusIn: ["PENDING", "CREATED"], minutesSinceCreated: 30 } });
    assert.equal(decide(edited, order(), "2026-10-06T04:31:00Z").kind, "SEND");
  });
});

describe("repeats", () => {
  const rule = builtIn("REMINDER_1H", { repeatEveryMinutes: 60, maxSends: 3 });
  it("waits for the interval after the last send", () => {
    assert.equal(decide(rule, order(), "2026-10-06T05:30:00Z", { ledger: { count: 1, lastAt: at("2026-10-06T05:00:00Z") } }).kind, "WAIT");
    const second = decide(rule, order(), "2026-10-06T06:00:30Z", { ledger: { count: 1, lastAt: at("2026-10-06T05:00:00Z") } });
    assert.deepEqual([second.kind, second.kind === "SEND" && second.occurrence], ["SEND", 2]);
  });
  it("stops at the maximum", () => {
    assert.equal(decide(rule, order(), "2026-10-06T09:00:00Z", { ledger: { count: 3, lastAt: at("2026-10-06T07:00:00Z") } }).kind, "SKIP");
  });
});

describe("send window", () => {
  const rule = builtIn("REMINDER_1H", { sendWindowStartHour: 8, sendWindowEndHour: 21 });
  // 22:30 IST order → due 23:30 IST, outside 8–21.
  const late = order({ createdAt: at("2026-10-06T17:00:00Z"), statusUpdatedAt: at("2026-10-06T17:00:00Z"), appointmentTime: at("2026-10-08T03:00:00Z") });
  it("waits overnight instead of sending", () => {
    assert.equal(decide(rule, late, "2026-10-06T18:01:00Z").kind, "WAIT");
  });
  it("sends at the window opening rather than counting the night as late", () => {
    assert.equal(nextWindowOpening(rule, at("2026-10-06T18:00:00Z"), IST).toISOString(), "2026-10-07T02:30:00.000Z");
    assert.equal(decide(rule, late, "2026-10-07T02:40:00Z").kind, "SEND");
  });
});

describe("one message per order per tick", () => {
  const now = at("2026-10-06T05:00:30Z");
  const ctx = { lab, conversation: waiting, now, timeZone: IST, ledgerFor: () => fresh };
  it("the most urgent rule wins", () => {
    const urgent = builtIn("REMINDER_1H", { id: "urgent", priority: 0 });
    const plan = planOrder([builtIn("REMINDER_1H"), urgent], order(), ctx);
    assert.equal(plan.send?.rule.id, "urgent");
  });
  it("the quiet window holds back all but P0", () => {
    const recent = { ...waiting, lastMessageAt: at("2026-10-06T04:55:00Z") };
    assert.equal(planOrder([builtIn("REMINDER_1H")], order(), { ...ctx, conversation: recent }).send, null);
    assert.ok(planOrder([builtIn("REMINDER_1H", { priority: 0 })], order(), { ...ctx, conversation: recent }).send);
  });
});

describe("helpers", () => {
  it("the trigger moment is the latest timing field", () => {
    const o = order();
    assert.equal(triggerMoment({ statusIn: [], minutesSinceCreated: 60, minutesBeforeAppointment: 1440 }, o).toISOString(), "2026-10-06T05:00:00.000Z");
  });

  it("a lab's own template for the slot wins over the rule's", () => {
    const rule = builtIn("REMINDER_3H");
    const standard = { reminderTemplateKey: "NON_API_REMINDER" } as ConfigRow;
    const custom = { reminderTemplateKey: "NON_API_CUSTOM_GENTLE" } as ConfigRow;
    assert.equal(templateFor(rule, standard), "NON_API_URGENT_REMINDER");
    assert.equal(templateFor(rule, custom), "NON_API_CUSTOM_GENTLE");
  });

  it("converts a legacy appointment rule to the matching Task-Rule timing", () => {
    const legacy = {
      id: "x", name: "Imaging nudge", isActive: true, anchor: "APPOINTMENT", action: "SEND_REMINDER", recipient: "LAB",
      templateKey: "NON_API_REMINDER", offsetMinutes: -90, priority: 2, allowedLabIds: [9], allowedOrderTypes: [],
      sendCondition: { sourceStatusIn: ["CREATED"], sendWindow: { startHour: 8, endHour: 20 } },
    } as unknown as CommunicationRule;
    const converted = convertLegacyRule(legacy);
    assert.deepEqual(converted.triggerCondition, { statusIn: ["CREATED"], minutesBeforeAppointment: 90 });
    assert.equal(converted.requiresLabSetting, "appointmentRemindersEnabled");
    assert.equal(converted.sendWindowStartHour, 8);
  });
});
