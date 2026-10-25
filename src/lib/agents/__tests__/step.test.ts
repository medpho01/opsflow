import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { step, fingerprint, classifyChange, sendWindow, type StepInput, type StepOutput } from "../journey/step";
import { checkpointDefs, offsetsFor, type OrderSnapshot } from "../journey/policy";
import { LAB_SOP_V1 } from "../sop/baseline";
import { resolveParams } from "../sop/schema";

const at = (iso: string) => new Date(iso);
const H = 3_600_000;
const IST = "Asia/Kolkata";
const SOP_C = resolveParams(LAB_SOP_V1, { labTier: "C", labId: 2229 });
const SOP_A = resolveParams(LAB_SOP_V1, { labTier: "A", labId: 4 });

const order = (o: Partial<OrderSnapshot> = {}): OrderSnapshot => ({
  id: 92288, orderType: "HOME_SAMPLE", orderStatus: "ORDER_SCHEDULED",
  appointmentTime: at("2026-10-21T02:00:00Z"), // 7:30 am IST
  labId: 2229, storeId: 6, createdAt: at("2026-10-20T10:00:00Z"), statusUpdatedAt: at("2026-10-20T10:05:00Z"),
  phleboName: "", patientName: "P", labName: "Lab", storeName: "Store", ...o,
});

type Opts = Partial<Pick<StepInput, "events" | "sop" | "labTier" | "labSilentHours">>;
function wake(order: OrderSnapshot, now: Date, prev?: StepOutput, opts: Opts = {}): StepOutput {
  return step({ now, order, journey: prev?.journey ?? null, checkpoints: prev?.checkpoints ?? [], events: [], sop: SOP_C, labTier: "C", timeZone: IST, ...opts });
}
const acts = (o: StepOutput) => o.actions.map((a) => a.action);

describe("checkpoint policy", () => {
  it("home sample: 6 checkpoints; phlebo at slot − 2 h by default and slot − 30 min for a last-moment lab", () => {
    const defs = checkpointDefs("HOME_SAMPLE");
    assert.deepEqual(defs.map((d) => d.name), ["confirmed", "phlebo_assigned", "phlebo_reached", "sample_collected", "sample_at_lab", "report_delivered"]);
    const o = order();
    const phlebo = defs.find((d) => d.name === "phlebo_assigned")!;
    assert.equal(phlebo.dueAt(o, offsetsFor(2229))!.getTime(), o.appointmentTime!.getTime() - 2 * H);
    assert.equal(phlebo.dueAt(o, offsetsFor(4))!.getTime(), o.appointmentTime!.getTime() - 0.5 * H);
  });
  it("other order types get their own sets", () => {
    assert.equal(checkpointDefs("CENTER_VISIT")[1].name, "patient_visited");
    assert.equal(checkpointDefs("KIT_BASED").length, 6);
    assert.deepEqual(checkpointDefs("CAMP").map((d) => d.name), ["samples_received", "report_delivered"]);
  });
});

describe("opening a journey", () => {
  it("sets checkpoints, waits on the lab, records the console change, builds the plan", () => {
    const out = wake(order(), at("2026-10-20T12:00:00Z"));
    assert.equal(out.journey.health, "ON_TRACK");
    assert.deepEqual(out.journey.waitingFor, { what: "phlebo_assigned", from: "LAB" });
    assert.equal(out.checkpoints.find((c) => c.name === "confirmed")?.status, "MET");
    assert.deepEqual(out.newEvents[0].payload.changes, ["OPENED"]);
    assert.equal(out.journey.plan.find((p) => p.state === "NOW")?.id, "phlebo_assigned");
    assert.equal(out.actions.length, 0);
  });
  it("placeholder lab waits on ops and gets a find-a-lab task within 72 h of the slot", () => {
    const out = wake(order({ orderStatus: "CREATED", labId: 1 }), at("2026-10-20T10:30:00Z"));
    assert.deepEqual(out.journey.waitingFor, { what: "confirmed", from: "OPS" });
    assert.equal(out.actions[0]?.desk, "INTAKE");
    assert.equal(out.actions[0]?.params.taskType, "AGENT_FIND_LAB");
  });
});

