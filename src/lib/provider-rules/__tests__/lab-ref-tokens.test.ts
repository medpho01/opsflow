import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labRefTokens } from "../replies";

describe("lab references in a lab's message", () => {
  it("reads a reference and what was said about it", () => {
    assert.deepEqual(labRefTokens("VL149129 As per update customer not available"), [{ ref: "VL149129", said: "As per update customer not available" }]);
  });
  it("reads several, one per line, and Redcliffe's booking form", () => {
    const t = labRefTokens("VL256E27 SERVICED\nVLCE4679 Rescheduled\nBooking (ID: 19457839)\nsample collected");
    assert.deepEqual(t.map((x) => [x.ref, x.said]), [["VL256E27", "SERVICED"], ["VLCE4679", "Rescheduled"], ["19457839", "sample collected"]]);
  });
  it("ignores words and phone numbers", () => {
    assert.deepEqual(labRefTokens("serviced, please call 9876543210"), []);
  });
});
