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

describe("when the desk should have stayed quiet (28 Oct 2026, Plum's first live afternoon)", () => {
  it("a reply to a question addressed to a named person is UNWANTED; silence there is not graded at all", async () => {
    const { unwanted } = await import("../store/readiness");
    assert.equal(unwanted({ forPerson: true, draft: "#92410: LabStack cancelled on 23 Oct.", botAt: now, teamAt: null }), true);
    assert.equal(unwanted({ forPerson: true, draft: "[handoff] store complaint", botAt: now, teamAt: null }), false, "a handoff is the right move");
    assert.equal(unwanted({ forPerson: true, draft: null, botAt: null, teamAt: now }), false);
  });
  it("an 'on it' within two minutes of a team member's answer is UNWANTED; a status answer is not", async () => {
    const { unwanted } = await import("../store/readiness");
    const t = new Date(now.getTime() + 60_000);
    assert.equal(unwanted({ forPerson: false, draft: "#95078: checking with Suburban Diagnostics, will update here.", botAt: now, teamAt: t }), true);
    assert.equal(unwanted({ forPerson: false, draft: "#95078: sample collected 10:15 am.", botAt: now, teamAt: t }), false);
    assert.equal(unwanted({ forPerson: false, draft: "#95078: checking with Suburban Diagnostics, will update here.", botAt: now, teamAt: new Date(now.getTime() + 30 * 60_000) }), false, "the team came half an hour later");
  });
  it("UNWANTED costs a kind its readiness like a wrong fact does", () => {
    const rows = [...Array(19)].map(() => row("status", "SAME")).concat([{ ...row("status", "SAME", 1), verdict: "UNWANTED" }]);
    const status = scoreRows(rows, 7, now).intents.find((i) => i.intent === "status")!;
    assert.equal(status.unwanted, 1);
    assert.equal(status.bad, 1);
    assert.equal(status.ready, false);
  });
});

describe("the desk's scope (28 Oct 2026)", () => {
  it("a grievance is a complaint whatever else it looks like", async () => {
    const { complaintSignal } = await import("../store/scope");
    for (const t of ["90130 - doctor consultation is not done for this centre visit please check", "92410 - samples collected but cancelled", "94547 - was created as a dummy order was informed reports will be uploaded", "94721 - samples not collected and no one is assigned last time also they collected the samples and cancelled the order"]) assert.equal(complaintSignal(t), true, t);
    for (const t of ["94165 - please upload reports", "any update on this?", "94872 - please give urine sample slots for today", "why was it cancelled?"]) assert.equal(complaintSignal(t), false, t);
  });
  it("a message for a named team member, or 'as discussed', is theirs", async () => {
    const { addressedToPerson } = await import("../store/scope");
    const isTeam = (name: string) => (/sushma|abhishek/i.test(name) ? { name } : null);
    const names = { "919731145171": "Labstack Sushma", "157140018823280": "Abhishek Rajpoot", "918888877777": "Pavitra Plum" };
    assert.deepEqual(addressedToPerson("94347 - Please cancel this order @919731145171", names, isTeam), { ids: ["919731145171"], names: ["Labstack Sushma"] });
    assert.deepEqual(addressedToPerson("@157140018823280 as discussed please check 92410", names, isTeam)?.ids, ["157140018823280"]);
    assert.deepEqual(addressedToPerson("as discussed, please check 92410", names, isTeam), { ids: [], names: [] });
    assert.equal(addressedToPerson("@918888877777 please check", names, isTeam), null, "the store tagging its own colleague");
    assert.equal(addressedToPerson("94165 - please upload reports", names, isTeam), null);
  });
  it("a lab is on the bot through an API, or a connected group with a live desk", async () => {
    const { labOnBot, mentionJid } = await import("../store/scope");
    assert.equal(labOnBot({ api: true, group: false, live: false }), true, "Thyrocare / Redcliffe / Orange");
    assert.equal(labOnBot({ api: false, group: true, live: true }), true, "a non-API lab we chase on WhatsApp");
    assert.equal(labOnBot({ api: false, group: true, live: false }), false);
    assert.equal(labOnBot({ api: false, group: false, live: false }), false, "Suburban: phone and email only");
    assert.equal(mentionJid("919731145171"), "919731145171@s.whatsapp.net");
    assert.equal(mentionJid("157140018823280"), "157140018823280@lid");
  });
  it("a store reply is not sent twice, and an 'on it' waits three minutes for a person and yields to them", async () => {
    const { storeReplyRedundant } = await import("../executors/dispatcher");
    const created = new Date("2026-10-28T09:37:00Z");
    const ack = "#95078: checking with Suburban Diagnostics, will update here.";
    assert.equal(storeReplyRedundant({ text: ack, orderId: 95078, createdAt: created, now: created, sameTextSent: true, teamAnswered: false }), "duplicate");
    assert.equal(storeReplyRedundant({ text: ack, orderId: 95078, createdAt: created, now: new Date(created.getTime() + 60_000), sameTextSent: false, teamAnswered: false }), "hold");
    assert.equal(storeReplyRedundant({ text: ack, orderId: 95078, createdAt: created, now: new Date(created.getTime() + 4 * 60_000), sameTextSent: false, teamAnswered: true }), "team answered");
    assert.equal(storeReplyRedundant({ text: ack, orderId: 95078, createdAt: created, now: new Date(created.getTime() + 4 * 60_000), sameTextSent: false, teamAnswered: false }), null);
    assert.equal(storeReplyRedundant({ text: "#95078: sample collected 10:15 am.", orderId: 95078, createdAt: created, now: created, sameTextSent: false, teamAnswered: true }), null, "a fact goes at once");
  });
});
