import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combine, linear, WEIGHTS } from "../brain/efficiency";

describe("the Ops Efficiency Index (27 Oct 2026)", () => {
  it("a linear score: at or better than best is 100, at or worse than worst is 0", () => {
    assert.equal(linear(5, 5, 60), 100);
    assert.equal(linear(60, 5, 60), 0);
    assert.equal(linear(32.5, 5, 60), 50);
    assert.equal(linear(0.5, 0.5, 3), 100);
    assert.equal(linear(null, 5, 60), null);
  });
  it("the index is the weighted mean of the components that have data", () => {
    assert.equal(combine({ autonomy: 100, speed: 100, closure: 100, labAnswers: 100, messages: 100, humanLoad: 100 }), 100);
    assert.equal(combine({ autonomy: 0, speed: 0, closure: 0, labAnswers: 0, messages: 0, humanLoad: 0 }), 0);
    // Only autonomy (25) and speed (15) known: 80·25 + 40·15 over 40 = 65.
    assert.equal(combine({ autonomy: 80, speed: 40, closure: null, labAnswers: null, messages: null, humanLoad: null }), 65);
    assert.equal(combine({}), null);
  });
  it("the weights add to 100 so the index is out of 100", () => {
    assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  });
});
