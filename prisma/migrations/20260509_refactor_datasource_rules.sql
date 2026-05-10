-- Migration: Refactor Data Sources, Task Rules, and Team Capabilities
-- Replaces OrderType enum with DataSource-based references
-- Polling moves from DataSource to TaskRule level

-- ── 1. TeamMember: add assignment fields ─────────────────────────────
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS "autoAssignEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS "assignmentPriority" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS "assignmentMode" TEXT NOT NULL DEFAULT 'ROUND_ROBIN';

-- ── 2. TaskRule: add new columns ──────────────────────────────────────
ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS "dataSourceId" TEXT;
ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS "allowedTypes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS "allowedStatuses" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS "pollingIntervalMinutes" INTEGER NOT NULL DEFAULT 15;

-- Migrate dataSourceId + allowedTypes/statuses from source scopes into rules
UPDATE task_rules tr
SET
  "dataSourceId"           = trss."dataSourceId",
  "allowedTypes"           = trss."allowedTypes",
  "allowedStatuses"        = trss."allowedStatuses",
  "pollingIntervalMinutes" = COALESCE(
    (SELECT ds."pollingIntervalMinutes" FROM data_sources ds WHERE ds.id = trss."dataSourceId"),
    15
  )
FROM task_rule_source_scopes trss
WHERE trss."taskRuleId" = tr.id;

-- For rules still without a dataSourceId, assign the first active data source
UPDATE task_rules
SET "dataSourceId" = (SELECT id FROM data_sources WHERE "isActive" = true ORDER BY "createdAt" LIMIT 1)
WHERE "dataSourceId" IS NULL
  AND (SELECT COUNT(*) FROM data_sources WHERE "isActive" = true) > 0;

-- ── 3. Task: change orderType from enum to text ────────────────────────
-- First drop the default if it's enum-typed
ALTER TABLE tasks ALTER COLUMN "orderType" DROP DEFAULT;
-- Cast enum to text
ALTER TABLE tasks ALTER COLUMN "orderType" TYPE TEXT USING "orderType"::TEXT;

-- ── 4. Create team_member_capabilities table ──────────────────────────
CREATE TABLE IF NOT EXISTS team_member_capabilities (
  id              SERIAL PRIMARY KEY,
  "teamMemberId"  INTEGER NOT NULL,
  "dataSourceId"  TEXT NOT NULL,
  "assignedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "assignedBy"    INTEGER,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_capability_team_member FOREIGN KEY ("teamMemberId") REFERENCES team_members(id) ON DELETE CASCADE,
  CONSTRAINT uq_capability UNIQUE ("teamMemberId", "dataSourceId")
);
CREATE INDEX IF NOT EXISTS idx_capabilities_team_member ON team_member_capabilities("teamMemberId");
CREATE INDEX IF NOT EXISTS idx_capabilities_data_source ON team_member_capabilities("dataSourceId");

-- Migrate from team_member_order_types → team_member_capabilities
-- Map all existing assignments to the first active data source (best-effort)
INSERT INTO team_member_capabilities ("teamMemberId", "dataSourceId", "assignedAt", "assignedBy", "createdAt", "updatedAt")
SELECT
  tmot."teamMemberId",
  COALESCE(
    (SELECT ds.id FROM data_sources ds WHERE ds."isActive" = true ORDER BY ds."createdAt" LIMIT 1),
    'UNKNOWN'
  ),
  tmot."assignedAt",
  tmot."assignedBy",
  tmot."createdAt",
  tmot."updatedAt"
FROM team_member_order_types tmot
ON CONFLICT ("teamMemberId", "dataSourceId") DO NOTHING;

-- ── 5. RoundRobinState: add dataSourceId column ───────────────────────
ALTER TABLE round_robin_states ADD COLUMN IF NOT EXISTS "dataSourceId" TEXT;

-- Map existing round robin states to first active data source
UPDATE round_robin_states
SET "dataSourceId" = (SELECT id FROM data_sources WHERE "isActive" = true ORDER BY "createdAt" LIMIT 1)
WHERE "dataSourceId" IS NULL;

-- Drop the old orderType unique constraint and add new one
DO $$
BEGIN
  -- Drop old unique constraint on orderType if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'round_robin_states_orderType_key'
    AND conrelid = 'round_robin_states'::regclass
  ) THEN
    ALTER TABLE round_robin_states DROP CONSTRAINT "round_robin_states_orderType_key";
  END IF;
END $$;

-- Add unique constraint on dataSourceId (only if we have data)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'round_robin_states_dataSourceId_key'
    AND conrelid = 'round_robin_states'::regclass
  ) THEN
    -- Remove duplicates first
    DELETE FROM round_robin_states rrs1
    USING round_robin_states rrs2
    WHERE rrs1.id > rrs2.id
      AND rrs1."dataSourceId" = rrs2."dataSourceId"
      AND rrs1."dataSourceId" IS NOT NULL;

    ALTER TABLE round_robin_states ADD CONSTRAINT "round_robin_states_dataSourceId_key" UNIQUE ("dataSourceId");
  END IF;
END $$;

-- ── 6. Drop the OrderType enum (after all column type changes) ────────
DO $$
BEGIN
  -- Only drop if it exists and no columns reference it
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderType') THEN
    DROP TYPE IF EXISTS "OrderType" CASCADE;
  END IF;
END $$;

-- ── 7. Add FK from task_rules to data_sources ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_task_rules_data_source'
    AND conrelid = 'task_rules'::regclass
  ) THEN
    -- Only add if all rules have a valid dataSourceId
    IF NOT EXISTS (
      SELECT 1 FROM task_rules WHERE "dataSourceId" IS NULL
    ) THEN
      ALTER TABLE task_rules
        ADD CONSTRAINT "fk_task_rules_data_source"
        FOREIGN KEY ("dataSourceId") REFERENCES data_sources(id);
    END IF;
  END IF;
END $$;