describe("the ladder", () => {
  it("rungs run in SOP order, one per rung gap, with the ask's intent and a send window", () => {
    const o = order();
    const t0 = at("2026-10-21T00:10:00Z"); // phlebo due 00:00Z
    const r1 = wake(o, t0);
    assert.deepEqual(acts(r1), ["ask"]);
    assert.equal(r1.actions[0].params.intent, "PHLEBO");
    assert.equal(r1.actions[0].params.counterparty, "LAB:2229");
    assert.equal(r1.journey.attempts.phlebo_assigned.n, 1);
    const tooSoon = wake(o, at("2026-10-21T00:20:00Z"), r1);
    assert.equal(tooSoon.actions.length, 0, "rung gap not reached");
    const r2 = wake(o, at("2026-10-21T00:41:00Z"), tooSoon);
    assert.deepEqual(acts(r2), ["reminder"]);
    const r3 = wake(o, at("2026-10-21T01:12:00Z"), r2);
    assert.deepEqual(acts(r3), ["manager_whatsapp"]);
    assert.equal(r3.actions[0].params.counterparty, "MANAGER:2229");
    const r4 = wake(o, at("2026-10-21T01:43:00Z"), r3);
    assert.deepEqual(acts(r4), ["create_task"]);
    assert.equal(r4.actions[0].params.taskType, "AGENT_COLLECTION_STUCK");
    const r5 = wake(o, at("2026-10-21T02:14:00Z"), r4);
    assert.deepEqual(acts(r5), ["stuck"]);
    const r6 = wake(o, at("2026-10-21T02:45:00Z"), r5);
    assert.equal(r6.actions.length, 0, "ladder exhausted");
  });
  it("API labs read the portal first — when a portal session is set up; otherwise they are asked in the group", () => {
    const o = order({ labId: 4, appointmentTime: at("2026-10-21T04:00:00Z") }); // 9:30 am IST; Orange assigns at slot − 30, so due 9:00
    const r1 = step({ now: at("2026-10-21T03:35:00Z"), order: o, journey: null, checkpoints: [], events: [], sop: SOP_A, labTier: "A", portalReady: true, timeZone: IST });
    assert.deepEqual(acts(r1), ["portal_read"]);
    const r2 = step({ now: at("2026-10-21T03:35:00Z"), order: o, journey: null, checkpoints: [], events: [], sop: SOP_A, labTier: "A", timeZone: IST });
    assert.deepEqual(acts(r2), ["ask"]);
    // Ten minutes before the visit an API lab is not asked for a phlebo: LabStack has not caught up.
    const r3 = step({ now: at("2026-10-21T03:50:00Z"), order: o, journey: null, checkpoints: [], events: [], sop: SOP_A, labTier: "A", timeZone: IST });
    assert.deepEqual(acts(r3), []);
  });
  it("an API lab is never asked to confirm: the order is already in its system", () => {
    const o = order({ labId: 4, orderStatus: "PENDING" });
    const r = step({ now: at("2026-10-20T10:00:00Z"), order: o, journey: null, checkpoints: [], events: [], sop: SOP_A, labTier: "A", timeZone: IST });
    assert.equal(r.checkpoints.find((c) => c.name === "confirmed")?.status, "WAIVED");
    assert.ok(!r.actions.some((a) => a.params.checkpoint === "confirmed"));
  });
  it("what the lab says is relayed to the store at once: collected, cannot do, rescheduled", () => {
    const o = order();
    const fact = (kind: string, value: string, id: string) => ({ kind: "fact", at: at("2026-10-21T02:30:00Z"), actor: "LAB", payload: { kind, value, confidence: 0.9, source: "lab_reply", attributedBy: "REPLY_TO", factId: id } });
    const r = wake(o, at("2026-10-21T02:31:00Z"), undefined, { events: [fact("sample_collected", "collected", "f1"), fact("patient_unavailable", "customer not responding", "f2")] as never });
    const alerts = r.actions.filter((a) => a.action === "store_alert").map((a) => a.params.template);
    assert.ok(alerts.includes("STORE_COLLECTED")); assert.ok(alerts.includes("STORE_PATIENT_UNREACHABLE"));
    assert.equal(alerts.filter((t) => t === "STORE_PATIENT_UNREACHABLE").length, 1); // the SOP's own hand-off, not twice
  });
  it("a store asking for slots gets the lab's usual hours when known", () => {
    const o = order();
    const msg = { kind: "store_message", at: at("2026-10-20T10:00:00Z"), actor: "STORE", payload: { intent: "slot", text: "slots please", messageId: "m-slot", waMsgId: "w9" } };
    const r = wake(o, at("2026-10-20T10:01:00Z"), undefined, { events: [msg] as never, slotSummary: "Lab usually collects between 6 am and 11 am (most bookings 7 am–8 am)" } as never);
    const reply = r.actions.find((a) => a.action === "store_reply");
    assert.ok(String(reply?.params.text).includes("usually collects between 6 am and 11 am"));
  });
  it("a pre-visit checkpoint still open long after the visit becomes one task, never a chase", () => {
    const o = order({ appointmentTime: at("2026-10-19T02:30:00Z"), orderStatus: "ORDER_SCHEDULED" });
    const r1 = wake(o, at("2026-10-24T13:45:00Z"));
    assert.deepEqual(acts(r1), ["create_task"]);
    assert.equal(r1.actions[0].params.cause, "VISIT_PASSED_NO_UPDATE");
    const r2 = wake(o, at("2026-10-24T15:45:00Z"), r1);
    assert.deepEqual(acts(r2), []);
  });
  it("a visit within 90 min makes the ask urgent", () => {
    const o = order();
    const r = wake(o, at("2026-10-21T01:00:00Z"));
    assert.equal(r.actions[0].params.urgent, true);
  });
  it("a lab's answer holds the ladder; a promise with a time moves the due time, and a broken promise counts", () => {
    const o = order();
    const r1 = wake(o, at("2026-10-21T00:10:00Z"));
    // Lab replies "phlebo reaching by 7:45" → promise on phlebo_reached; and "assigned Ramesh" answers phlebo_assigned.
    const r2 = wake(o, at("2026-10-21T00:15:00Z"), r1, { events: [
      { kind: "fact", at: at("2026-10-21T00:14:00Z"), actor: "LAB", payload: { kind: "phlebo_name", value: "Ramesh", confidence: 0.8, source: "lab_reply", attributedBy: "REPLY_TO", factId: "f1" } },
    ] });
    assert.equal(r2.actions.length, 0, "answered: no reminder while the hold lasts");
    assert.ok(r2.journey.attempts.phlebo_assigned.answeredAt);
    // Later the console shows the phlebo; now the lab promises the ETA.
    const assigned = order({ orderStatus: "PHLEBO_ASSIGNED", phleboName: "Ramesh", statusUpdatedAt: at("2026-10-21T00:30:00Z") });
    const r3 = wake(assigned, at("2026-10-21T02:20:00Z"), r2, { events: [
      { kind: "fact", at: at("2026-10-21T02:18:00Z"), actor: "LAB", payload: { kind: "eta", value: "reaching by 8:15 am", confidence: 0.9, source: "lab_reply", attributedBy: "REPLY_TO", factId: "f2" } },
    ] });
    const reached = r3.checkpoints.find((c) => c.name === "phlebo_reached")!;
    assert.equal(reached.dueSource, "PROMISE");
    assert.equal(reached.dueAt.toISOString(), "2026-10-21T03:00:00.000Z"); // 8:15 IST + 15 min grace
    assert.equal(r3.newEvents.find((e) => e.kind === "promise")?.payload.kind, "eta");
    assert.equal(r3.journey.health, "ON_TRACK");
    // 8:31 IST: nothing collected, promise broken.
    const r4 = wake(assigned, at("2026-10-21T03:01:00Z"), r3);
    assert.equal(r4.journey.brokenPromises, 1);
    assert.equal(r4.newEvents.find((e) => e.kind === "promise_broken")?.payload.checkpoint, "phlebo_reached");
    assert.equal(r4.journey.health, "BREACHED");
  });
});

