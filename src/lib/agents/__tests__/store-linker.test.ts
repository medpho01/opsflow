import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { explicitOrderIds, modelIdsToTrust } from "../store/reader";

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

describe("the model's order ids (26 Oct 2026)", () => {
  it("an id the model took from the group's other messages is never added", () => {
    assert.deepEqual(modelIdsToTrust([90188], "90301 - RNR", null), []);
    assert.deepEqual(modelIdsToTrust([90412], "90807 90811 Please share the invoices", null), []);
  });
  it("an id from the message the store quoted is added", () => {
    assert.deepEqual(modelIdsToTrust([90250], "please check this", "90250 - please schedule urine sample collection"), [90250]);
  });
  it("ids already in the message are not repeated", () => {
    assert.deepEqual(modelIdsToTrust([90301], "90301 - RNR", "90301 earlier"), []);
  });
});

describe("two order ids written like a phone number (26 Oct 2026)", () => {
  it("'93807 93811 please share the invoices' is two orders", () => {
    assert.deepEqual(explicitOrderIds("93807 93811 Please share the invoices"), [93807, 93811]);
    assert.deepEqual(explicitOrderIds("please check the status for these three VIP orders 93807 93811 93759"), [93807, 93811, 93759]);
  });
  it("a phone number is still not an order", () => {
    assert.deepEqual(explicitOrderIds("contact number 98765 43210"), []);
    assert.deepEqual(explicitOrderIds("call 98765 43210 please"), []);
    assert.deepEqual(explicitOrderIds("+91 98765 43210"), []);
    assert.deepEqual(explicitOrderIds("Mobile: 98765-43210"), []);
  });
});
