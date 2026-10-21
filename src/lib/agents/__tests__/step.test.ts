import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { step, fingerprint, classifyChange, type StepInput, type JourneyState } from "../journey/step";
import { checkpointDefs, offsetsFor, type OrderSnapshot } from "../journey/policy";

const at = (iso: string) => new Date(iso);
const H = 3_600_000;

const order = (o: Partial<OrderSnapshot> = {}): OrderSnapshot => ({
  id: 92288, orderType: "HOME_SAMPLE", orderStatus: "ORDER_SCHEDULED",
  appointmentTime: at("2026-10-21T02:00:00Z"), // 7:30 am IST
  labId: 14, storeId: 6, createdAt: at("2026-10-20T10:00:00Z"), statusUpdatedAt: at("2026-10-20T10:05:00Z"),
  phleboName: "", patientName: "P", labName: "Lab", storeName: "Store", ...o,
});

/** Run a wake, then feed its output back in as the next wake's journey. */
function wake(input: Partial<StepInput> & { order: OrderSnapshot; now: Date }, prev?: ReturnType<typeof step>) {
  return step({ journey: prev?.journey ?? null, checkpoints: prev?.checkpoints ?? [], events: [], ...input });
}

describe("checkpoint policy", () => {
  it("home sample: 6 checkpoints, phlebo at slot − 2 h by default and slot − 30 min for a last-moment lab", () => {
    const defs = checkpointDefs("HOME_SAMPLE");
    assert.deepEqual(defs.map((d) => d.name), ["confirmed", "phlebo_assigned", "phlebo_reached", "sample_collected", "sample_at_lab", "report_delivered"]);
    const o = order();
    const phlebo = defs.find((d) => d.name === "phlebo_assigned")!;
    assert.equal(phlebo.dueAt(o, offsetsFor(14))!.getTime(), o.appointmentTime!.getTime() - 2 * H);
    assert.equal(phlebo.dueAt(o, offsetsFor(4))!.getTime(), o.appointmentTime!.getTime() - 0.5 * H);
  });
  it("other order types get their own sets", () => {
    assert.equal(checkpointDefs("CENTER_VISIT")[1].name, "patient_visited");
    assert.equal(checkpointDefs("KIT_BASED").length, 6);
    assert.deepEqual(checkpointDefs("CAMP").map((d) => d.name), ["samples_received", "report_delivered"]);
  });
});

describe("opening a journey", () => {
  it("sets checkpoints, waits on the lab for the next one, and records the console change", () => {
    const out = wake({ order: order(), now: at("2026-10-20T12:00:00Z") });
    assert.equal(out.journey.health, "ON_TRACK");
    assert.deepEqual(out.journey.waitingFor, { what: "phlebo_assigned", from: "LAB" });
    assert.equal(out.checkpoints.find((c) => c.name === "confirmed")?.status, "MET");
    assert.equal(out.newEvents[0].kind, "console_change");
    assert.deepEqual(out.newEvents[0].payload.changes, ["OPENED"]);
    assert.equal(out.journey.plan.filter((p) => p.state === "DONE").length, 1);
    assert.equal(out.journey.plan.find((p) => p.state === "NOW")?.id, "phlebo_assigned");
    assert.equal(out.actions.length, 0);
  });
  it("an unconfirmed order waits on the lab to confirm; a placeholder lab waits on ops", () => {
    const o = order({ orderStatus: "CREATED" });
    assert.deepEqual(wake({ order: o, now: at("2026-10-20T10:30:00Z") }).journey.waitingFor, { what: "confirmed", from: "LAB" });
    assert.deepEqual(wake({ order: order({ orderStatus: "CREATED", labId: 1 }), now: at("2026-10-20T10:30:00Z") }).journey.waitingFor, { what: "confirmed", from: "OPS" });
  });
});

describe("health and the next check", () => {
  it("at risk within 15 min of due, breached after, with next_check_at just before due", () => {
    const o = order();
    const early = wake({ order: o, now: at("2026-10-20T23:00:00Z") }); // phlebo due 00:00Z
    assert.equal(early.journey.health, "ON_TRACK");
    assert.equal(early.journey.nextCheckAt!.toISOString(), "2026-10-20T23:45:00.000Z");
    const close = wake({ order: o, now: at("2026-10-20T23:50:00Z") }, early);
    assert.equal(close.journey.health, "AT_RISK");
    const late = wake({ order: o, now: at("2026-10-21T00:10:00Z") }, close);
    assert.equal(late.journey.health, "BREACHED");
    assert.equal(late.checkpoints.find((c) => c.name === "phlebo_assigned")?.status, "BREACHED");
  });
  it("a breached lab checkpoint proposes one ask, idempotent across wakes", () => {
    const o = order();
    const first = wake({ order: o, now: at("2026-10-21T00:10:00Z") });
    assert.equal(first.actions.length, 1);
    assert.equal(first.actions[0].action, "ask");
    assert.equal(first.actions[0].desk, "LAB");
    assert.equal(first.journey.attempts.phlebo_assigned, 1);
    const again = wake({ order: o, now: at("2026-10-21T00:20:00Z") }, first);
    assert.equal(again.actions.length, 0, "no second ask on the same rung");
  });
});

