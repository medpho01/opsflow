/**
 * Unit tests for the VIP classifier.
 *
 *   node --import tsx --test src/lib/priority/__tests__/vipResolver.test.ts
 *
 * Pure classifier: no database, no server, no network required.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveVip } from "../vipResolver";
import { DEFAULT_VIP_CONFIG } from "../vipConfig";
import { scoreRisk } from "../riskScorer";
import type { HniResolution, OrderSignals, VipConfig, VipSignals } from "../types";

/** No pincode by default, so HNI reports NO_PINCODE unless a test says otherwise. */
const NO_PINCODE: HniResolution = { status: "NO_PINCODE", pincode: null, record: null };

function baseVipSignals(overrides: Partial<VipSignals> = {}): VipSignals {
  return {
    orderId: 1001,
    orderType: "HOME_SAMPLE",
    storeId: 3,
    storeCity: "Hyderabad",
    customerId: 8841,
    customerOrderCount: 2,
    pincode: null,
    hni: NO_PINCODE,
    ...overrides,
  };
}

/** A config with the ops lists populated, for exercising the rules. */
function configuredVip(overrides: Partial<VipConfig> = {}): VipConfig {
  return {
    ...DEFAULT_VIP_CONFIG,
    vipCustomerIds: [8841],
    vipStoreIds: [3],
    vipCities: ["Hyderabad"],
    ...overrides,
  };
}

describe("resolveVip — default config is inert", () => {
  test("ships with empty lists, so nothing is VIP out of the box", () => {
    const r = resolveVip(baseVipSignals());
    assert.equal(r.vip, false);
    assert.deepEqual(r.reasons, []);
  });

  test("repeat-customer is disabled by default and says why", () => {
    const r = resolveVip(baseVipSignals({ customerOrderCount: 99 }));
    assert.equal(r.vip, false);
    const repeat = r.unavailable.find((u) => u.signal === "REPEAT_CUSTOMER");
    assert.ok(repeat, "REPEAT_CUSTOMER must be reported as unavailable");
    assert.match(repeat.reason, /no business threshold defined/);
  });

  test("the three blocked providers are always reported with reasons", () => {
    const r = resolveVip(baseVipSignals());
    const reported = r.unavailable.map((u) => u.signal);
    for (const blocked of ["VALUE", "CUSTOMER_TIER"]) {
      assert.ok(reported.includes(blocked), `${blocked} must be reported`);
    }
    for (const u of r.unavailable) {
      assert.ok(u.reason.length > 0, `${u.signal} has no reason text`);
    }
  });
});

describe("resolveVip — VIP = true", () => {
  test("customer on the ops VIP list", () => {
    const cfg = configuredVip({ vipStoreIds: [], vipCities: [] });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, true);
    assert.equal(r.reasons.length, 1);
    assert.equal(r.reasons[0].basis, "LIST");
    assert.equal(r.reasons[0].sourceField, "Order.userId");
  });

  test("store on the ops VIP list", () => {
    const cfg = configuredVip({ vipCustomerIds: [], vipCities: [] });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, true);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0].detail, /store 3/);
  });

  test("city match is case- and whitespace-insensitive", () => {
    const cfg = configuredVip({ vipCustomerIds: [], vipStoreIds: [], vipCities: ["hyderabad"] });
    const r = resolveVip(baseVipSignals({ storeCity: "  HYDERABAD " }), cfg);
    assert.equal(r.vip, true);
    assert.equal(r.reasons[0].sourceField, "Store.city");
  });

  test("repeat customer fires once enabled and the threshold is met", () => {
    const cfg = configuredVip({
      vipCustomerIds: [], vipStoreIds: [], vipCities: [],
      repeatCustomer: { enabled: true, minOrders: 5, windowMonths: 12 },
    });
    const r = resolveVip(baseVipSignals({ customerOrderCount: 9 }), cfg);
    assert.equal(r.vip, true);
    assert.equal(r.reasons[0].basis, "CUSTOMER");
    assert.match(r.reasons[0].detail, /9 orders in the last 12 months/);
  });

  test("vip is true if and only if there is at least one reason", () => {
    const cfg = configuredVip();
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, r.reasons.length > 0);
  });
});

