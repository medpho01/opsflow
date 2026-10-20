import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractWithPatterns } from "../reply-extract";

const facts = (text: string) => Object.fromEntries(extractWithPatterns(text).map((f) => [f.kind, f.value]));
const asked = (text: string) => Object.fromEntries(extractWithPatterns(text, { confirmation: true }).map((f) => [f.kind, f.value]));

describe("reading lab replies (pattern reader)", () => {
  it("phlebo name, number and ETA in one line", () => {
    assert.deepEqual(facts("Phlebo Ramesh 9876543210, reaching by 9:15 am"), {
      phlebo_phone: "9876543210", phlebo_name: "Ramesh", eta: "9:15 am",
    });
  });
  it("an ETA as a duration", () => {
    assert.equal(facts("on the way, ETA 20 mins")["eta"], "20 mins");
  });
  it("report shared beats sample collected", () => {
    assert.deepEqual(Object.keys(facts("Report shared on mail")), ["report_shared"]);
    assert.deepEqual(Object.keys(facts("sample collected")), ["sample_collected"]);
  });
  it("patient not available, can't do it, delays, reschedules", () => {
    assert.ok(facts("patient not available at home")["patient_unavailable"]);
    assert.ok(facts("we cannot take this order today")["cannot_fulfil"]);
    assert.ok(facts("running late due to traffic")["delay_reason"]);
    assert.ok(facts("rescheduled to tomorrow 10am")["new_appointment_time"]);
  });
  it("anything else is kept as a note", () => {
    assert.deepEqual(facts("ok noted"), { note: "ok noted" });
  });
});

describe("a yes to 'please confirm'", () => {
  it("'ok', 'okay', 'done', 'confirmed', 'haan', 'ho jayega', 'will do', 'theek hai', 👍 confirm an unconfirmed ask", () => {
    for (const text of ["ok", "Okay", "done", "confirmed", "Confirm", "haan", "ho jayega", "will do", "theek hai", "👍", "✅", "ok will do", "Ok done 👍"]) {
      assert.equal(asked(text)["confirmed"], "yes", text);
    }
  });
  it("is not read on asks that did not want a confirmation", () => {
    assert.equal(facts("ok")["confirmed"], undefined);
    assert.equal(facts("done")["confirmed"], undefined);
    assert.deepEqual(facts("ok"), { note: "ok" });
  });
  it("a no is not a yes", () => {
    assert.equal(asked("ok cannot do this one")["confirmed"], undefined);
    assert.ok(asked("ok cannot do this one")["cannot_fulfil"]);
    assert.equal(asked("done, patient not available")["confirmed"], undefined);
    assert.equal(asked("nahi ho payega")["confirmed"], undefined);
    assert.equal(asked("reschedule to tomorrow")["confirmed"], undefined);
  });
  it("keeps the other facts alongside", () => {
    const got = asked("ok, phlebo Ramesh 9876543210 will reach by 9:15 am");
    assert.equal(got["confirmed"], "yes");
    assert.equal(got["phlebo_name"], "Ramesh");
    assert.equal(got["eta"], "9:15 am");
  });
});
