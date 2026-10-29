import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { atRiskText } from "../store/atrisk";

describe("at-risk note to the store (29 Oct 2026)", () => {
  it("lists every order once, with time and lab, and asks for a new slot or another lab", () => {
    const text = atRiskText([{ orderId: 95048, name: "A", time: "9:00 am", lab: "Vision Lab" }, { orderId: 95072, name: "B", time: "9:00 am", lab: "Vision Lab" }]);
    assert.match(text, /^⚠️ \*At risk — the lab hasn't confirmed these visits yet \(2\)\*/);
    assert.match(text, /1\. #95048 · A · 9:00 am · Vision Lab/);
    assert.match(text, /share a new slot here — or tell us to try another lab/);
    assert.doesNotMatch(text, /@/, "no one is tagged");
  });
});
