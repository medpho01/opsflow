import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newOrderReleaseAt, NEW_ORDER_GATHER_MINUTES } from "../new-order";
import { itemLine, intentRank, NEW_ORDER_INTENT } from "../batching";

const IST = "Asia/Kolkata";
const ist = (x: string) => new Date(`${x}+05:30`);
const release = (placed: string, visit: string | null, gatherFrom: string | null = null) =>
  newOrderReleaseAt(ist(placed), visit ? ist(visit) : null, gatherFrom ? ist(gatherFrom) : null, IST);

describe("new-order message timing", () => {
  it("a lone order waits the gather window, then goes", () => {
    assert.equal(NEW_ORDER_GATHER_MINUTES, 10);
    assert.deepEqual(release("2026-10-20T10:05:00", "2026-10-21T07:00:00"), ist("2026-10-20T10:15:00"));
  });

  it("orders placed within the window of the earliest waiting one go together, at its close", () => {
    // #1 placed 10:05 opens the window; #2 at 10:12 and #3 at 10:14 join it; all release 10:15.
    assert.deepEqual(release("2026-10-20T10:12:00", "2026-10-21T07:30:00", "2026-10-20T10:05:00"), ist("2026-10-20T10:15:00"));
    assert.deepEqual(release("2026-10-20T10:14:00", "2026-10-21T08:00:00", "2026-10-20T10:05:00"), ist("2026-10-20T10:15:00"));
    // Placed after that window closed (the earliest is still waiting on its details): its own window.
    assert.deepEqual(release("2026-10-20T10:28:00", "2026-10-21T08:00:00", "2026-10-20T10:05:00"), ist("2026-10-20T10:38:00"));
  });

  it("placed at night (21:00–08:00) it waits for 08:00 — the evening list already covered tomorrow", () => {
    assert.deepEqual(release("2026-10-20T23:30:00", "2026-10-21T12:00:00"), ist("2026-10-21T08:00:00"));
    assert.deepEqual(release("2026-10-20T21:00:00", "2026-10-21T12:00:00"), ist("2026-10-21T08:00:00"));
    assert.deepEqual(release("2026-10-21T06:30:00", "2026-10-21T15:00:00"), ist("2026-10-21T08:00:00"));
    // 20:55 is not night: it gathers and goes at 21:05.
    assert.deepEqual(release("2026-10-20T20:55:00", "2026-10-21T12:00:00"), ist("2026-10-20T21:05:00"));
    // Noticed late (an outage): the morning after its placement, which is already past → goes now.
    assert.deepEqual(release("2026-10-20T23:00:00", null), ist("2026-10-21T08:00:00"));
  });

  it("a visit within 3 hours goes at once, day or night", () => {
    assert.deepEqual(release("2026-10-20T10:05:00", "2026-10-20T12:30:00"), ist("2026-10-20T10:05:00"));
    assert.deepEqual(release("2026-10-20T23:40:00", "2026-10-21T01:30:00"), ist("2026-10-20T23:40:00"));
  });

  it("never holds past the lead time before the visit: a 23:30 order for a 07:00 visit is not kept for 08:00", () => {
    assert.deepEqual(release("2026-10-20T23:30:00", "2026-10-21T07:00:00"), ist("2026-10-20T23:30:00"));
    assert.deepEqual(release("2026-10-20T23:30:00", "2026-10-21T09:00:00"), ist("2026-10-20T23:30:00")); // 08:00 would leave 60 min
    assert.deepEqual(release("2026-10-20T23:30:00", "2026-10-21T09:30:00"), ist("2026-10-21T08:00:00")); // 90 min: held
  });

  it("goes out first when several asks are due together", () => {
    assert.equal(intentRank(NEW_ORDER_INTENT), 0);
  });

  it("one detail block per order in a combined new-order message, with its own confirm link", () => {
    const now = ist("2026-10-20T10:15:00");
    const block = itemLine(NEW_ORDER_INTENT, {
      n: 2, orderId: 90002, patientName: "Patient B Kumar", appointment: ist("2026-10-21T07:30:00"),
      mobile: "98xxxxxx02", address: "12, 2nd Cross, Indiranagar, Bengaluru – 560038", mapUrl: "https://maps.google.com/?q=1,2",
      tests: "Full Body Check", confirmUrl: "https://x/c2",
    }, now, IST);
    assert.equal(block, [
      "2. #90002 · Patient B Kumar · tomorrow 7:30 am",
      "    📞 98xxxxxx02",
      "    📍 12, 2nd Cross, Indiranagar, Bengaluru – 560038",
      "    🗺️ https://maps.google.com/?q=1,2",
      "    🧪 Full Body Check",
      "    https://x/c2",
    ].join("\n"));
    // A detail LabStack does not have is left out, never "not on file".
    const sparse = itemLine(NEW_ORDER_INTENT, { n: 1, orderId: 90001, patientName: "P", appointment: null, confirmUrl: "https://x/c1" }, now, IST);
    assert.equal(sparse, "1. #90001 · P · no appointment time\n    https://x/c1");
  });
});
