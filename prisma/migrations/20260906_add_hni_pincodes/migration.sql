-- HNI pincode reference data for the Priority Orders VIP engine.
--
-- Additive only: one new table and two new enums in the `taskos` schema.
-- No existing table, column, enum value, index, or row is touched, and
-- nothing in the source (labstack) schema is referenced.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards) because
-- docker/entrypoint.sh deploys via `prisma db push`, not `migrate deploy`.
--
-- Operator-maintained: rows are expected to be added, deactivated and
-- re-classified by operations directly. See prisma/seed_hni_pincodes.ts for
-- the CSV/JSON loader.
--
-- To reverse: DROP TABLE taskos."hni_pincodes"; then the two types.

DO $$ BEGIN
  CREATE TYPE taskos."HniClassification" AS ENUM ('HNI', 'NON_HNI', 'MIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE taskos."HniProvenance" AS ENUM ('REFERENCE', 'PLACEHOLDER_DEV');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS taskos."hni_pincodes" (
  "id"             SERIAL PRIMARY KEY,
  -- Normalised at write time: digits only, exactly six.
  "pincode"        VARCHAR(6) NOT NULL,
  "locality"       TEXT,
  "city"           TEXT,
  "state"          TEXT,
  "classification" taskos."HniClassification" NOT NULL,
  -- Optional confidence/purity from the reference data. Never inferred.
  "purityPct"      INTEGER,
  "rationale"      TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "provenance"     taskos."HniProvenance" NOT NULL DEFAULT 'REFERENCE',
  "sourceLabel"    TEXT,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One active classification per pincode; re-loading updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS "hni_pincodes_pincode_key"
  ON taskos."hni_pincodes" ("pincode");
CREATE INDEX IF NOT EXISTS "hni_pincodes_classification_isActive_idx"
  ON taskos."hni_pincodes" ("classification", "isActive");
CREATE INDEX IF NOT EXISTS "hni_pincodes_city_idx"
  ON taskos."hni_pincodes" ("city");
CREATE INDEX IF NOT EXISTS "hni_pincodes_provenance_idx"
  ON taskos."hni_pincodes" ("provenance");

-- Guard against a malformed pincode reaching the table by any path.
DO $$ BEGIN
  ALTER TABLE taskos."hni_pincodes"
    ADD CONSTRAINT "hni_pincodes_pincode_format" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reversal (documentation; do not run in normal operation):
-- DROP TABLE IF EXISTS taskos."hni_pincodes";
-- DROP TYPE  IF EXISTS taskos."HniProvenance";
-- DROP TYPE  IF EXISTS taskos."HniClassification";
