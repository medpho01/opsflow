/**
 * HNI pincode resolution — normalisation plus lookup.
 *
 * Pure and synchronous. The lookup is built once per run from an already-
 * loaded set of records, so scoring never performs a query per order and the
 * engines stay free of I/O.
 *
 * The complete path a pincode travels:
 *
 *     order.pincode (raw, source-shaped)
 *       -> normalizePincode()        strip separators, validate six digits
 *       -> InMemoryHniLookup.resolve()   map lookup, active rows only
 *       -> HniResolution             NO_PINCODE | INVALID_PINCODE
 *                                    | NOT_CLASSIFIED | CLASSIFIED
 *       -> vipResolver HNI provider  applies the business rule
 *       -> VipReason(basis "HNI")    or an unavailable entry explaining why
 *
 * This module makes NO judgement about whether a classification means VIP.
 * It reports what the reference data says; the VIP engine decides what to do
 * with it. That separation is what keeps the MIXED case honest.
 */
import type {
  HniLookup,
  HniPincodeRecord,
  HniResolution,
} from "./types";

/** Indian pincodes: exactly six digits, never leading zero. */
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/**
 * Normalise a source-supplied pincode to storage form.
 *
 * Accepts the shapes real data arrives in — "560 001", "560-001", numeric
 * 560001, stray whitespace — and returns six digits, or null when the value
 * cannot be a valid pincode. Returning null rather than guessing is what
 * lets the caller report INVALID_PINCODE instead of silently matching the
 * wrong area.
 */
export function normalizePincode(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "number" ? String(raw) : raw;
  const digits = text.replace(/[\s\-–—_.]/g, "").trim();
  if (!PINCODE_PATTERN.test(digits)) return null;
  return digits;
}

/**
 * Map-backed lookup. Construct it from whatever loaded the records — the
 * database table in a real run, a literal array in a test.
 *
 * Inactive rows are excluded at construction, so a deactivated pincode
 * resolves to NOT_CLASSIFIED rather than to a stale classification.
 */
export class InMemoryHniLookup implements HniLookup {
  private readonly byPincode: Map<string, HniPincodeRecord>;

  constructor(records: HniPincodeRecord[]) {
    this.byPincode = new Map();
    for (const record of records) {
      const normalized = normalizePincode(record.pincode);
      // A record whose own pincode is malformed is skipped rather than
      // indexed under a key nothing can ever match.
      if (normalized === null) continue;
      this.byPincode.set(normalized, { ...record, pincode: normalized });
    }
  }

  get size(): number {
    return this.byPincode.size;
  }

  resolve(rawPincode: string | null): HniResolution {
    if (rawPincode === null || rawPincode.trim() === "") {
      return { status: "NO_PINCODE", pincode: null, record: null };
    }
    const normalized = normalizePincode(rawPincode);
    if (normalized === null) {
      return { status: "INVALID_PINCODE", pincode: null, record: null };
    }
    const record = this.byPincode.get(normalized);
    if (!record) {
      return { status: "NOT_CLASSIFIED", pincode: normalized, record: null };
    }
    return { status: "CLASSIFIED", pincode: normalized, record };
  }
}

/**
 * A lookup holding nothing.
 *
 * This is the correct state when no reference data has been loaded: every
 * pincode resolves to NOT_CLASSIFIED, and the VIP engine reports HNI as
 * undetermined rather than asserting that no order is in an affluent area.
 */
export const EMPTY_HNI_LOOKUP: HniLookup = new InMemoryHniLookup([]);
