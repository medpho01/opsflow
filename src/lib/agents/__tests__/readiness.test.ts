import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreRows } from "../store/readiness";
import { outOfScope } from "../guard/guard";

const now = new Date("2026-10-28T12:00:00Z");
const row = (intent: string, verdict: string, daysAgo = 1) => ({ intent, verdict, at: new Date(now.getTime() - daysAgo * 86_400_000), botAt: verdict === "MISSED" || verdict === "NEITHER" ? null : now, teamAt: verdict === "BOT_ONLY" || verdict === "NEITHER" ? null : now });

describe("the store desk grades itself (28 Oct 2026)", () => {
  it("a kind scores on coverage and correctness; ready at 85+, 15+ asked, nothing wrong in 3 days", () => {
    const rows = [...Array(16)].map(() => row("status", "SAME"));
    const r = scoreRows(rows, 7, now);
    const status = r.intents.find((i) => i.intent === "status")!;
    assert.equal(status.score, 100);
    assert.equal(status.ready, true);
    assert.deepEqual(r.recommended, ["status"]);
    assert.equal(r.score, 100);
  });
  it("one wrong order among 20 answers costs the kind its readiness; misses cost coverage only", () => {
    const rows = [...Array(19)].map(() => row("status", "COMPATIBLE")).concat([row("status", "WRONG_LINK", 1)]);
    const status = scoreRows(rows, 7, now).intents.find((i) => i.intent === "status")!;
    assert.equal(status.score, 97);
    assert.equal(status.ready, false, "a wrong order in the last 3 days");
    const old = [...Array(19)].map(() => row("report", "SAME")).concat([row("report", "WRONG_LINK", 5)]);
    assert.equal(scoreRows(old, 7, now).intents.find((i) => i.intent === "report")!.ready, true, "the wrong order was 5 days ago");
    const missed = [...Array(10)].map(() => row("reschedule", "SAME")).concat([...Array(5)].map(() => row("reschedule", "MISSED")));
    const resched = scoreRows(missed, 7, now).intents.find((i) => i.intent === "reschedule")!;
    assert.equal(resched.score, 87);
    assert.equal(resched.covered, 10);
  });
  it("fewer than 5 asked: no score, never ready", () => {
    const r = scoreRows([row("cancel", "SAME"), row("cancel", "SAME")], 7, now).intents.find((i) => i.intent === "cancel")!;
    assert.equal(r.score, null);
    assert.equal(r.ready, false);
  });
  it("a store reply outside the desk's live scope is handed off; an empty scope means every kind", () => {
    const ctx = { journeyId: null, orderId: 1, labId: null, storeId: 6 };
    const reply = (intent: string) => ({ desk: "STORE" as const, action: "store_reply" as const, params: { intent, orderId: 1, storeId: 6 }, reason: "", idemKey: "x" });
    const scoped = { scopes: new Map([["STORE:STORE:6", ["status", "report"]]]) };
    assert.equal(outOfScope(scoped, reply("status"), ctx), null);
    assert.equal(outOfScope(scoped, reply("reschedule"), ctx), "reschedule");
    assert.equal(outOfScope({ scopes: new Map() }, reply("reschedule"), ctx), null);
    assert.equal(outOfScope(scoped, { ...reply("reschedule"), action: "store_alert" }, ctx), null, "alerts are never scoped");
  });
});
