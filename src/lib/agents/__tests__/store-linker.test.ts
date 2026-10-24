import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { explicitOrderIds } from "../store/reader";

describe("store linker — ids the store wrote", () => {
  it("reads 5–6 digit order ids, with or without #, and keeps their order", () => {
    assert.deepEqual(explicitOrderIds("93312 - please reschedule to tomorrow at 8 am"), [93312]);
    assert.deepEqual(explicitOrderIds("#92832 slots for urine sample? also 92326"), [92832, 92326]);
  });
  it("ignores phone numbers, mentions and lab references", () => {
    assert.deepEqual(explicitOrderIds("@71086741958691 did the customer request to cancel?"), []);
    assert.deepEqual(explicitOrderIds("call 9876543210 or +91 98765 43210"), []);
    assert.deepEqual(explicitOrderIds("BLR6362207 is scheduled"), []);
  });
  it("finds nothing in a bare question, so the thread's order is never assumed", () => {
    assert.deepEqual(explicitOrderIds("any update on this??"), []);
  });
});
