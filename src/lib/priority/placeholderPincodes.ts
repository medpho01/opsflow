/**
 * PLACEHOLDER HNI reference rows for local development only.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️  THESE ARE NOT REAL PINCODES AND NOT REAL CLASSIFICATIONS.
 *
 * Every value uses the 9xxxxx range. India's postal system never issues a
 * PIN beginning with 9 (first digits run 1-8), so these cannot collide with
 * a real pincode and cannot be mistaken for operator-supplied data.
 *
 * They exist solely so the pincode → lookup → HNI signal → VIP path can be
 * exercised before real reference data arrives. Every row is written with
 * provenance PLACEHOLDER_DEV and is removable with a single predicate:
 *
 *     DELETE FROM taskos."hni_pincodes" WHERE "provenance" = 'PLACEHOLDER_DEV';
 *
 * Real reference data is loaded separately by prisma/seed_hni_pincodes.ts
 * and lands with provenance REFERENCE. No HNI classification for any real
 * pincode has been invented here or anywhere else in this codebase.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { HniPincodeRecord } from "./types";

export const PLACEHOLDER_SOURCE_LABEL = "placeholder-dev-v1";

export const PLACEHOLDER_HNI_PINCODES: HniPincodeRecord[] = [
  {
    pincode: "900001",
    locality: "Placeholder Heights",
    city: "Testville",
    state: "Test State",
    classification: "HNI",
    purityPct: 95,
    rationale: "Placeholder row: exercises a clean HNI match.",
  },
  {
    pincode: "900002",
    locality: "Placeholder Gardens",
    city: "Testville",
    state: "Test State",
    classification: "HNI",
    purityPct: 82,
    rationale: "Placeholder row: HNI with lower stated purity.",
  },
  {
    pincode: "900003",
    locality: "Placeholder Fields",
    city: "Testville",
    state: "Test State",
    classification: "NON_HNI",
    purityPct: 90,
    rationale: "Placeholder row: exercises an explicit non-HNI match.",
  },
  {
    pincode: "900004",
    locality: "Placeholder Junction",
    city: "Otherton",
    state: "Test State",
    classification: "NON_HNI",
    purityPct: null,
    rationale: "Placeholder row: non-HNI with no purity stated.",
  },
  {
    pincode: "900005",
    locality: "Placeholder Crossing",
    city: "Otherton",
    state: "Test State",
    classification: "MIXED",
    purityPct: 50,
    rationale:
      "Placeholder row: genuinely mixed area. Must NOT be promoted to HNI " +
      "automatically — resolution is a business-rule decision.",
  },
  {
    pincode: "900006",
    locality: "Placeholder Bazaar",
    city: "Otherton",
    state: "Test State",
    classification: "MIXED",
    purityPct: null,
    rationale: "Placeholder row: mixed area with no purity stated.",
  },
  {
    pincode: "900007",
    locality: "Placeholder Annexe",
    city: "Testville",
    state: "Test State",
    classification: "HNI",
    purityPct: 70,
    rationale: "Placeholder row: HNI record that is deactivated below.",
  },
];

/**
 * Pincodes deliberately absent from the set above, so the NOT_CLASSIFIED
 * path can be exercised against a valid-but-unlisted value.
 */
export const PLACEHOLDER_UNLISTED_PINCODE = "900099";

/** Deactivated in the loader, to prove inactive rows resolve as unclassified. */
export const PLACEHOLDER_INACTIVE_PINCODE = "900007";
