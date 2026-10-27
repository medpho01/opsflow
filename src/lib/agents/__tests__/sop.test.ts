import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSop, resolveParams, withinBounds, changedPaths, type SopBody } from "../sop/schema";
import { LAB_SOP_V1, STORE_SOP_V1, INTAKE_SOP_V1 } from "../sop/baseline";

describe("SOP format", () => {
  it("the baselines parse and every ask uses a known combined-message intent", () => {
    for (const sop of [LAB_SOP_V1, STORE_SOP_V1, INTAKE_SOP_V1]) assert.ok(parseSop(sop));
    for (const ask of Object.values(LAB_SOP_V1.params.asks)) assert.ok(["UNCONFIRMED", "PHLEBO", "ETA", "STATUS", "OVERDUE", "REPORT", "ESCALATION"].includes(ask.intent), ask.intent);
  });
  it("overrides resolve by tier and lab, deep-merging only what they set", () => {
    const c = resolveParams(LAB_SOP_V1, { labTier: "C", labId: 2229 });
    const a = resolveParams(LAB_SOP_V1, { labTier: "A", labId: 4 });
    assert.equal(c.ladder[0], "ask");
    assert.equal(a.ladder[0], "portal_read");
    assert.equal(a.asks.report_delivered.intent, "REPORT", "untouched asks survive an override");
    assert.equal(a.rungGapMin, LAB_SOP_V1.params.rungGapMin);
  });
  it("bounds: a change inside them is in bounds; a new template or ladder is not", () => {
    const inside = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    inside.params.rungGapMin = 45;
    assert.deepEqual(changedPaths(LAB_SOP_V1, inside), ["params.rungGapMin"]);
    assert.equal(withinBounds(LAB_SOP_V1, inside).inBounds, true);
    const outside = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    outside.params.rungGapMin = 90;
    assert.equal(withinBounds(LAB_SOP_V1, outside).inBounds, false);
    const ladder = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    ladder.params.ladder = ["ask", "task"];
    const r = withinBounds(LAB_SOP_V1, ladder);
    assert.equal(r.inBounds, false);
    assert.ok(r.outside[0].startsWith("params.ladder"));
  });
  it("rejects an action outside the menu vocabulary", () => {
    const bad = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    (bad.params.menu as string[]).push("cancel_order");
    assert.throws(() => parseSop(bad));
  });
});

describe("policy lives in the SOP, not the code (27 Oct 2026)", () => {
  it("the console-quiet window, the report rung gap and the store's failure phrases are SOP parameters with defaults", () => {
    const p = resolveParams(LAB_SOP_V1, { labTier: "A", labId: 4 });
    assert.equal(p.consoleQuietMin, 90);
    assert.equal(p.reportRungGapMin, 1440);
    assert.ok(p.storeExceptionPhrases.length >= 5);
    assert.equal(p.storeRemindLabMin, 60); assert.equal(p.storeRemindOpsMin, 45);
  });
  it("the Brain may move the numbers within bounds; outside them a proposal waits for approval", () => {
    const body = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    body.params.consoleQuietMin = 120;
    assert.equal(withinBounds(LAB_SOP_V1, body).inBounds, true);
    body.params.consoleQuietMin = 20;
    assert.equal(withinBounds(LAB_SOP_V1, body).inBounds, false);
  });
});

describe("what every lab is told unasked lives in the SOP (27 Oct 2026)", () => {
  it("the daily re-ask and the evening list are SOP parameters", () => {
    const p = resolveParams(LAB_SOP_V1, { labTier: "C", labId: 2229 });
    assert.equal(p.reaskEveryMin, 1440);
    assert.equal(p.briefings.eveningList.enabled, true);
    assert.equal(p.briefings.eveningList.at, "19:00");
    const body = JSON.parse(JSON.stringify(LAB_SOP_V1)) as SopBody;
    body.params.reaskEveryMin = 720;
    assert.equal(withinBounds(LAB_SOP_V1, body).inBounds, true);
  });
});
