import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLoose, checkVariant, inTrial, STYLE_CONTRACTS, STYLE_DEFAULTS } from "../style";
import { decide } from "../brain/style";

describe("message style: wording is learned, the contract is not (27 Oct 2026)", () => {
  it("renderLoose drops empty parts, empty segments and empty lines, keeps a link on its own line", () => {
    assert.equal(renderLoose("{{n}}. #{{order_id}} · {{name}} · {{mobile}} · {{when}}{{link}}", { n: "1", order_id: "88704", name: "Manjusha", mobile: "", when: "7:00 am", link: "\n    https://x/c" }), "1. #88704 · Manjusha · 7:00 am\n    https://x/c");
    assert.equal(renderLoose("*{{n}}.* {{name}} · 📞 {{mobile}}\n   📍 {{address}}\n   🧪 {{tests}}", { n: "2", name: "Ravi", mobile: "", address: "", tests: "CBC" }), "*2.* Ravi\n   🧪 CBC");
  });
  it("every default honours its own contract", () => {
    for (const key of Object.keys(STYLE_DEFAULTS)) assert.equal(checkVariant(key, STYLE_DEFAULTS[key].body), null, key);
  });
  it("a variant that drops a required field, adds a link, or uses an unknown variable is refused", () => {
    assert.match(checkVariant("SUMMARY_ENTRY_PAST", "*{{n}}.* {{name}} · visit {{date_time}}")!, /missing {{order_id}}/);
    assert.match(checkVariant("STORE_CHECKING", "#{{order_id}}: see https://example.com")!, /adds a link/);
    assert.match(checkVariant("STORE_CHECKING", "#{{order_id}}: {{phlebo}} is on the way")!, /does not have/);
    assert.match(checkVariant("BATCH_STATUS_CHECK", "collected? ({{count}})\n\n{{items}}")!, /coordinator/);
    assert.equal(checkVariant("STORE_CHECKING", "#{{order_id}}: asking {{lab_name}} now, back to you here shortly."), null);
    assert.ok(Object.keys(STYLE_CONTRACTS).length >= 25);
  });
  it("the trial split is stable per counterparty and about the given share", () => {
    const a = inTrial("LAB:2229", 0.5, "v1");
    for (let i = 0; i < 20; i += 1) assert.equal(inTrial("LAB:2229", 0.5, "v1"), a);
    const n = Array.from({ length: 1000 }, (_, i) => inTrial(`LAB:${i}`, 0.5, "v1")).filter(Boolean).length;
    assert.ok(n > 420 && n < 580, `${n} of 1000 in the trial`);
    assert.equal(inTrial("LAB:1", 0, "v1"), false);
  });
  it("a trial is promoted on a clear lift, retired otherwise, and waits while either arm is short", () => {
    const arm = (sends: number, rate: number, medianMin: number | null = 30) => ({ sends, engaged: Math.round(sends * rate), rate, medianMin });
    assert.equal(decide(arm(40, 0.5), arm(10, 0.9), 30), "continue");
    assert.equal(decide(arm(40, 0.5), arm(40, 0.56), 30), "promote");
    assert.equal(decide(arm(40, 0.5), arm(40, 0.52), 30), "retire");
    assert.equal(decide(arm(40, 0.5, 20), arm(40, 0.6, 60), 30), "retire");
  });
});
