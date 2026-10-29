import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestText, type StoreDay } from "../store/digest";
import { relayDetail } from "../journey/step";

const day: StoreDay = {
  storeId: 6, total: 24, collected: 15, upcoming: 4,
  rnr: [{ orderId: 90001, name: "Harshit", time: "6:00 am", lab: "Orange Health - Bangalore", detail: relayDetail({ kind: "patient_unavailable", value: "customer not available", fullText: "marked as RNR (Ring No Response). Slots available today: 9:00 AM - 10:00 AM, 11:30 AM" }) }],
  owed: [{ orderId: 90002, name: "Gururaj", sample: "urine", lab: "Orange Health - Bangalore" }],
  missed: [{ orderId: 90003, name: "Anvesh", time: "7:00 am", lab: "Thyrocare India" }],
  centreMissed: [{ orderId: 90004, name: "Meera", time: "8:00 am", lab: "City Clinic" }],
};

describe("store summary", () => {
  it("leads with what needs the store, RNR with the lab's slots", () => {
    const text = digestText(day, "Labstack<>Plum Ops", new Date("2026-10-26T04:30:00Z"))!;
    const lines = text.split("\n");
    assert.match(lines[0], /Today's visits — Labstack<>Plum Ops/);
    assert.match(lines[2], /Customer not reachable \(1\)/);
    assert.match(lines[3], /#90001 · Harshit · 6:00 am · lab offers 9:00 am - 10:00 am, 11:30 am — reply with the customer's preferred slot/);
    assert.match(text, /Sample still to collect \(1\)[\s\S]*#90002 · Gururaj · urine/);
    assert.match(text, /Visit time passed, not collected yet \(1\)[\s\S]*#90003/);
    assert.match(text, /Centre visit time passed \(1\)\* — the customer hasn't visited yet[\s\S]*#90004 · Meera/);
    assert.doesNotMatch(text.split("Centre visit")[0], /#90004/);
    assert.match(text, /Collected: 15 .* Still to come: 4 .* Total: 24/);
  });
  it("sends nothing for a store with no visits", () => {
    assert.equal(digestText({ ...day, total: 0, collected: 0, upcoming: 0, rnr: [], owed: [], missed: [], centreMissed: [] }, "x"), null);
  });
});

describe("store summary — labs the bot cannot chase (28 Oct 2026)", () => {
  it("counts visits past time with such labs instead of listing them as 'on it with the lab'", () => {
    const text = digestText({ ...day, missed: [], otherLabs: 2 }, "Labstack<>Plum Ops", new Date("2026-10-26T04:30:00Z"))!;
    assert.doesNotMatch(text, /Visit time passed, not collected yet/);
    assert.match(text, /☎️ 2 visits past time with labs we chase by phone — our team will update here\./);
  });
});

describe("store summary — what the lab moved or cancelled (29 Oct 2026)", () => {
  it("lists moves and cancellations once, in the summary, instead of a message each", () => {
    const text = digestText({ ...day, moved: [{ orderId: 95227, name: "Rajrajeshwari", when: "Thu, 29 Oct, 11:00 am", reason: "" }], cancelled: [{ orderId: 94478, name: "Chaithra", reason: "" }] }, "Labstack<>Plum Ops", new Date("2026-10-29T03:30:00Z"))!;
    assert.match(text, /🔁 \*Moved by the lab \(1\)\*[\s\S]*#95227 · Rajrajeshwari · now Thu, 29 Oct, 11:00 am/);
    assert.match(text, /⛔ \*Cancelled by the lab \(1\)\*[\s\S]*#94478 · Chaithra/);
  });
  it("a summary with only changes still goes", () => {
    const empty = { storeId: 6, total: 0, collected: 0, upcoming: 0, rnr: [], owed: [], missed: [], centreMissed: [] };
    assert.equal(digestText(empty, "Plum"), null);
    assert.ok(digestText({ ...empty, moved: [{ orderId: 1, name: "A", when: "Fri 8 am", reason: "" }] }, "Plum"));
  });
});

