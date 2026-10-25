import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readWithPatterns, readSamples } from "../reader/read";
import { EXAMPLES } from "../reader/examples";
import { readingMatches } from "../evals/run";

describe("the reader — pattern fallback on the anonymised chat phrasings", () => {
  it("reads samples per clause: blood collected, urine missed", () => {
    assert.deepEqual(readSamples("blood is collected\nbut urine collection is not done"), { blood: "collected", urine: "missed" });
    assert.deepEqual(readSamples("94101 - samples are not collected please check"), { blood: "missed" });
    assert.deepEqual(readSamples("the blood sample has been collected, and the urine sample will be collected by 12:15 pm"), { blood: "collected", urine: "pending" });
  });
  it("gets the store side right on at least 85% of the examples", async () => {
    const store = EXAMPLES.filter((e) => e.side === "store");
    const misses: string[] = [];
    for (const e of store) { const m = readingMatches(await readWithPatterns({ side: "store", text: e.text, quotedText: e.quoted ?? null }), e.expect); if (!m.pass) misses.push(`${e.text.slice(0, 40)} → ${m.why}`); }
    assert.ok(misses.length <= Math.floor(store.length * 0.15), misses.join("\n"));
  });
  it("gets the lab side right on at least 85% of the examples", async () => {
    const lab = EXAMPLES.filter((e) => e.side === "lab");
    const misses: string[] = [];
    for (const e of lab) { const m = readingMatches(await readWithPatterns({ side: "lab", text: e.text, quotedText: e.quoted ?? null, confirmation: /confirm/i.test(e.quoted ?? "") }), e.expect); if (!m.pass) misses.push(`${e.text.slice(0, 40)} → ${m.why}`); }
    assert.ok(misses.length <= Math.floor(lab.length * 0.15), misses.join("\n"));
  });
});
