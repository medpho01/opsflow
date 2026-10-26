import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storeWindowTo } from "../executors/storeReply";

// Times in IST (UTC+5:30). Nothing reaches a store 21:00–07:00; an alert raised then must survive until morning.
describe("how long a store message may wait", () => {
  it("daytime: six hours", () => {
    const now = new Date("2026-10-25T05:30:00Z"); // 11:00 am
    assert.equal(storeWindowTo(now).toISOString(), "2026-10-25T11:30:00.000Z");
  });
  it("raised at 11 pm: lasts until 9 am, so it goes out at 7", () => {
    const now = new Date("2026-10-25T17:30:00Z"); // 11:00 pm
    assert.equal(storeWindowTo(now).toISOString(), "2026-10-26T03:30:00.000Z"); // 9:00 am
  });
  it("raised at 1:15 am: until 9 am", () => {
    const now = new Date("2026-10-25T19:45:00Z"); // 1:15 am
    assert.equal(storeWindowTo(now).toISOString(), "2026-10-26T03:30:00.000Z");
  });
});