describe("evidence and hand-offs", () => {
  it("a confident 'collected' reply proposes a status write; a weak one goes to review", () => {
    const o = order({ orderStatus: "PHLEBO_ASSIGNED", phleboName: "R" });
    const r1 = wake(o, at("2026-10-21T02:00:00Z"));
    const strong = wake(o, at("2026-10-21T02:30:00Z"), r1, { events: [{ kind: "fact", at: at("2026-10-21T02:29:00Z"), actor: "LAB", payload: { kind: "sample_collected", value: "1 collected", confidence: 0.9, source: "lab_reply", attributedBy: "REPLY_TO", factId: "f3" } }] });
    const write = strong.actions.find((a) => a.action === "status_write")!;
    assert.equal(write.params.to, "SAMPLE_COLLECTED");
    assert.equal(write.params.meetsBar, true);
    const weak = wake(o, at("2026-10-21T02:30:00Z"), r1, { events: [{ kind: "fact", at: at("2026-10-21T02:29:00Z"), actor: "LAB", payload: { kind: "sample_collected", value: "done", confidence: 0.6, source: "lab_reply", attributedBy: "ONLY_OPEN", factId: "f4" } }] });
    assert.equal(weak.actions.find((a) => a.action === "status_write")!.params.meetsBar, false);
  });
  it("patient unreachable alerts the store; a report-shared reply creates an upload task", () => {
    const o = order({ orderStatus: "PHLEBO_ASSIGNED", phleboName: "R" });
    const r1 = wake(o, at("2026-10-21T02:00:00Z"));
    const out = wake(o, at("2026-10-21T02:30:00Z"), r1, { events: [
      { kind: "fact", at: at("2026-10-21T02:29:00Z"), actor: "LAB", payload: { kind: "patient_unavailable", value: "phone switched off", confidence: 0.9, source: "lab_reply", attributedBy: "REPLY_TO", factId: "f5" } },
      { kind: "fact", at: at("2026-10-21T02:29:30Z"), actor: "LAB", payload: { kind: "report_shared", value: "report shared on portal", confidence: 0.8, source: "lab_reply", attributedBy: "REPLY_TO", factId: "f6" } },
    ] });
    assert.ok(out.actions.some((a) => a.action === "store_alert" && a.desk === "STORE"));
    assert.ok(out.actions.some((a) => a.action === "create_task" && a.params.taskType === "AGENT_REPORT_UPLOAD"));
  });
});

