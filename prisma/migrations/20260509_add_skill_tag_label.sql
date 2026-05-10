-- Add label column to skill_tags (was in Prisma schema but missing from DB)
ALTER TABLE taskos.skill_tags ADD COLUMN IF NOT EXISTS label TEXT;

-- Backfill: default label to name for any existing rows
UPDATE taskos.skill_tags SET label = name WHERE label IS NULL;