describe("resolveVip — VIP = false", () => {
  test("no list matches and repeat below threshold", () => {
    const cfg = configuredVip({
      vipCustomerIds: [999], vipStoreIds: [77], vipCities: ["Pune"],
      repeatCustomer: { enabled: true, minOrders: 5, windowMonths: 12 },
    });
    const r = resolveVip(baseVipSignals({ customerOrderCount: 1 }), cfg);
    assert.equal(r.vip, false);
    assert.deepEqual(r.reasons, []);
    // All four providers were evaluable, so this is a confident "not VIP".
    assert.equal(r.evaluatedCount, 4);
  });

  test("a threshold boundary is inclusive at the threshold, exclusive below", () => {
    const cfg = configuredVip({
      vipCustomerIds: [], vipStoreIds: [], vipCities: [],
      repeatCustomer: { enabled: true, minOrders: 5, windowMonths: 12 },
    });
    assert.equal(resolveVip(baseVipSignals({ customerOrderCount: 4 }), cfg).vip, false);
    assert.equal(resolveVip(baseVipSignals({ customerOrderCount: 5 }), cfg).vip, true);
  });
});

describe("resolveVip — multiple reasons", () => {
  test("customer + store + city + repeat all fire together", () => {
    const cfg = configuredVip({
      repeatCustomer: { enabled: true, minOrders: 5, windowMonths: 12 },
    });
    const r = resolveVip(baseVipSignals({ customerOrderCount: 9 }), cfg);
    assert.equal(r.vip, true);
    assert.equal(r.reasons.length, 4);
    // Ordering follows the fixed provider order — deterministic.
    assert.deepEqual(r.reasons.map((x) => x.sourceField), [
      "Order.userId", "Order.storeId", "Store.city", "Order.userId (count)",
    ]);
    assert.deepEqual(r.reasons.map((x) => x.basis), ["LIST", "LIST", "LIST", "CUSTOMER"]);
    assert.deepEqual(r.reasons.map((x) => x.code), [
      "VIP_LIST_CUSTOMER", "VIP_LIST_STORE", "VIP_LIST_CITY", "REPEAT_CUSTOMER",
    ]);
  });

  test("every reason carries a non-empty code, label, detail and sourceField", () => {
    const cfg = configuredVip();
    const r = resolveVip(baseVipSignals(), cfg);
    for (const reason of r.reasons) {
      assert.ok(reason.code.length > 0);
      assert.ok(reason.label.length > 0);
      assert.ok(reason.basis.length > 0);
      assert.ok(reason.detail.length > 0);
      assert.ok(reason.sourceField.length > 0);
    }
  });

  test("no reason text leaks a patient identifier", () => {
    const cfg = configuredVip();
    const r = resolveVip(baseVipSignals({ customerId: 8841 }), cfg);
    for (const reason of r.reasons) {
      assert.ok(
        !reason.detail.includes("8841"),
        `reason "${reason.detail}" must not embed the customer id`,
      );
    }
  });
});

describe("resolveVip — missing information", () => {
  test("a missing userId makes customer rules unavailable, not false", () => {
    const cfg = configuredVip({ vipStoreIds: [], vipCities: [] });
    const r = resolveVip(baseVipSignals({ customerId: null }), cfg);
    assert.equal(r.vip, false);
    const codes = r.unavailable.map((u) => u.signal);
    assert.ok(codes.includes("LIST_CUSTOMER"));
  });

  test("a missing store and city make those rules unavailable", () => {
    const cfg = configuredVip({ vipCustomerIds: [] });
    const r = resolveVip(baseVipSignals({ storeId: null, storeCity: null }), cfg);
    const codes = r.unavailable.map((u) => u.signal);
    assert.ok(codes.includes("LIST_STORE"));
    assert.ok(codes.includes("LIST_CITY"));
  });

  test("an all-unknown order reports evaluatedCount 0 — 'not evaluated', not 'not VIP'", () => {
    const cfg = configuredVip();
    const r = resolveVip(
      baseVipSignals({ customerId: null, storeId: null, storeCity: null, customerOrderCount: null }),
      cfg,
    );
    assert.equal(r.vip, false);
    assert.equal(r.evaluatedCount, 0);
    // Five providers (HNI + four list/repeat) + two permanently blocked.
    assert.equal(r.unavailable.length, 7);
  });

  test("an uncomputed order count is unavailable, not treated as zero", () => {
    const cfg = configuredVip({
      vipCustomerIds: [], vipStoreIds: [], vipCities: [],
      repeatCustomer: { enabled: true, minOrders: 5, windowMonths: 12 },
    });
    const r = resolveVip(baseVipSignals({ customerOrderCount: null }), cfg);
    const repeat = r.unavailable.find((u) => u.signal === "REPEAT_CUSTOMER");
    assert.ok(repeat);
    assert.match(repeat.reason, /not computed/);
  });

  test("an empty-string city is treated as unknown, not as a non-match", () => {
    const cfg = configuredVip({ vipCustomerIds: [], vipStoreIds: [] });
    const r = resolveVip(baseVipSignals({ storeCity: "   " }), cfg);
    assert.ok(r.unavailable.some((u) => u.signal === "LIST_CITY"));
  });
});

