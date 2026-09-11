/**
 * VIP classification config — held as DATA.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️  APPROVAL STATUS
 *
 * No VIP rule in this file has been approved. The repository contains NO
 * reliable information for the three signals the PRD asks for:
 *
 *   HNI          MISSING — no pincode / lat-long / address on Order or User.
 *                Blocks BOTH PRD options: (a) needs order value to derive
 *                affluence from where high-value orders come from, and (b)
 *                needs a location key to join an external dataset against.
 *   VALUE        MISSING — no amount/price/total column anywhere; no Test,
 *                Package, Payment, or Invoice table exists in labstack.
 *   CUSTOMER     MISSING — public."User" is selected as `u.name` in all six
 *                places it is joined (engine, API, seed, demo). No tier,
 *                premium, segment, or LTV field is referenced.
 *
 * What remains is buildable from confirmed fields but needs a business
 * definition, so BOTH are shipped INERT:
 *
 *   LIST_*           ops-maintained lists, EMPTY by default.
 *   REPEAT_CUSTOMER  DISABLED by default — no threshold has been defined,
 *                    and "repeat implies VIP" is itself an unmade decision.
 *
 * With these defaults the classifier returns vip=false for every order and
 * reports three unavailable providers. That is the honest starting state: it
 * cannot claim anyone is VIP until you supply the data.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { VipConfig } from "./types";

/** Bumped when the SHAPE of the VIP model changes (providers added/removed). */
export const VIP_EVALUATOR_VERSION = "vip-1.0.0";

export const DEFAULT_VIP_CONFIG: VipConfig = {
  configVersion: 1,

  // PROPOSED — REQUIRES BUSINESS APPROVAL (who supplies these, keyed on what).
  // Order.userId — confirmed present.
  vipCustomerIds: [],
  // Order.storeId — confirmed present.
  vipStoreIds: [],
  // Store.city — confirmed present (see /api/stores/overview StoreRow.city).
  // NOTE: this is the collection CENTRE's city, not the patient's location.
  // It is a weak proxy and is explicitly NOT an affluence signal.
  vipCities: [],

  // Ops corrections. Exclusion beats inclusion — see vipResolver.
  excludedCustomerIds: [],
  excludedStoreIds: [],

  /**
   * HNI is now WIRED: pincode -> normalisation -> reference lookup -> signal.
   * It is enabled, but produces a VIP hit only where the reference table
   * explicitly classifies the pincode as HNI.
   *
   * With an empty reference table every order resolves to NOT_CLASSIFIED and,
   * under the default unlistedPolicy, the signal reports UNDETERMINED — the
   * honest outcome, and never a false "not VIP".
   */
  hni: {
    enabled: true,
    // PROPOSED — REQUIRES BUSINESS APPROVAL. Defaults chosen to avoid
    // asserting more than the data supports.
    mixedPolicy: "UNDETERMINED",
    unlistedPolicy: "UNDETERMINED",
    // UNKNOWN means the reference data never established PIN-to-locality
    // purity. Defaulting to UNDETERMINED reports that honestly instead of
    // inventing either "affluent" or "not affluent".
    unknownPolicy: "UNDETERMINED",
    minPurityPct: null,
  },

  repeatCustomer: {
    enabled: false,
    // PROPOSED — REQUIRES BUSINESS APPROVAL. Placeholders, deliberately
    // inert: `enabled: false` means these numbers are never read.
    minOrders: 5,
    windowMonths: 12,
  },

  blockedProviders: [
    {
      provider: "VALUE",
      reason: "no order-value/amount/price column exists; no Test, Package, " +
        "Payment or Invoice table exists in labstack",
    },
    {
      provider: "CUSTOMER_TIER",
      reason: "public.\"User\" is only ever selected as u.name; no tier, " +
        "premium, segment or LTV attribute is referenced anywhere",
    },
  ],
};
