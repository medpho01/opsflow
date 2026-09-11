/**
 * VIP classifier — pure, deterministic, explainable, and structurally unable
 * to see a risk score.
 *
 * Guarantees, all structural rather than promised:
 *   • No database access. Imports no client, holds no handle on one.
 *     Persistence is the caller's job (see shadowDb.ts).
 *   • No network, no API calls, no LLM. Only local types and a config object.
 *   • No clock — the classifier reads no time at all, so it is replayable.
 *   • No operational side effects. It returns a value; it changes nothing.
 *   • INDEPENDENT OF RISK. This module does not import riskScorer, and
 *     VipSignals carries no risk field. `isPriority` is composed by the
 *     caller, never here.
 *
 * Output shape: `vip` is derived FROM `reasons`, so a true with no reason is
 * unrepresentable.
 *
 * Provider model — each returns exactly one of:
 *   HIT          rule matched; contributes a VipReason
 *   MISS         evaluated, did not match
 *   UNAVAILABLE  could not be evaluated (input missing, or permanently
 *                blocked); reported so "not measured" never reads as
 *                "not VIP"
 *
 * An order where every provider is UNAVAILABLE returns vip=false with
 * evaluatedCount=0, which the UI must render as "VIP not evaluated" rather
 * than "not VIP".
 */
import type {
  UnavailableSignal,
  VipConfig,
  VipProviderCode,
  VipReason,
  VipResult,
  VipSignals,
} from "./types";
import { DEFAULT_VIP_CONFIG } from "./vipConfig";

interface ProviderVerdict {
  kind: "HIT" | "MISS" | "UNAVAILABLE";
  reason?: VipReason;
  unavailableReason?: string;
}

const MISS: ProviderVerdict = { kind: "MISS" };

function unavailable(reason: string): ProviderVerdict {
  return { kind: "UNAVAILABLE", unavailableReason: reason };
}

/** Case- and whitespace-insensitive city comparison, so "  Hyderabad " matches "hyderabad". */
function normalizeCity(city: string): string {
  return city.trim().toLowerCase();
}

// ── Providers ─────────────────────────────────────────────────────────────

function evalListCustomer(s: VipSignals, cfg: VipConfig): ProviderVerdict {
  if (s.customerId === null) return unavailable("order has no userId");
  if (!cfg.vipCustomerIds.includes(s.customerId)) return MISS;
  return {
    kind: "HIT",
    reason: {
      code: "VIP_LIST_CUSTOMER",
      label: "VIP customer",
      basis: "LIST",
      // The customer id is deliberately NOT interpolated here: reason text is
      // persisted, and no patient identifier belongs in the shadow tables.
      detail: "customer is on the ops VIP customer list",
      sourceField: "Order.userId",
    },
  };
}

function evalListStore(s: VipSignals, cfg: VipConfig): ProviderVerdict {
  if (s.storeId === null) return unavailable("order has no storeId");
  if (!cfg.vipStoreIds.includes(s.storeId)) return MISS;
  return {
    kind: "HIT",
    reason: {
      code: "VIP_LIST_STORE",
      label: "VIP store",
      basis: "LIST",
      detail: `store ${s.storeId} is on the ops VIP store list`,
      sourceField: "Order.storeId",
    },
  };
}

function evalListCity(s: VipSignals, cfg: VipConfig): ProviderVerdict {
  if (s.storeCity === null || s.storeCity.trim() === "") {
    return unavailable("store city is unknown");
  }
  const city = normalizeCity(s.storeCity);
  if (!cfg.vipCities.some((c) => normalizeCity(c) === city)) return MISS;
  return {
    kind: "HIT",
    reason: {
      code: "VIP_LIST_CITY",
      label: "VIP city",
      basis: "LIST",
      detail: `${s.storeCity.trim()} is on the ops VIP city list`,
      sourceField: "Store.city",
    },
  };
}

