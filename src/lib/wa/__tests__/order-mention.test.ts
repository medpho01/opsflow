import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { namesAnOrder } from "../order-mention";

describe("a console message to a lab must name an order (27 Oct 2026)", () => {
  it("an order id, a lab reference, a booking id or a phone counts", () => {
    assert.ok(namesAnOrder("93412 please share this complete report"));
    assert.ok(namesAnOrder("BLR6372925 - status?"));
    assert.ok(namesAnOrder("VL3D7E71 - this sample was collected"));
    assert.ok(namesAnOrder("19468357 - phlebo no show"));
    assert.ok(namesAnOrder("Dolly · 8956017262 kindly update the collection status"));
  });
  it("a mention alone, or a bare question, does not", () => {
    assert.equal(namesAnOrder("@157140018823280 Kindly update the sample collection status ?"), false);
    assert.equal(namesAnOrder("any update on this?"), false);
    assert.equal(namesAnOrder(""), false);
  });
});
