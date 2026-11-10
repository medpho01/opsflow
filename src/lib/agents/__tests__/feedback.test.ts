import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labFeedback } from "../brain/feedback";

describe("lab feedback on our messages (10 Nov 2026)", () => {
  it("hears a lab asking for what our message left out", () => {
    assert.deepEqual(labFeedback("Plz send parameters details"), ["test_details"]);
    assert.deepEqual(labFeedback("Plz share test details"), ["test_details"]);
    assert.deepEqual(labFeedback("Plz share test code"), ["test_details"]);
    assert.ok(labFeedback("Pls tage urgent full details like name age and parameters \n\nHow I can see the details").includes("patient_details"));
    assert.deepEqual(labFeedback("Address not mentioned for this patient"), ["patient_details"]);
  });
  it("hears 'already told you', 'not ours' and 'which order?'", () => {
    assert.deepEqual(labFeedback("Already informed in the morning, why asking again"), ["repeats"]);
    assert.deepEqual(labFeedback("This booking is not ours, wrong lab"), ["not_ours"]);
    assert.deepEqual(labFeedback("Which patient is this?"), ["unclear"]);
  });
  it("an ordinary reply is not feedback", () => {
    for (const t of ["Sample collected", "ok", "Phlebo assigned Ravi 9876543210", "Report shared on mail", "VL047E84 As per technician sample collected, WOE pending due to gender issue", "As checked, the complete report has been uploaded to the portal."]) assert.deepEqual(labFeedback(t), [], t);
  });
});
