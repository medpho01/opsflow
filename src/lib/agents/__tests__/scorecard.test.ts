import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closingLine, computeLabWeek, previousWeek, renderScorecard, type ScorecardAsk, type ScorecardOrder } from "../brain/scorecard";

const TZ = "Asia/Kolkata";
// Monday 26 Oct 2026, 10:30 IST.
const monday = new Date("2026-10-26T05:00:00Z");
const ist = (s: string) => new Date(`${s}+05:30`);
const min = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
const hrs = (d: Date, n: number) => min(d, n * 60);

const order = (o: Partial<ScorecardOrder> & { orderId: number }): ScorecardOrder => ({
  appointmentTime: ist("2026-10-20T08:00:00"), missed: false, collectedAt: null, reportAt: null, phleboLate: false, ...o,
});
const ask = (sentAt: Date, repliedAt: Date | null, intent = "PHLEBO"): ScorecardAsk => ({ batchId: `${sentAt.getTime()}`, intent, sentAt, repliedAt });

describe("the previous Mon–Sun week", () => {
  it("from a Monday morning is the seven days just ended", () => {
    const w = previousWeek(monday, TZ);
    assert.equal(w.start.toISOString(), "2026-10-18T18:30:00.000Z"); // Mon 19 Oct 00:00 IST
    assert.equal(w.end.toISOString(), "2026-10-25T18:30:00.000Z"); // Mon 26 Oct 00:00 IST
    assert.equal(w.label, "19 Oct–25 Oct");
  });
  it("from a Wednesday is still the week that ended on Sunday", () => {
    const w = previousWeek(new Date("2026-10-28T09:00:00Z"), TZ);
    assert.equal(w.start.toISOString(), "2026-10-18T18:30:00.000Z");
  });
});

describe("last week's numbers for a lab", () => {
  it("asks answered within 30 min, median reply, unanswered asks count against the share", () => {
    const t = ist("2026-10-20T10:30:00");
    const n = computeLabWeek({ orders: [], asks: [ask(t, min(t, 5)), ask(t, min(t, 25)), ask(t, min(t, 45)), ask(t, null)] }, monday, TZ);
    assert.equal(n.asks, 4);
    assert.equal(n.answered, 3);
    assert.equal(n.answeredWithin30, 0.5);
    assert.equal(n.medianReplyMin, 25);
  });
  it("no asks gives null shares, not zero", () => {
    const n = computeLabWeek({ orders: [order({ orderId: 1 })], asks: [] }, monday, TZ);
    assert.equal(n.answeredWithin30, null);
    assert.equal(n.medianReplyMin, null);
  });
  it("missed visits and late collections are counted apart", () => {
    const slot = ist("2026-10-21T07:00:00");
    const n = computeLabWeek({ orders: [
      order({ orderId: 1, appointmentTime: slot, missed: true }),
      order({ orderId: 2, appointmentTime: slot, collectedAt: hrs(slot, 3) }),     // 3 h late
      order({ orderId: 3, appointmentTime: slot, collectedAt: min(slot, 90) }),    // within 2 h
      order({ orderId: 4, appointmentTime: slot, collectedAt: hrs(slot, 2.5), missed: true }), // missed, then collected late: one miss
    ], asks: [] }, monday, TZ);
    assert.equal(n.orders, 4);
    assert.equal(n.missedVisits, 2);
    assert.equal(n.lateCollections, 1);
  });
  it("report TAT is the median from collection; undelivered past 24 h counts as over", () => {
    const slot = ist("2026-10-20T08:00:00");
    const n = computeLabWeek({ orders: [
      order({ orderId: 1, appointmentTime: slot, collectedAt: min(slot, 10), reportAt: hrs(min(slot, 10), 20) }),
      order({ orderId: 2, appointmentTime: slot, collectedAt: slot, reportAt: hrs(slot, 30) }),
      order({ orderId: 3, appointmentTime: slot, reportAt: hrs(slot, 22) }), // no collection time: from the slot
      order({ orderId: 4, appointmentTime: slot, collectedAt: slot }),        // still no report, days later
      order({ orderId: 5, appointmentTime: ist("2026-10-25T20:00:00"), collectedAt: ist("2026-10-25T20:10:00") }), // not yet due
    ], asks: [] }, monday, TZ);
    assert.equal(n.reportsDelivered, 3);
    assert.equal(n.reportTatMedianH, 22);
    assert.equal(n.reportOver24Count, 2);
    assert.equal(n.reportOver24, 0.5);
  });
  it("early-morning visits with no phlebo named in time", () => {
    const n = computeLabWeek({ orders: [
      order({ orderId: 1, appointmentTime: ist("2026-10-20T06:30:00"), phleboLate: true }),
      order({ orderId: 2, appointmentTime: ist("2026-10-20T07:45:00"), phleboLate: true }),
      order({ orderId: 3, appointmentTime: ist("2026-10-20T11:00:00"), phleboLate: true }), // late, but not early-morning
      order({ orderId: 4, appointmentTime: ist("2026-10-20T06:00:00") }),
    ], asks: [] }, monday, TZ);
    assert.equal(n.earlyNoPhlebo, 2);
  });
});

describe("the message", () => {
  const slot = ist("2026-10-20T07:00:00");
  const t = ist("2026-10-20T10:30:00");
  it("is four lines of plain numbers with the coordinator placeholder first", () => {
    const n = computeLabWeek({
      orders: [order({ orderId: 1, appointmentTime: slot, collectedAt: slot, reportAt: hrs(slot, 20) }), order({ orderId: 2, appointmentTime: slot, missed: true })],
      asks: [ask(t, min(t, 10)), ask(t, min(t, 20)), ask(t, null)],
    }, monday, TZ);
    const text = renderScorecard("Thyrocare", previousWeek(monday, TZ), n);
    const lines = text.split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "{{coordinator}} Thyrocare last week (19 Oct–25 Oct): 2 orders.");
    assert.equal(lines[1], "67% of 3 asks answered within 30 min · median reply 15 min.");
    assert.equal(lines[2], "1 visit missed · 0 collections over 2 h late · reports median 20 h · 0% over 24 h.");
    assert.match(lines[3], /^Ask: 1 visit missed/);
  });
  it("the closing line is one specific ask, phlebos first, else thanks", () => {
    const base = computeLabWeek({ orders: [order({ orderId: 1, appointmentTime: slot, collectedAt: slot, reportAt: hrs(slot, 10) })], asks: [ask(t, min(t, 3))] }, monday, TZ);
    assert.equal(closingLine(base), "Thank you — this is what keeps patients from waiting.");
    assert.equal(closingLine({ ...base, earlyNoPhlebo: 3, missedVisits: 2 }), "Ask: 3 early-morning visits had no phlebo named the evening before — please name them by 8 pm.");
    assert.match(closingLine({ ...base, reportOver24: 0.4, reportOver24Count: 4 }), /^Ask: 4 reports took over 24 h/);
    assert.match(closingLine({ ...base, asks: 6, answered: 2, answeredWithin30: 0.3 }), /^Ask: 4 asks got no reply/);
    assert.match(closingLine({ ...base, asks: 6, answered: 6, answeredWithin30: 0.3 }), /^Ask: most replies came late/);
  });
  it("a week with orders but no asks says so instead of a percentage", () => {
    const n = computeLabWeek({ orders: [order({ orderId: 1, appointmentTime: slot })], asks: [] }, monday, TZ);
    const lines = renderScorecard("Lab", previousWeek(monday, TZ), n).split("\n");
    assert.equal(lines[1], "no asks from us.");
    assert.match(lines[2], /1 report past 24 h, none delivered yet\.$/);
  });
});
