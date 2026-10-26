import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchPatients } from "../match-patient";

// Fictional patients; the phrasings are how labs actually answer (27 Oct 2026).
const candidates = [
  { id: 90001, name: "Rishi Agarwal", mobile: "9313100001" },
  { id: 90002, name: "Usha Devi", mobile: "9730200002" },
  { id: 90003, name: "Sullgh Sarvalia", mobile: "9876500003" },
  { id: 90004, name: "Aman Narware", mobile: "9792000004" },
  { id: 90005, name: "Aman Khan", mobile: "9792000005" },
  { id: 90006, name: "Shivani Rana", mobile: "9000000006" },
];

describe("a lab's reply linked by the patient's name or phone", () => {
  it("name and phone on one line, per order", () => {
    const m = matchPatients("Magnesium tat 48 hrs · Rishi · 9313100001\nUsha · 9730200002 Cortisol, Morning Sample tat 48 hrs", candidates);
    assert.equal(m.get(90001), "Magnesium tat 48 hrs · Rishi · 9313100001");
    assert.equal(m.get(90002), "Usha · 9730200002 Cortisol, Morning Sample tat 48 hrs");
    assert.equal(m.size, 2);
  });
  it("a report file named after the patient", () => {
    const m = matchPatients("📄 2026_10_26_Mr._SULLGH_SARVALIA.pdf", candidates);
    assert.deepEqual([...m.keys()], [90003]);
    assert.deepEqual([...matchPatients("📄 Shivani Rana-32.pdf", candidates).keys()], [90006]);
  });
  it("a first name two patients share is not enough; the full name is", () => {
    assert.equal(matchPatients("Aman - report shared", candidates).size, 0);
    assert.deepEqual([...matchPatients("Aman Narware report shared", candidates).keys()], [90004]);
  });
  it("a short or common word never matches; a distinctive single word does", () => {
    assert.equal(matchPatients("Mr Kumar sample collected", candidates).size, 0);
    assert.deepEqual([...matchPatients("Sarvalia on priority", candidates).keys()], [90003]);
  });
  it("a phone written with spaces or a country code", () => {
    assert.deepEqual([...matchPatients("collected +91 93131 00001", candidates).keys()], [90001]);
  });
});
