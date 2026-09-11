/**
 * HNI pincode reference-data loader.
 *
 * This is how HNI data gets into an environment — locally now, and in the
 * main environment later, by you, without a deploy.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   # Load your real reference data (CSV or JSON):
 *   npx tsx prisma/seed_hni_pincodes.ts --file ./hni_pincodes.csv
 *   npx tsx prisma/seed_hni_pincodes.ts --file ./hni_pincodes.json
 *
 *   # Load the fictional placeholder rows for local pipeline testing:
 *   npx tsx prisma/seed_hni_pincodes.ts --placeholders
 *
 *   # Remove every placeholder row (real data untouched):
 *   npx tsx prisma/seed_hni_pincodes.ts --clear-placeholders
 *
 *   # Show what is currently loaded:
 *   npx tsx prisma/seed_hni_pincodes.ts --summary
 *
 * ── CSV format ───────────────────────────────────────────────────────────
 * Header row required. Recognised columns (only `pincode` and
 * `classification` are mandatory):
 *
 *   pincode,locality,city,state,classification,purityPct,rationale,isActive
 *   560001,Example Locality,Bengaluru,Karnataka,HNI,90,Top-decile area,true
 *
 * `classification` must be exactly HNI, NON_HNI or MIXED.
 *
 * ── Behaviour ────────────────────────────────────────────────────────────
 * Idempotent: upserts on `pincode`, so re-running an updated file corrects
 * existing rows rather than duplicating them. Rows are NEVER deleted by a
 * load — deactivate by setting isActive=false in the file, which preserves
 * the classification and its rationale for audit.
 *
 * Nothing is inferred. A pincode absent from your file stays absent, and an
 * absent pincode is reported by the VIP engine as "not classified", not as
 * "not affluent".
 */
import * as dotenv from "dotenv";
import path from "path";
import { readFileSync } from "fs";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import {
  PLACEHOLDER_HNI_PINCODES,
  PLACEHOLDER_INACTIVE_PINCODE,
  PLACEHOLDER_SOURCE_LABEL,
} from "../src/lib/priority/placeholderPincodes";
import { normalizePincode } from "../src/lib/priority/hniLookup";

const prisma = new PrismaClient();

type Classification = "HNI" | "NON_HNI" | "MIXED" | "UNKNOWN";
const VALID: Classification[] = ["HNI", "NON_HNI", "MIXED", "UNKNOWN"];

type Tier = "A" | "B" | "C";
type PinPurity = "PURE" | "MIXED" | "UNKNOWN";
type Confidence = "HIGH" | "MED";

/**
 * The reference dataset states PIN-to-locality purity, not a VIP verdict.
 * The mapping to `classification` is fixed, total and reversible — the source
 * value is also stored verbatim in `pinPurity`, so nothing is lost:
 *
 *   PURE    -> HNI      the PIN maps cleanly to the affluent locality
 *   MIXED   -> MIXED    the PIN demonstrably contains both
 *   UNKNOWN -> UNKNOWN  purity was never established; NOT folded into MIXED
 *
 * No other interpretation is applied and no value is inferred.
 */
const PURITY_TO_CLASSIFICATION: Record<PinPurity, Classification> = {
  PURE: "HNI",
  MIXED: "MIXED",
  UNKNOWN: "UNKNOWN",
};

interface InputRow {
  pincode: string;
  locality?: string | null;
  city?: string | null;
  state?: string | null;
  classification: Classification;
  purityPct?: number | null;
  rationale?: string | null;
  isActive?: boolean;
  tier?: Tier | null;
  pinPurity?: PinPurity | null;
  confidence?: Confidence | null;
}

