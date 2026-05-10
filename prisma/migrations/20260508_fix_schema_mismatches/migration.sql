-- Fix schema mismatches between database and Prisma schema
-- Add missing columns and update field names

-- Create enum type for TaskRuleTriggerType if it doesn't exist
DO $$ BEGIN
    CREATE TYPE "TaskRuleTriggerType" AS ENUM ('STATUS', 'TIME');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 1. Add triggerType column to task_rules (if not already present)
ALTER TABLE "task_rules"
ADD COLUMN IF NOT EXISTS "triggerType" "TaskRuleTriggerType" NOT NULL DEFAULT 'TIME';

-- 2. Fix polling_logs table
-- Rename completedAt to finishedAt only if completedAt still exists
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'polling_logs'
          AND column_name = 'completedAt'
    ) THEN
        ALTER TABLE "polling_logs" RENAME COLUMN "completedAt" TO "finishedAt";
    END IF;
END $$;

-- Add ordersFound column if it doesn't exist
ALTER TABLE "polling_logs"
ADD COLUMN IF NOT EXISTS "ordersFound" INTEGER NOT NULL DEFAULT 0;

-- Add status column if it doesn't exist
ALTER TABLE "polling_logs"
ADD COLUMN IF NOT EXISTS "status" VARCHAR(255) NOT NULL DEFAULT 'SUCCESS';

-- Add errorMessage column if it doesn't exist
ALTER TABLE "polling_logs"
ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- Add durationMs column if it doesn't exist
ALTER TABLE "polling_logs"
ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;

-- Create index on finishedAt for query optimization
CREATE INDEX IF NOT EXISTS "polling_logs_finishedAt_idx" ON "polling_logs"("finishedAt");

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS "polling_logs_status_idx" ON "polling_logs"("status");
