/**
 * Loading HNI reference data out of the database into a lookup.
 *
 * Kept separate from hniLookup.ts so the lookup itself stays pure and
 * testable with a literal array. This is the only file that reads the
 * reference table.
 *
 * Reads only. The table is operator-maintained: rows are written by the
 * loader script (prisma/seed_hni_pincodes.ts) or by operations directly,
 * never by the shadow evaluator.
 */
import prisma from "@/lib/db/client";
import { InMemoryHniLookup } from "./hniLookup";
import type { HniLookup, HniPincodeRecord } from "./types";

/**
 * Build a lookup from every ACTIVE reference row.
 *
 * Loaded once per run: the table is small (a few thousand rows at most) and
 * per-order queries during scoring would put the engines back into I/O.
 *
 * Inactive rows are excluded here rather than filtered later, so a
 * deactivated pincode resolves as unclassified rather than as a stale
 * classification.
 */
export async function loadHniLookup(): Promise<HniLookup> {
  const rows = await prisma.hniPincode.findMany({
    where: { isActive: true },
    select: {
      pincode: true,
      locality: true,
      city: true,
      state: true,
      classification: true,
      purityPct: true,
      rationale: true,
      tier: true,
      pinPurity: true,
      confidence: true,
    },
  });

  const records: HniPincodeRecord[] = rows.map((r) => ({
    pincode: r.pincode,
    locality: r.locality,
    city: r.city,
    state: r.state,
    classification: r.classification,
    purityPct: r.purityPct,
    rationale: r.rationale,
    tier: r.tier,
    pinPurity: r.pinPurity,
    confidence: r.confidence,
  }));

  return new InMemoryHniLookup(records);
}

/** Counts by classification and provenance, for the loader's report. */
export async function hniReferenceSummary(): Promise<{
  total: number;
  active: number;
  byClassification: Record<string, number>;
  byProvenance: Record<string, number>;
}> {
  const rows = await prisma.hniPincode.findMany({
    select: { classification: true, provenance: true, isActive: true },
  });
  const byClassification: Record<string, number> = {};
  const byProvenance: Record<string, number> = {};
  let active = 0;
  for (const r of rows) {
    if (r.isActive) active++;
    byClassification[r.classification] = (byClassification[r.classification] ?? 0) + 1;
    byProvenance[r.provenance] = (byProvenance[r.provenance] ?? 0) + 1;
  }
  return { total: rows.length, active, byClassification, byProvenance };
}