describe("the console moving", () => {
  it("phlebo assigned by the API meets the checkpoint and moves the wait to collection", () => {
    const o = order();
    const before = wake({ order: o, now: at("2026-10-20T23:00:00Z") });
    const after = wake({ order: order({ orderStatus: "PHLEBO_ASSIGNED", phleboName: "R", statusUpdatedAt: at("2026-10-21T01:30:00Z") }), now: at("2026-10-21T01:31:00Z") }, before);
    assert.equal(after.checkpoints.find((c) => c.name === "phlebo_assigned")?.status, "MET");
    assert.equal(after.checkpoints.find((c) => c.name === "phlebo_assigned")?.metAt?.toISOString(), "2026-10-21T01:30:00.000Z");
    assert.deepEqual(after.journey.waitingFor, { what: "phlebo_reached", from: "LAB" });
    assert.deepEqual(after.newEvents[0].payload.changes, ["STATUS_PROGRESS", "PHLEBO_NAMED"]);
  });
  it("collected implies the earlier checkpoints and starts the report clock", () => {
    const o = order();
    const before = wake({ order: o, now: at("2026-10-20T23:00:00Z") });
    const collected = wake({ order: order({ orderStatus: "SAMPLE_COLLECTED", statusUpdatedAt: at("2026-10-21T02:20:00Z") }), now: at("2026-10-21T02:21:00Z") }, before);
    assert.equal(collected.checkpoints.find((c) => c.name === "phlebo_reached")?.status, "MET");
    assert.equal(collected.checkpoints.find((c) => c.name === "phlebo_assigned")?.status, "MET");
    assert.equal(collected.checkpoints.find((c) => c.name === "sample_collected")?.status, "MET");
    assert.equal(collected.checkpoints.find((c) => c.name === "report_delivered")?.dueAt.toISOString(), "2026-10-22T02:20:00.000Z");
  });
  it("a reschedule recomputes pre-collection checkpoints, resets attempts and logs old and new due times", () => {
    const o = order();
    const breached = wake({ order: o, now: at("2026-10-21T00:10:00Z") });
    assert.equal(breached.journey.attempts.phlebo_assigned, 1);
    const moved = order({ orderStatus: "RESCHEDULED", appointmentTime: at("2026-10-22T02:00:00Z"), statusUpdatedAt: at("2026-10-21T00:30:00Z") });
    const out = wake({ order: moved, now: at("2026-10-21T00:31:00Z") }, breached);
    assert.ok((out.newEvents[0].payload.changes as string[]).includes("RESCHEDULED"));
    assert.deepEqual(out.journey.attempts, {});
    assert.equal(out.checkpoints.find((c) => c.name === "phlebo_assigned")?.dueAt.toISOString(), "2026-10-22T00:00:00.000Z");
    assert.equal(out.checkpoints.find((c) => c.name === "phlebo_assigned")?.dueSource, "RESET");
    assert.equal(out.journey.health, "ON_TRACK");
    const payload = out.newEvents[0].payload as { dueBefore: Record<string, string>; dueAfter: Record<string, string> };
    assert.notEqual(payload.dueBefore.phlebo_assigned, payload.dueAfter.phlebo_assigned);
  });
  it("cancelled closes the journey and proposes nothing", () => {
    const o = order();
    const before = wake({ order: o, now: at("2026-10-21T00:10:00Z") });
    const out = wake({ order: order({ orderStatus: "CANCELED" }), now: at("2026-10-21T00:40:00Z") }, before);
    assert.ok(out.journey.closedAt);
    assert.equal(out.journey.closeReason, "CANCELLED");
    assert.equal(out.actions.length, 0);
    assert.equal(out.newEvents.at(-1)?.kind, "closed");
  });
  it("patient missed keeps the journey open, waiting on ops for a new slot", () => {
    const o = order();
    const before = wake({ order: o, now: at("2026-10-21T00:10:00Z") });
    const out = wake({ order: order({ orderStatus: "PATIENT_MISSED" }), now: at("2026-10-21T03:00:00Z") }, before);
    assert.equal(out.journey.closedAt, null);
    assert.equal(out.journey.waitingFor?.from, "OPS");
    assert.ok(out.journey.subStates.includes("patient_missed"));
  });
});

describe("people", () => {
  it("a take-over pauses the agent for 2 h: it observes and proposes nothing, then resumes", () => {
    const o = order();
    const before = wake({ order: o, now: at("2026-10-20T23:00:00Z") });
    const taken = step({ now: at("2026-10-21T00:10:00Z"), order: o, journey: before.journey, checkpoints: before.checkpoints,
      events: [{ kind: "takeover", at: at("2026-10-21T00:05:00Z"), actor: "PERSON:7", payload: { userId: 7 } }] });
    assert.equal(taken.journey.ownerUserId, 7);
    assert.equal(taken.journey.health, "BREACHED");
    assert.equal(taken.actions.length, 0);
    const resumed = wake({ order: o, now: at("2026-10-21T02:10:00Z") }, taken);
    assert.equal(resumed.journey.ownerUserId, null);
    assert.equal(resumed.actions.length, 1);
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

// Keep the type in use so a changed JourneyState shape fails here first.
const _shape: JourneyState | null = null;
void _shape;