describe("the store desk", () => {
  const msg = (intent: string, text: string, at_: string) => ({ kind: "store_message", at: at(at_), actor: "STORE", payload: { intent, text, messageId: `m-${intent}`, waMsgId: "w1" } });
  it("answers a status question from the console when it knows", () => {
    const o = order({ orderStatus: "SAMPLE_COLLECTED", statusUpdatedAt: at("2026-10-21T02:20:00Z") });
    const r1 = wake(o, at("2026-10-21T02:21:00Z"));
    const out = wake(o, at("2026-10-21T04:00:00Z"), r1, { events: [msg("status", "92288 status?", "2026-10-21T03:59:00Z")] });
    const reply = out.actions.find((a) => a.action === "store_reply")!;
    assert.equal(reply.params.template, "STORE_STATUS_ANSWER");
    assert.match(String(reply.params.statusLine), /sample collected/);
  });
  it("says 'checking' and chases the lab when it does not know", () => {
    const o = order({ orderStatus: "PHLEBO_ASSIGNED", phleboName: "R" });
    const r1 = wake(o, at("2026-10-21T01:00:00Z"));
    const out = wake(o, at("2026-10-21T03:00:00Z"), r1, { events: [msg("status", "92288 collected?", "2026-10-21T02:59:00Z")] });
    assert.ok(out.actions.some((a) => a.action === "store_reply" && a.params.template === "STORE_CHECKING"));
    assert.ok(out.actions.some((a) => a.action === "ask" && a.params.forStore === true && a.params.urgent === true));
  });
  it("a reschedule request is acknowledged and becomes a task with the slot to verify", () => {
    const o = order();
    const r1 = wake(o, at("2026-10-20T12:00:00Z"));
    const out = wake(o, at("2026-10-20T12:10:00Z"), r1, { events: [msg("reschedule", "91031 kindly reschedule for tomorrow 8 am and confirm", "2026-10-20T12:09:00Z")] });
    assert.ok(out.actions.some((a) => a.action === "ack"));
    const task = out.actions.find((a) => a.action === "create_task")!;
    assert.equal(task.params.taskType, "AGENT_RESCHEDULE");
    assert.equal((task.params.verify as { kind: string }).kind, "slot_equals");
    assert.ok(out.journey.subStates.includes("change_pending"));
  });
});

