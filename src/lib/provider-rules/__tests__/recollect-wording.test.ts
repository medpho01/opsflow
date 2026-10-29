import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASKS_FOR_TIME_RE, OFFERS_TIME_RE, timeQuestionAnswer } from "../replies";
import { itemLine } from "../batching";
import { recollectTitle } from "@/lib/agents/executors/dispatcher";
import { renderLabTemplate, TEMPLATE_DEFAULTS } from "@/lib/non-api-labs/templates";

describe("re-collection asks: one line, a few words per order (29 Oct 2026, #94443)", () => {
  it("'Available slots for urine sample collection?' and no visit time on the line", () => {
    const line = itemLine("RECOLLECT", { n: 1, orderId: 94443, patientName: "Shiuli X", appointment: new Date("2026-10-29T04:45:00Z"), labRef: "BLR0000001", area: "Bengaluru", note: "urine pending" }, new Date("2026-10-29T06:30:00Z"), "Asia/Kolkata");
    assert.equal(line, "1. BLR0000001 · #94443 · Shiuli · Bengaluru · urine pending");
    const text = renderLabTemplate(TEMPLATE_DEFAULTS.BATCH_RECOLLECT.body, { coordinator: "@lab", batch_title: recollectTitle(["urine pending"]), items: line, count: "1" });
    assert.equal(text, "@lab Available slots for urine sample collection?\n\n1. BLR0000001 · #94443 · Shiuli · Bengaluru · urine pending");
    assert.equal(recollectTitle(["urine pending", "stool pending"]), "sample collection");
  });
  it("a lab asking us for the time gets one short line", () => {
    const lab = "The blood sample has been collected but the urine sample has not been collected.\n\nKindly let us know the appointment date and time so w can schedule it.";
    assert.ok(ASKS_FOR_TIME_RE.test(lab) && !OFFERS_TIME_RE.test(lab));
    assert.ok(OFFERS_TIME_RE.test("we can do 4 pm today, please confirm the time"), "a reply offering times is an answer");
    assert.ok(!ASKS_FOR_TIME_RE.test("urine will be collected by 12:15 pm"));
    assert.equal(timeQuestionAnswer([{ orderId: 94443, sample: "urine", preferred: null }]), "#94443: please share your available slots for urine sample collection.");
    assert.equal(timeQuestionAnswer([{ orderId: 94443, sample: "urine", preferred: "30 Oct, 8:00 am" }]), "#94443: customer prefers 30 Oct, 8:00 am. Possible?");
  });
});
