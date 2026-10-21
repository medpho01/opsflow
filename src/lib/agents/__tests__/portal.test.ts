import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePortalText, portalFieldsToFacts } from "../portal/adapters";
import { menuFor } from "../caseworker";

describe("portal reads (FR-17.3)", () => {
  it("reads phlebo, collection, partial report and RNR out of a detail card", () => {
    const text = `Order BLR6350935  Status: Sample Collected
      Phlebotomist: Ramesh Kumar  Phone 9876543210
      Sample collected at 08:05
      Report: partial  Pending tests: TFT, Vitamin D`;
    const f = parsePortalText(text);
    assert.equal(f.phleboName, "Ramesh Kumar");
    assert.equal(f.phleboPhone, "9876543210");
    assert.equal(f.sampleCollected, true);
    assert.equal(f.reportStatus, "partial");
    assert.deepEqual(f.missingTests, ["TFT", "Vitamin D"]);
    const facts = portalFieldsToFacts(f).map((x) => x.kind);
    assert.ok(facts.includes("sample_collected"));
    assert.ok(facts.includes("phlebo_name"));
    assert.ok(facts.includes("note"), "a partial report is a note, not report_shared");
  });
  it("a full report and an RNR", () => {
    assert.equal(parsePortalText("Status: Report Delivered. Final report available.").reportStatus, "full");
    assert.equal(portalFieldsToFacts(parsePortalText("Customer RNR, switched off at 7:30")).some((f) => f.kind === "patient_unavailable"), true);
  });
  it("custom patterns override the defaults", () => {
    const f = parsePortalText("Collector - Suresh", { phleboName: "Collector\\s*-\\s*(?<skip>)([A-Z][a-z]+)" });
    assert.equal(f.phleboName, "Suresh");
  });
});

describe("the case worker's menu (FR-1.7)", () => {
  it("offers only actions on the desk's menu", () => {
    const menu = menuFor({ reason: "x", text: "y", orderId: 1, checkpoint: null, at: new Date() }, ["ask", "create_task", "wait"]);
    assert.deepEqual(menu.map((m) => m.id), ["ask", "create_task", "wait"]);
  });
});
