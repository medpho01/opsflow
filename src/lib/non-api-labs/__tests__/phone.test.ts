import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { personJid, whatsappDigits } from "../../wa/phone";

describe("a person's WhatsApp number", () => {
  it("adds India's 91 to a bare 10-digit mobile, however it was typed", () => {
    for (const typed of ["9876543210", "98765 43210", "098765-43210", "+91 98765 43210", "0091 9876543210", "919876543210"]) {
      assert.equal(whatsappDigits(typed), "919876543210", typed);
    }
    assert.equal(personJid("98765 43210"), "919876543210@s.whatsapp.net");
  });
  it("leaves numbers with another country code alone", () => {
    assert.equal(whatsappDigits("+1 415 555 0100"), "14155550100");
    assert.equal(whatsappDigits("+971 50 123 4567"), "971501234567");
  });
});
