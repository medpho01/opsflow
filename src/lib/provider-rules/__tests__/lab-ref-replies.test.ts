import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitBatchReply } from "../batching";

// Labs answer by their own reference (25 Oct 2026): Thyrocare "VL336FC5 serviced",
// Redcliffe "Booking (ID: 19457839) sample collected", Orange quoting our line.
const items = [
  { n: 1, orderId: 93942, labRef: "VL336FC5", line: "1. VL336FC5 · #93942 · Anvesh · 98xxxxxx01 · Guntur · 6:00 am" },
  { n: 2, orderId: 94138, labRef: "VLDA5C20", line: "2. VLDA5C20 · #94138 · Abishek · 98xxxxxx02 · Neelambur · 5:00 am" },
  { n: 3, orderId: 94156, line: "3. 19457839 · #94156 · Suravi · 98xxxxxx03 · Kataka · 7:00 am" },
];

describe("batch replies by the lab's own reference", () => {
  it("one reference, one answer", () => {
    assert.deepEqual([...splitBatchReply("VL336FC5 serviced", items)], [[1, "serviced"]]);
  });
  it("several references on separate lines", () => {
    const parts = splitBatchReply("VL336FC5 serviced\nVLDA5C20 Serviced", items);
    assert.equal(parts.get(1), "serviced"); assert.equal(parts.get(2), "Serviced");
  });
  it("Redcliffe's 'Booking (ID: …)' form, and a reference read from the line when the item has none", () => {
    assert.deepEqual([...splitBatchReply("Booking (ID: 19457839)\nsample collected", items)], [[3, "sample collected"]]);
  });
  it("the lab quoting our whole line before its answer", () => {
    const parts = splitBatchReply("1. VL336FC5 · #93942 · Anvesh · 98xxxxxx01 · Guntur · 6:00 am\nThe sample has been collected.", items);
    assert.equal(parts.get(1), "The sample has been collected.");
  });
  it("numbers still work when no reference is written", () => {
    assert.deepEqual([...splitBatchReply("1 done, 2 not home", items)], [[1, "done"], [2, "not home"]]);
  });
});
