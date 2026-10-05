import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderListBlock, summaryVariables, type SummaryEntry } from "../summary";
import { renderLabTemplate, DEFAULT_PROVIDER_DAILY_DIGEST_BODY, DEFAULT_PROVIDER_PENDING_REPORTS_BODY } from "@/lib/non-api-labs/templates";
import type { MessageRule, RuleOrder } from "../types";
import type { OrderContactDetails } from "@/lib/non-api-labs/order-details";

const IST = "Asia/Kolkata";
const order = (overrides: Partial<RuleOrder> = {}): RuleOrder => ({
  id: 101, labId: 7, orderType: "HOME_SAMPLE", orderStatus: "ORDER_SCHEDULED",
  createdAt: new Date("2026-10-01T00:00:00Z"), statusUpdatedAt: null,
  appointmentTime: new Date("2026-10-07T02:30:00Z"), // 08:00 IST
  patientName: "Varun", phleboName: null, phleboNumber: null, metadata: {}, ...overrides,
});
const details = (overrides: Partial<OrderContactDetails> = {}): OrderContactDetails => ({
  orderId: 101, patientMobile: null, address: "Flat 2, 4th Cross, Solan – 173212", area: "Chambaghat",
  mapUrl: "https://maps.google.com/?q=30.900000,77.100000", tests: "Full Body Check",
  packages: [{ name: "Full Body Check", tests: ["CBC", "HbA1c"] }], directTests: ["Vitamin D"], storeName: null, ...overrides,
});
const entry = (o: Partial<RuleOrder> = {}, d: Partial<OrderContactDetails> = {}, confirmLink: string | null = null): SummaryEntry =>
  ({ order: order(o), details: details(d), confirmLink });
const tomorrow = { summaryScope: "APPOINTMENT_TOMORROW" } as Pick<MessageRule, "summaryScope">;
const now = new Date("2026-10-06T13:30:00Z");

describe("summary list", () => {
  it("one entry per order: time, patient, order, address, map, packages with tests, individual tests", () => {
    assert.equal(orderListBlock([entry()], tomorrow, now, IST), [
      "*1. 8:00 am* – Varun · #101",
      "   📍 Flat 2, 4th Cross, Solan – 173212",
      "   🗺️ https://maps.google.com/?q=30.900000,77.100000",
      "   📦 *Packages*",
      "   • Full Body Check",
      "     CBC, HbA1c",
      "   🧪 *Individual tests*",
      "   • Vitamin D",
    ].join("\n"));
  });

  it("flags an unconfirmed order with its confirmation link", () => {
    const block = orderListBlock([entry({ orderStatus: "CREATED" }, {}, "https://console.labstack.in/confirmation/x")], tomorrow, now, IST);
    assert.match(block, /⚠️ _Not confirmed_ – https:\/\/console\.labstack\.in\/confirmation\/x$/);
  });

  it("pending reports read with date and time since the appointment", () => {
    const block = orderListBlock([entry({ orderStatus: "SAMPLE_PROCESSED", appointmentTime: new Date("2026-10-05T03:00:00Z") })], { summaryScope: "OPEN" }, now, IST);
    assert.match(block, /^\*1\. 05 Oct 2026 8:30 am\* – Varun · #101\n {3}⏱️ 1 d 10 h since the appointment/);
  });

  it("caps the list and counts the rest", () => {
    const many = Array.from({ length: 15 }, (_, i) => entry({ id: i + 1 }));
    assert.match(orderListBlock(many, tomorrow, now, IST), /…and 3 more — full list in LabStack\.$/);
  });
});

describe("summary templates", () => {
  const rule = { summaryScope: "APPOINTMENT_TOMORROW" } as MessageRule;
  const vars = summaryVariables("Star Pathology", rule, [entry(), entry({ id: 102, orderStatus: "CREATED" })], now, IST);
  it("tomorrow's list renders with counts", () => {
    const text = renderLabTemplate(DEFAULT_PROVIDER_DAILY_DIGEST_BODY, vars);
    assert.match(text, /Tomorrow's orders – Wed 7 Oct/);
    assert.match(text, /Total: \*2\*/);
    assert.match(text, /Confirmed: 1 {3}⚠️ Pending: 1/);
  });
  it("pending reports renders", () => {
    assert.match(renderLabTemplate(DEFAULT_PROVIDER_PENDING_REPORTS_BODY, vars), /Reports pending – .*\nStar Pathology · Total: \*2\*/);
  });
});
