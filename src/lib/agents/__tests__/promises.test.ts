import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePromiseTime, FACT_TO_CHECKPOINT } from "../journey/promises";

const ref = new Date("2026-10-21T04:00:00Z"); // 9:30 am IST
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("reading a time out of a lab reply", () => {
  it("clock times today, pm by default for 1–7 without a marker", () => {
    assert.equal(iso(parsePromiseTime("report by 6 pm", ref)), "2026-10-21T12:30:00.000Z");
    assert.equal(iso(parsePromiseTime("by 6", ref)), "2026-10-21T12:30:00.000Z");
    assert.equal(iso(parsePromiseTime("reaching 10:15 am", ref)), "2026-10-21T04:45:00.000Z");
    assert.equal(iso(parsePromiseTime("18:00", ref)), "2026-10-21T12:30:00.000Z");
    assert.equal(iso(parsePromiseTime("11 baje", ref)), "2026-10-21T05:30:00.000Z");
  });
  it("durations from now", () => {
    assert.equal(iso(parsePromiseTime("in 20 min", ref)), "2026-10-21T04:20:00.000Z");
    assert.equal(iso(parsePromiseTime("within 2 hrs", ref)), "2026-10-21T06:00:00.000Z");
    assert.equal(iso(parsePromiseTime("half an hour", ref)), "2026-10-21T04:30:00.000Z");
  });
  it("tomorrow and parts of the day", () => {
    assert.equal(iso(parsePromiseTime("tomorrow 8 am", ref)), "2026-10-22T02:30:00.000Z");
    assert.equal(iso(parsePromiseTime("kal", ref)), "2026-10-22T04:30:00.000Z");
    assert.equal(iso(parsePromiseTime("by evening", ref)), "2026-10-21T12:30:00.000Z");
  });
  it("a time already passed today means tomorrow; no time means null", () => {
    assert.equal(iso(parsePromiseTime("by 8 am", ref)), "2026-10-22T02:30:00.000Z");
    assert.equal(parsePromiseTime("will check", ref), null);
    assert.equal(parsePromiseTime("ok", ref), null);
  });
  it("fact kinds map to the checkpoint they answer", () => {
    assert.equal(FACT_TO_CHECKPOINT.eta.checkpoint, "phlebo_reached");
    assert.equal(FACT_TO_CHECKPOINT.report_shared.promise, "report");
  });
});