/**
 * HNI — is the delivery pincode in an area classified as high-net-worth?
 *
 * The final step of the pincode path:
 *   order.pincode -> normalizePincode -> HniLookup.resolve -> HERE -> VipReason
 *
 * This provider applies the business rule; it never re-interprets the data.
 * In particular a MIXED classification is NOT a VIP hit unless the operator
 * has explicitly set mixedPolicy to "VIP" — an ambiguous area stays
 * ambiguous, and is reported as undetermined rather than resolved by guess.
 */
function evalHni(s: VipSignals, cfg: VipConfig): ProviderVerdict {
  if (!cfg.hni.enabled) {
    return unavailable("HNI signal is disabled in configuration");
  }

  switch (s.hni.status) {
    case "NO_PINCODE":
      return unavailable("order has no delivery pincode");
    case "INVALID_PINCODE":
      return unavailable("order pincode is not a valid six-digit value");
    case "NOT_CLASSIFIED":
      // An incomplete reference table cannot support "this area is not
      // affluent", so the default is to report rather than to deny.
      return cfg.hni.unlistedPolicy === "NOT_VIP"
        ? MISS
        : unavailable("pincode is not present in the HNI reference data");
    case "CLASSIFIED":
      break;
  }

  const record = s.hni.record;
  if (!record) {
    return unavailable("HNI lookup reported a classification with no record");
  }

  // An HNI row whose stated purity falls below the configured floor is
  // demoted to MIXED rather than accepted — the floor exists precisely so a
  // weakly-classified area does not read as a confident one.
  const belowPurityFloor =
    cfg.hni.minPurityPct !== null &&
    record.purityPct !== null &&
    record.purityPct < cfg.hni.minPurityPct;

  const effective =
    record.classification === "HNI" && belowPurityFloor
      ? "MIXED"
      : record.classification;

  if (effective === "NON_HNI") return MISS;

  // UNKNOWN is deliberately NOT folded into MIXED. MIXED asserts "this PIN
  // demonstrably contains both affluent and non-affluent areas"; UNKNOWN
  // asserts only that the reference data never established the PIN-to-
  // locality mapping. Collapsing the two would put a claim in the operator's
  // mouth that the source does not make.
  if (effective === "UNKNOWN") {
    if (cfg.hni.unknownPolicy === "NOT_VIP") return MISS;
    if (cfg.hni.unknownPolicy === "UNDETERMINED") {
      return unavailable(
        `pincode ${record.pincode} is classified UNKNOWN: the reference data ` +
        "does not establish how cleanly this PIN maps to the affluent " +
        "locality, so HNI is undetermined",
      );
    }
    return {
      kind: "HIT",
      reason: {
        code: "HNI_PINCODE_UNKNOWN",
        label: "HNI area (purity unverified)",
        basis: "HNI",
        detail:
          `pincode ${record.pincode} is classified UNKNOWN and policy treats ` +
          "unverified-purity areas as HNI",
        sourceField: "HniPincode.classification",
      },
    };
  }

  if (effective === "MIXED") {
    if (cfg.hni.mixedPolicy === "NOT_VIP") return MISS;
    if (cfg.hni.mixedPolicy === "UNDETERMINED") {
      return unavailable(
        `pincode ${record.pincode} is classified MIXED; no business rule is ` +
        "defined for mixed areas, so HNI is undetermined",
      );
    }
    return {
      kind: "HIT",
      reason: {
        code: "HNI_PINCODE_MIXED",
        label: "HNI area (mixed)",
        basis: "HNI",
        detail:
          `pincode ${record.pincode} is classified MIXED and policy treats ` +
          "mixed areas as HNI",
        sourceField: "HniPincode.classification",
      },
    };
  }

  const purity = record.purityPct === null ? "" : ` (purity ${record.purityPct}%)`;
  const where = record.locality ?? record.city ?? "area";
  return {
    kind: "HIT",
    reason: {
      code: "HNI_PINCODE",
      label: "HNI area",
      basis: "HNI",
      detail: `pincode ${record.pincode} — ${where} is classified HNI${purity}`,
      sourceField: "HniPincode.classification",
    },
  };
}