describe("the console moving", () => {
  it("a reschedule recomputes pre-collection checkpoints, resets attempts, withdraws asks and logs due times", () => {
    const o = order();
    const breached = wake(o, at("2026-10-21T00:10:00Z"));
    assert.equal(breached.journey.attempts.phlebo_assigned.n, 1);
    const moved = order({ orderStatus: "RESCHEDULED", appointmentTime: at("2026-10-22T02:00:00Z"), statusUpdatedAt: at("2026-10-21T00:30:00Z") });
    const out = wake(moved, at("2026-10-21T00:31:00Z"), breached);
    assert.ok((out.newEvents[0].payload.changes as string[]).includes("RESCHEDULED"));
    assert.deepEqual(out.journey.attempts, {});
    assert.equal(out.journey.rescheduleCount, 1);
    assert.equal(out.withdraw.length, 1);
    assert.equal(out.checkpoints.find((c) => c.name === "phlebo_assigned")?.dueSource, "RESET");
    assert.equal(out.journey.health, "ON_TRACK");
  });
  it("cancelled closes the journey and withdraws everything", () => {
    const o = order();
    const before = wake(o, at("2026-10-21T00:10:00Z"));
    const out = wake(order({ orderStatus: "CANCELED" }), at("2026-10-21T00:40:00Z"), before);
    assert.ok(out.journey.closedAt);
    assert.equal(out.actions.length, 0);
    assert.equal(out.withdraw[0].reason, "cancelled");
  });
  it("patient missed keeps the journey open, waiting on ops", () => {
    const o = order();
    const before = wake(o, at("2026-10-21T00:10:00Z"));
    const out = wake(order({ orderStatus: "PATIENT_MISSED" }), at("2026-10-21T03:00:00Z"), before);
    assert.equal(out.journey.closedAt, null);
    assert.equal(out.journey.waitingFor?.from, "OPS");
  });
});

describe("risk and warnings", () => {
  it("an unconfirmed order with a silent lab the evening before is high risk and warns the store", () => {
    const o = order({ orderStatus: "CREATED", appointmentTime: at("2026-10-21T02:30:00Z") }); // 8:00 am tomorrow
    const out = wake(o, at("2026-10-20T13:30:00Z"), undefined, { labSilentHours: 5 }); // 7 pm IST
    assert.equal(out.risk?.level, "HIGH");
    assert.ok(out.actions.some((a) => a.action === "store_warning" && a.desk === "STORE"));
  });
});

describe("people", () => {
  it("a take-over pauses the agent for 2 h, then it resumes", () => {
    const o = order();
    const before = wake(o, at("2026-10-20T23:00:00Z"));
    const taken = wake(o, at("2026-10-21T00:10:00Z"), before, { events: [{ kind: "takeover", at: at("2026-10-21T00:05:00Z"), actor: "PERSON:7", payload: { userId: 7 } }] });
    assert.equal(taken.journey.ownerUserId, 7);
    assert.equal(taken.actions.length, 0);
    const resumed = wake(o, at("2026-10-21T02:10:00Z"), taken);
    assert.equal(resumed.journey.ownerUserId, null);
    assert.equal(resumed.actions.length, 1);
  });
});

describe("send windows (§4.15)", () => {
  const ask = SOP_C.asks.phlebo_assigned;
  it("an ask for an early visit goes the evening before, else at 07:00 — never in the night, urgent or not", () => {
    const due = at("2026-10-20T23:00:00Z"); // 4:30 am IST on 21 Oct
    // Known the afternoon before: asked at 20:00 the evening before.
    const e = sendWindow(at("2026-10-20T10:00:00Z"), due, SOP_C, ask, true, false, IST);
    assert.equal(e.from.toISOString(), "2026-10-20T14:30:00.000Z"); // 20:00 IST, 20 Oct
    // Known only at 01:30 IST: waits for 07:00 (the visit at 04:30 is then past; the step turns it into a task).
    const w = sendWindow(at("2026-10-20T20:00:00Z"), due, SOP_C, ask, true, false, IST);
    assert.equal(w.from.toISOString(), "2026-10-21T01:30:00.000Z"); // 07:00 IST
    const u = sendWindow(at("2026-10-20T22:50:00Z"), due, SOP_C, ask, true, true, IST);
    assert.equal(u.from.toISOString(), "2026-10-21T01:30:00.000Z"); // urgent at 04:20 IST still waits for 07:00
  });
  it("an ask not tied to a slot waits for working hours", () => {
    const w = sendWindow(at("2026-10-20T16:00:00Z"), at("2026-10-20T16:00:00Z"), SOP_C, SOP_C.asks.report_delivered, false, false, IST); // 21:30 IST
    assert.equal(w.from.toISOString(), "2026-10-21T03:00:00.000Z"); // 08:30 IST next day
  });
});

describe("fingerprints", () => {
  it("change only on the fields that matter", () => {
    const o = order();
    assert.equal(fingerprint(o), fingerprint({ ...o, patientName: "Someone else" }));
    assert.notEqual(fingerprint(o), fingerprint({ ...o, phleboName: "R" }));
    assert.deepEqual(classifyChange(o, { ...o, labId: 2, orderStatus: "CREATED" }), ["REROUTED", "STATUS_PROGRESS"]);
  });
});