describe("resolveVip — conflicting information", () => {
  test("an ops exclusion beats an inclusion, and says what it suppressed", () => {
    const cfg = configuredVip({ excludedCustomerIds: [8841] });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, false);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.suppressedBy, "EXCLUDED_CUSTOMER");
    assert.ok(r.suppressedReasons.length > 0, "the overridden rules must still be visible");
  });

  test("a customer on BOTH the VIP list and the exclusion list resolves to false", () => {
    const cfg = configuredVip({
      vipCustomerIds: [8841], excludedCustomerIds: [8841],
      vipStoreIds: [], vipCities: [],
    });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, false);
    assert.equal(r.suppressedBy, "EXCLUDED_CUSTOMER");
    assert.equal(r.suppressedReasons.length, 1);
  });

  test("a store exclusion suppresses even a customer-list match", () => {
    const cfg = configuredVip({ excludedStoreIds: [3], vipCities: [] });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, false);
    assert.equal(r.suppressedBy, "EXCLUDED_STORE");
  });

  test("an exclusion with nothing to suppress does not fabricate a suppression", () => {
    const cfg = configuredVip({
      vipCustomerIds: [], vipStoreIds: [], vipCities: [],
      excludedCustomerIds: [8841],
    });
    const r = resolveVip(baseVipSignals(), cfg);
    assert.equal(r.vip, false);
    assert.equal(r.suppressedBy, null);
    assert.deepEqual(r.suppressedReasons, []);
  });

  test("exclusion resolution is deterministic across repeated calls", () => {
    const cfg = configuredVip({ excludedCustomerIds: [8841] });
    const signals = baseVipSignals();
    const first = resolveVip(signals, cfg);
    for (let i = 0; i < 50; i++) {
      assert.deepStrictEqual(resolveVip(signals, cfg), first);
    }
  });
});

describe("resolveVip — independence from risk", () => {
  test("VIP is identical whether the same order scores LOW or CRITICAL", () => {
    const cfg = configuredVip();
    const vipSignals = baseVipSignals();

    const lowRisk: OrderSignals = {
      orderId: 1001, orderType: "HOME_SAMPLE", orderStatus: "PHLEBO_ASSIGNED",
      storeId: 3, minutesToAppointment: 600, minutesSinceCreated: 120,
      minutesSinceStatusUpdated: 5, leadTimeMinutes: 1440, appointmentIstHour: 14,
      hasPhleboAssigned: true, rescheduleCommunicationSent: false,
    };
    const criticalRisk: OrderSignals = {
      ...lowRisk, orderStatus: "ORDER_SCHEDULED", minutesToAppointment: 20,
      minutesSinceStatusUpdated: 500, leadTimeMinutes: 30, appointmentIstHour: 6,
      hasPhleboAssigned: false, rescheduleCommunicationSent: true,
    };

    // Confirm the two risk inputs really do land in different bands...
    assert.equal(scoreRisk(lowRisk).band, "LOW");
    assert.equal(scoreRisk(criticalRisk).band, "CRITICAL");

    // ...and that VIP is unmoved by either.
    const vipBefore = resolveVip(vipSignals, cfg);
    scoreRisk(lowRisk);
    const vipAfterLow = resolveVip(vipSignals, cfg);
    scoreRisk(criticalRisk);
    const vipAfterCritical = resolveVip(vipSignals, cfg);

    assert.deepStrictEqual(vipAfterLow, vipBefore);
    assert.deepStrictEqual(vipAfterCritical, vipBefore);
  });

  test("VipSignals carries no risk field the classifier could read", () => {
    const keys = Object.keys(baseVipSignals());
    for (const forbidden of ["riskScore", "riskBand", "risk", "isPriority", "score", "band"]) {
      assert.ok(!keys.includes(forbidden), `VipSignals must not expose ${forbidden}`);
    }
  });

  test("classification does not mutate its inputs", () => {
    const cfg = configuredVip();
    const signals = baseVipSignals();
    const signalsSnapshot = JSON.parse(JSON.stringify(signals));
    const configSnapshot = JSON.parse(JSON.stringify(cfg));
    resolveVip(signals, cfg);
    assert.deepStrictEqual(signals, signalsSnapshot);
    assert.deepStrictEqual(cfg, configSnapshot);
  });
});