function evalRepeatCustomer(s: VipSignals, cfg: VipConfig): ProviderVerdict {
  if (!cfg.repeatCustomer.enabled) {
    return unavailable("repeat-customer rule is disabled: no business threshold defined");
  }
  if (s.customerId === null) return unavailable("order has no userId");
  if (s.customerOrderCount === null) {
    return unavailable("customer order count was not computed");
  }
  if (s.customerOrderCount < cfg.repeatCustomer.minOrders) return MISS;
  return {
    kind: "HIT",
    reason: {
      code: "REPEAT_CUSTOMER",
      label: "Repeat customer",
      basis: "CUSTOMER",
      detail:
        `repeat customer: ${s.customerOrderCount} orders in the last ` +
        `${cfg.repeatCustomer.windowMonths} months ` +
        `(threshold ${cfg.repeatCustomer.minOrders})`,
      sourceField: "Order.userId (count)",
    },
  };
}

/**
 * Fixed evaluation order. Reason ordering follows it exactly, so identical
 * inputs always produce an identically-ordered result.
 */
const PROVIDERS: ReadonlyArray<{
  code: VipProviderCode;
  run: (s: VipSignals, cfg: VipConfig) => ProviderVerdict;
}> = [
  { code: "HNI", run: evalHni },
  { code: "LIST_CUSTOMER", run: evalListCustomer },
  { code: "LIST_STORE", run: evalListStore },
  { code: "LIST_CITY", run: evalListCity },
  { code: "REPEAT_CUSTOMER", run: evalRepeatCustomer },
];

/**
 * Classify one order's VIP status.
 *
 * Conflict rule: an explicit ops EXCLUSION beats every inclusion rule. An
 * exclusion is a deliberate correction, so it wins — and the rules it
 * overrode are returned in `suppressedReasons` so a false stays as
 * explainable as a true.
 */
export function resolveVip(
  signals: VipSignals,
  config: VipConfig = DEFAULT_VIP_CONFIG,
): VipResult {
  // Permanently blocked providers are reported on every result so the board
  // can state what was not measured, rather than implying a confident "no".
  const unavailableSignals: UnavailableSignal[] = config.blockedProviders.map((b) => ({
    signal: b.provider,
    reason: b.reason,
  }));

  const hits: VipReason[] = [];
  let evaluatedCount = 0;

  for (const { code, run } of PROVIDERS) {
    const verdict = run(signals, config);
    switch (verdict.kind) {
      case "HIT":
        evaluatedCount++;
        if (verdict.reason) hits.push(verdict.reason);
        break;
      case "MISS":
        evaluatedCount++;
        break;
      case "UNAVAILABLE":
        unavailableSignals.push({
          signal: code,
          reason: verdict.unavailableReason ?? "input missing",
        });
        break;
    }
  }

  // Exclusion overrides. Checked after collection so we can report exactly
  // what was suppressed.
  const excludedByCustomer =
    signals.customerId !== null && config.excludedCustomerIds.includes(signals.customerId);
  const excludedByStore =
    signals.storeId !== null && config.excludedStoreIds.includes(signals.storeId);

  if ((excludedByCustomer || excludedByStore) && hits.length > 0) {
    const suppressedBy = excludedByCustomer
      ? "EXCLUDED_CUSTOMER"
      : "EXCLUDED_STORE";
    return {
      vip: false,
      reasons: [],
      unavailable: unavailableSignals,
      suppressedReasons: hits,
      suppressedBy,
      evaluatedCount,
    };
  }

  return {
    vip: hits.length > 0,
    reasons: hits,
    unavailable: unavailableSignals,
    suppressedReasons: [],
    suppressedBy: null,
    evaluatedCount,
  };
}
