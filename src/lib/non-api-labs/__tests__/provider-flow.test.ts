/**
 * The provider message flow agreed in Oct 2026: new order with a LabStack
 * confirmation link, 1h/3h/5h reminders that stop once LabStack shows the order
 * confirmed, a status check 30 minutes after the appointment, and the evening
 * list of tomorrow's orders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { confirmationUrl, decryptOrderToken, encryptOrderId, ConfirmationLinkConfigError } from "../confirmation-link";
import { composePatientAddress, mapUrlFor, contactVariables } from "../order-details";
import { isAwaitingConfirmation, isPastCollection } from "../source-check";
import {
  TEMPLATE_DEFAULTS, validateNonApiTemplateBody, renderLabTemplate, isSupersededDefault,
  NON_API_NEW_ORDER_TEMPLATE, DEFAULT_NON_API_NEW_ORDER_BODY, NON_API_STATUS_CHECK_TEMPLATE,
  allowedVariablesFor,
} from "../templates";
import { parsePollOptions } from "../poll-definitions";

// A throwaway key for tests only — never LabStack's.
const TEST_KEY = "0123456789abcdef0123456789abcdef";

describe("confirmation link", () => {
  it("round-trips the order id", async () => {
    assert.equal(await decryptOrderToken(await encryptOrderId(88795, TEST_KEY), TEST_KEY), "88795");
  });

  it("decrypts a token made the way LabStack's encrypt() makes it", async () => {
    // Re-implemented independently from LabStack's snippet, so a drift in
    // either direction fails here rather than as dead links in a lab's group.
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", Buffer.from(TEST_KEY), iv);
    let encrypted = cipher.update("4242", "utf8", "base64");
    encrypted += cipher.final("base64");
    const token = (iv.toString("base64") + ":" + encrypted)
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "%3D").replace(/:/g, "%3A");
    assert.equal(await decryptOrderToken(token, TEST_KEY), "4242");
  });

  it("makes tokens LabStack's decrypt() can read", async () => {
    const token = (await encryptOrderId(31337, TEST_KEY))
      .replace(/-/g, "+").replace(/_/g, "/").replace(/%3D/g, "=").replace(/%3A/g, ":");
    const [iv, encrypted] = token.split(":");
    const decipher = createDecipheriv("aes-256-cbc", Buffer.from(TEST_KEY), Buffer.from(iv, "base64"));
    assert.equal(decipher.update(encrypted, "base64", "utf8") + decipher.final("utf8"), "31337");
  });

  it("produces the URL-safe shape the console route expects", async () => {
    const url = await confirmationUrl(73142, TEST_KEY);
    assert.match(url, /^https:\/\/console\.labstack\.in\/confirmation\/[A-Za-z0-9_-]+(%3D)*%3A[A-Za-z0-9_-]+(%3D)*$/);
    const token = url.slice("https://console.labstack.in/confirmation/".length);
    assert.doesNotMatch(token, /[+/=:]/);
  });

  it("uses a fresh IV each time", async () => {
    assert.notEqual(await encryptOrderId(1, TEST_KEY), await encryptOrderId(1, TEST_KEY));
  });

  it("refuses to run without a 32-character key", async () => {
    await assert.rejects(() => encryptOrderId(1, ""), ConfirmationLinkConfigError);
    await assert.rejects(() => encryptOrderId(1, "short"), ConfirmationLinkConfigError);
  });
});

describe("patient address", () => {
  it("joins flat, street, locality, city and pincode", () => {
    assert.equal(
      composePatientAddress({ unitFloorBuilding: "Flat 302", address: "12th Main Rd", locality: "Indiranagar", city: "Bengaluru", pincode: "560038" }),
      "Flat 302, 12th Main Rd, Indiranagar, Bengaluru – 560038",
    );
  });

  it("does not repeat what the street line already says", () => {
    assert.equal(
      composePatientAddress({ address: "12th Main Rd, Indiranagar, Bengaluru 560038", locality: "indiranagar", city: "Bengaluru", pincode: "560038" }),
      "12th Main Rd, Indiranagar, Bengaluru 560038",
    );
  });

  it("is null when nothing is on file", () => {
    assert.equal(composePatientAddress({ address: "  ", city: null }), null);
  });

  it("pins the coordinates when there are some, else searches the address", () => {
    assert.equal(mapUrlFor(12.9719, 77.6412, "x"), "https://maps.google.com/?q=12.971900,77.641200");
    assert.equal(mapUrlFor(0, 0, "MG Road, Pune"), "https://www.google.com/maps/search/?api=1&query=MG%20Road%2C%20Pune");
    assert.equal(mapUrlFor(null, null, null), null);
  });

  it("falls back to readable text, never an empty variable", () => {
    const vars = contactVariables(null);
    for (const value of Object.values(vars)) assert.ok(value.trim().length > 0);
  });
});

describe("confirmation signal", () => {
  it("treats only PENDING and CREATED as awaiting the lab", () => {
    assert.ok(isAwaitingConfirmation("PENDING"));
    assert.ok(isAwaitingConfirmation("CREATED"));
    for (const status of ["ORDER_SCHEDULED", "PHLEBO_ASSIGNED", "RESCHEDULED", "SAMPLE_COLLECTED"]) {
      assert.ok(!isAwaitingConfirmation(status), status);
    }
  });

  it("skips the status check once the sample is taken", () => {
    assert.ok(isPastCollection("SAMPLE_COLLECTED"));
    assert.ok(!isPastCollection("ORDER_SCHEDULED"));
  });
});

describe("provider templates", () => {
  const variables: Record<string, string> = Object.fromEntries(
    [
      "order_id", "patient_name", "appointment_date", "appointment_time", "location", "tests",
      "sla_deadline", "lab_name", "manager_name", "patient_mobile", "patient_address", "map_url",
      "confirm_url", "accept_url", "reschedule_url", "reject_url",
    ].map((name) => [name, `<${name}>`]),
  );

  it("every shipped default passes its own save-time contract", () => {
    for (const [key, { body }] of Object.entries(TEMPLATE_DEFAULTS)) {
      const result = validateNonApiTemplateBody(key, body);
      assert.ok(result.ok, `${key}: ${result.ok ? "" : result.error}`);
    }
  });

  it("the new-order message carries every detail the lab needs, and the link", () => {
    const text = renderLabTemplate(DEFAULT_NON_API_NEW_ORDER_BODY, variables);
    for (const name of ["patient_name", "patient_mobile", "patient_address", "map_url", "appointment_date", "appointment_time", "tests", "order_id", "confirm_url"]) {
      assert.ok(text.includes(`<${name}>`), `missing ${name}`);
    }
  });

  it("the status check may not be forced to carry a link", () => {
    assert.ok(allowedVariablesFor(NON_API_STATUS_CHECK_TEMPLATE).includes("order_id"));
    assert.ok(validateNonApiTemplateBody(NON_API_STATUS_CHECK_TEMPLATE, "Status of {{order_id}} for {{patient_name}}?").ok);
  });

  it("upgrades an untouched old default but never an edited one", () => {
    const shipped = `LabStack New Order

Order ID: {{order_id}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Location: {{location}}
Tests: {{tests}}

Please confirm by {{sla_deadline}}.

Tap an option in the poll below to respond.`;
    assert.ok(isSupersededDefault(NON_API_NEW_ORDER_TEMPLATE, shipped));
    assert.ok(!isSupersededDefault(NON_API_NEW_ORDER_TEMPLATE, shipped.replace("LabStack", "Our")));
    assert.ok(!isSupersededDefault(NON_API_NEW_ORDER_TEMPLATE, DEFAULT_NON_API_NEW_ORDER_BODY));
  });
});

describe("status-check poll options", () => {
  it("keeps askReason through parsing, and only where it is set", () => {
    const [plain, asks] = parsePollOptions([
      { label: "✅ Sample collected", action: null, ack: "" },
      { label: "🔄 Rescheduled", action: null, ack: "", askReason: true },
    ]);
    assert.equal("askReason" in plain, false);
    assert.equal(asks.askReason, true);
  });
});
