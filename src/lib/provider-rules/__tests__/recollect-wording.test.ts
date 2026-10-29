import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASKS_FOR_TIME_RE, OFFERS_TIME_RE, timeQuestionAnswer } from "../replies";
import { itemLine } from "../batching";

describe("re-collection asks a lab can't misread (29 Oct 2026, #94443)", () => {
  it("the visit's time reads as history, the line as a re-collection", () => {
    const line = itemLine("RECOLLECT", { n: 1, orderId: 94443, patientName: "Shiuli X", appointment: new Date("2026-10-29T04:45:00Z"), labRef: "BLR0000001", area: "Bengaluru", note: "urine re-collection" }, new Date("2026-10-29T06:30:00Z"), "Asia/Kolkata");
    assert.match(line, /visited 10:15 am · urine re-collection$/);
    assert.doesNotMatch(line, /slot for re-collection\?/);
  });
  it("a lab asking us for the time is told plainly what we need", () => {
    const lab = "The blood sample has been collected but the urine sample has not been collected.\n\nKindly let us know the appointment date and time so w can schedule it.";
    assert.ok(ASKS_FOR_TIME_RE.test(lab) && !OFFERS_TIME_RE.test(lab));
    assert.ok(OFFERS_TIME_RE.test("we can do 4 pm today, please confirm the time"), "a reply offering times is an answer");
    assert.ok(!ASKS_FOR_TIME_RE.test("urine will be collected by 12:15 pm"));
    assert.match(timeQuestionAnswer([{ orderId: 94443, sample: "urine", preferred: null }]), /^We don't have a time from the customer yet\. Please share the times your phlebo can go for the urine re-collection \(#94443\)/);
    assert.match(timeQuestionAnswer([{ orderId: 94443, sample: "urine", preferred: "Thu, 30 Oct 8:00 am" }]), /^The customer prefers Thu, 30 Oct 8:00 am for the urine re-collection \(#94443\)\. Can your phlebo go then\?/);
  });
});
