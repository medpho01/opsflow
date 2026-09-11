-- Preserve the reference data's own vocabulary on hni_pincodes.
--
-- WHY: the supplied reference dataset states pin_purity as PURE / MIXED /
-- UNKNOWN. The existing HniClassification enum has no UNKNOWN, so loading
-- that data would have forced every UNKNOWN row to be silently rewritten as
-- HNI or MIXED — asserting something the source does not say. UNKNOWN is
-- therefore added as a first-class value, and tier / pin_purity / confidence
-- are stored verbatim so `classification` stays a reversible mapping.
--
-- Additive only: one new enum value and three new nullable columns. No
-- existing column, row, index or constraint is altered or dropped.
-- Idempotent (IF NOT EXISTS / duplicate_object guards).

ALTER TYPE taskos."HniClassification" ADD VALUE IF NOT EXISTS 'UNKNOWN';

DO $$ BEGIN
  CREATE TYPE taskos."HniTier" AS ENUM ('A', 'B', 'C');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE taskos."HniPinPurity" AS ENUM ('PURE', 'MIXED', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE taskos."HniConfidence" AS ENUM ('HIGH', 'MED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE taskos."hni_pincodes"
  ADD COLUMN IF NOT EXISTS "tier"       taskos."HniTier",
  ADD COLUMN IF NOT EXISTS "pinPurity"  taskos."HniPinPurity",
  ADD COLUMN IF NOT EXISTS "confidence" taskos."HniConfidence";

-- Reversal (documentation; do not run in normal operation):
-- ALTER TABLE taskos."hni_pincodes"
--   DROP COLUMN "tier", DROP COLUMN "pinPurity", DROP COLUMN "confidence";
-- DROP TYPE taskos."HniConfidence"; DROP TYPE taskos."HniPinPurity";
-- DROP TYPE taskos."HniTier";
-- (the added enum value cannot be dropped without recreating the type)