/** Minimal CSV reader: quoted fields with embedded commas are supported. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const header = splitRow(lines[0]).map((h) => h.replace(/^﻿/, ""));
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function coerceRow(raw: Record<string, unknown>, lineNo: number): InputRow {
  const pincode = normalizePincode(
    typeof raw.pincode === "number" ? raw.pincode : String(raw.pincode ?? ""),
  );
  if (pincode === null) {
    throw new Error(`row ${lineNo}: "${String(raw.pincode)}" is not a valid six-digit pincode`);
  }
  // Two accepted shapes. The reference dataset supplies `pin_purity`
  // (PURE/MIXED/UNKNOWN); the original loader format supplies an explicit
  // `classification`. Whichever is present is used as-is — never both.
  const rawPurity = String(raw.pin_purity ?? raw.pinPurity ?? "").trim().toUpperCase();
  let pinPurity: PinPurity | null = null;
  if (rawPurity !== "") {
    if (!["PURE", "MIXED", "UNKNOWN"].includes(rawPurity)) {
      throw new Error(
        `row ${lineNo} (pincode ${pincode}): pin_purity must be PURE, MIXED or UNKNOWN, got "${rawPurity}"`,
      );
    }
    pinPurity = rawPurity as PinPurity;
  }

  const classification = pinPurity !== null
    ? PURITY_TO_CLASSIFICATION[pinPurity]
    : (String(raw.classification ?? "").trim().toUpperCase() as Classification);
  if (!VALID.includes(classification)) {
    throw new Error(
      `row ${lineNo} (pincode ${pincode}): classification must be one of ${VALID.join(", ")}, got "${String(raw.classification)}"`,
    );
  }
  const purityRaw = raw.purityPct;
  let purityPct: number | null = null;
  if (purityRaw !== undefined && purityRaw !== null && String(purityRaw).trim() !== "") {
    const n = Number(purityRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`row ${lineNo} (pincode ${pincode}): purityPct must be 0-100`);
    }
    purityPct = Math.round(n);
  }
  const activeRaw = String(raw.isActive ?? "true").trim().toLowerCase();
  const optional = (v: unknown): string | null => {
    const t = v === undefined || v === null ? "" : String(v).trim();
    return t.length > 0 ? t : null;
  };
  const enumOrNull = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | null => {
    const t = v === undefined || v === null ? "" : String(v).trim().toUpperCase();
    if (t === "") return null;
    if (!allowed.includes(t as T)) {
      throw new Error(`row ${lineNo} (pincode ${pincode}): ${field} must be one of ${allowed.join(", ")}, got "${t}"`);
    }
    return t as T;
  };

  return {
    pincode,
    locality: optional(raw.locality),
    city: optional(raw.city),
    state: optional(raw.state),
    classification,
    purityPct,
    // The reference dataset calls this column `basis`.
    rationale: optional(raw.rationale ?? raw.basis),
    isActive: !(activeRaw === "false" || activeRaw === "0" || activeRaw === "no"),
    tier: enumOrNull(raw.tier, ["A", "B", "C"] as const, "tier"),
    pinPurity,
    confidence: enumOrNull(raw.confidence, ["HIGH", "MED"] as const, "confidence"),
  };
}

async function upsertRows(rows: InputRow[], provenance: "REFERENCE" | "PLACEHOLDER_DEV", sourceLabel: string) {
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await prisma.hniPincode.findUnique({
      where: { pincode: row.pincode }, select: { id: true },
    });
    await prisma.hniPincode.upsert({
      where: { pincode: row.pincode },
      create: { ...row, provenance, sourceLabel },
      update: { ...row, provenance, sourceLabel },
    });
    if (existing) updated++; else created++;
  }
  return { created, updated };
}

async function printSummary() {
  const rows = await prisma.hniPincode.findMany({
    select: { classification: true, provenance: true, isActive: true },
  });
  const tally = (key: "classification" | "provenance") => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
    return out;
  };
  console.log(`\nhni_pincodes: ${rows.length} row(s), ${rows.filter((r) => r.isActive).length} active`);
  console.log("  by classification:", JSON.stringify(tally("classification")));
  console.log("  by provenance    :", JSON.stringify(tally("provenance")));
  if (rows.length === 0) {
    console.log("\n  No reference data loaded. Every order will resolve to");
    console.log("  NOT_CLASSIFIED, and the VIP engine will report HNI as");
    console.log("  undetermined — never as a false 'not VIP'.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");

  if (args.includes("--summary")) {
    await printSummary();
    return;
  }

  if (args.includes("--clear-placeholders")) {
    const { count } = await prisma.hniPincode.deleteMany({
      where: { provenance: "PLACEHOLDER_DEV" },
    });
    console.log(`Removed ${count} placeholder row(s). Reference data untouched.`);
    await printSummary();
    return;
  }

  if (args.includes("--placeholders")) {
    console.log("Loading FICTIONAL placeholder pincodes (9xxxxx) for local testing only.");
    const rows: InputRow[] = PLACEHOLDER_HNI_PINCODES.map((r) => ({
      pincode: r.pincode,
      locality: r.locality,
      city: r.city,
      state: r.state,
      classification: r.classification,
      purityPct: r.purityPct,
      rationale: r.rationale,
      // One row is deliberately deactivated so the inactive path is exercisable.
      isActive: r.pincode !== PLACEHOLDER_INACTIVE_PINCODE,
    }));
    const { created, updated } = await upsertRows(rows, "PLACEHOLDER_DEV", PLACEHOLDER_SOURCE_LABEL);
    console.log(`  created ${created}, updated ${updated}`);
    await printSummary();
    return;
  }

  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.log(
      "Usage:\n" +
      "  --file <path.csv|path.json>   load real reference data\n" +
      "  --placeholders                load fictional dev rows\n" +
      "  --clear-placeholders          remove fictional dev rows\n" +
      "  --summary                     show what is loaded",
    );
    return;
  }

  const filePath = path.resolve(args[fileIdx + 1]);
  const text = readFileSync(filePath, "utf8");
  const rawRows: Record<string, unknown>[] = filePath.toLowerCase().endsWith(".json")
    ? (JSON.parse(text) as Record<string, unknown>[])
    : parseCsv(text);

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    console.error(`No rows found in ${filePath}`);
    process.exitCode = 1;
    return;
  }

  // Validate everything BEFORE writing anything: a half-loaded reference
  // table is worse than an unloaded one.
  const parsed: InputRow[] = [];
  const errors: string[] = [];
  rawRows.forEach((raw, i) => {
    try { parsed.push(coerceRow(raw, i + 2)); }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  });
  if (errors.length > 0) {
    console.error(`Refusing to load — ${errors.length} invalid row(s):`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }

  const seen = new Set<string>();
  for (const row of parsed) {
    if (seen.has(row.pincode)) {
      console.error(`Refusing to load — pincode ${row.pincode} appears more than once in the file.`);
      process.exitCode = 1;
      return;
    }
    seen.add(row.pincode);
  }

  const { created, updated } = await upsertRows(parsed, "REFERENCE", path.basename(filePath));
  console.log(`Loaded ${parsed.length} row(s) from ${path.basename(filePath)}: created ${created}, updated ${updated}`);
  await printSummary();
}

main()
  .catch((e) => {
    console.error("[HNI seed] Error:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
