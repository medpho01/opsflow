import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePollOptions, breachOutcomeOf } from "../poll-definitions";

// These options are read back off a wa_polls row when a vote arrives, and the
// reply is chosen from them. Anything this parser drops becomes an option the
// provider can tap and never hear back from — silently, because a dropped
// option looks identical to a poll that had no reply configured.
describe("parsePollOptions", () => {
  it("keeps a fully specified option", () => {
    const parsed = parsePollOptions([{ label: "Accept", action: "ACCEPT", ack: "Confirmed" }]);
    assert.deepEqual(parsed, [{ label: "Accept", action: "ACCEPT", ack: "Confirmed" }]);
  });

  // The regression: polls sent before replies were configurable stored
  // {label, action} only. Requiring `ack` made every one of those options
  // unmatchable, so a vote moved the order and the provider heard nothing.
  it("keeps a legacy option that predates configurable replies", () => {
    const parsed = parsePollOptions([
      { label: "Accept", action: "ACCEPT" },
      { label: "Cannot fulfil", action: "REJECT" },
    ]);
    assert.equal(parsed.length, 2, "legacy options must survive");
    assert.equal(parsed[0].ack, "", "a legacy option is silent, not missing");
    assert.equal(parsed[0].action, "ACCEPT");
  });

  it("treats a missing action as informational rather than dropping it", () => {
    const parsed = parsePollOptions([{ label: "Delayed", ack: "Noted" }]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].action, null);
  });

  it("drops what genuinely cannot be used", () => {
    const parsed = parsePollOptions([
      { label: "", action: "ACCEPT", ack: "x" },      // unmatchable: no label
      { label: "Bad", action: "EXPLODE", ack: "x" },  // not a real action
      "nonsense",
      null,
    ]);
    assert.deepEqual(parsed, []);
  });

  it("survives a column that is not an array at all", () => {
    assert.deepEqual(parsePollOptions(null), []);
    assert.deepEqual(parsePollOptions({ label: "Accept" }), []);
  });

  it("trims labels, because the vote is matched on exact text", () => {
    assert.equal(parsePollOptions([{ label: "  Accept  ", ack: "" }])[0].label, "Accept");
  });
});

// Breach polls: the tapped option's outcome decides whether chasing pauses,
// stops (Cannot fulfil -> Ops alert) or carries on. Losing it silently turns a
// lab's answer back into "acknowledged and ignored".
describe("breach poll outcomes", () => {
  it("keeps an explicit outcome through parsing", () => {
    const [option] = parsePollOptions([{ label: "Already done", action: null, ack: "ok", outcome: "DONE" }]);
    assert.equal(option.outcome, "DONE");
  });

  it("drops an unknown outcome instead of carrying junk", () => {
    const [option] = parsePollOptions([{ label: "Maybe", action: null, ack: "", outcome: "SOMETIMES" }]);
    assert.equal("outcome" in option, false);
  });

  it("uses the explicit outcome first", () => {
    assert.equal(breachOutcomeOf({ label: "Relabelled", action: null, outcome: "ON_THE_WAY" }), "ON_THE_WAY");
  });

  it("falls back to the seeded labels for polls sent before outcomes existed", () => {
    assert.equal(breachOutcomeOf({ label: "Already done", action: null }), "DONE");
    assert.equal(breachOutcomeOf({ label: "on the way", action: null }), "ON_THE_WAY");
    assert.equal(breachOutcomeOf({ label: "Delayed", action: null }), "DELAYED");
  });

  it("treats a REJECT option as cannot-fulfil even when relabelled", () => {
    assert.equal(breachOutcomeOf({ label: "Can't do it", action: "REJECT" }), "CANNOT_FULFIL");
  });

  it("returns null for an unknown informational option", () => {
    assert.equal(breachOutcomeOf({ label: "Something else", action: null }), null);
    assert.equal(breachOutcomeOf(null), null);
  });
});
