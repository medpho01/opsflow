import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The gateway's pure helper (whatsapp-bot/lib/provenance.mjs), tested here so `npm test` covers it.
import { inheritedVia } from "../../../../whatsapp-bot/lib/provenance.mjs";

describe("gateway — what a reply inherits as provenance", () => {
  it("keeps the parent's explanation when it names the inherited order", () => {
    assert.equal(inheritedVia({ idVia: "order 93709" }, 93709, null), "order 93709");
    assert.equal(inheritedVia({ idVia: "active thread · order 90381" }, 90381, null), "active thread · order 90381");
  });
  it("rebuilds it from the inherited id when the parent's explanation names a different order", () => {
    assert.equal(inheritedVia({ idVia: "order 93709" }, 90381, null), "order 90381");
    assert.equal(inheritedVia({ idVia: "reply · request 500" }, null, 501), "request 501");
  });
  it("keeps an explanation that names no id (a lab reference) and an appointment mapping", () => {
    assert.equal(inheritedVia({ idVia: "BLR6362207" }, 90381, null), "BLR6362207");
    assert.equal(inheritedVia({ idVia: "appt 71234 (ranked over order 71234)" }, 90381, null), "appt 71234 (ranked over order 71234)");
  });
  it("falls back to the id when the parent has no explanation", () => {
    assert.equal(inheritedVia({ idVia: null }, 90381, null), "order 90381");
  });
});
