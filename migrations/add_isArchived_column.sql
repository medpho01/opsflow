-- Migration: Add isArchived column to tasks table
-- Purpose: Enable archiving of old stuck tasks without deletion
-- Date: 2026-04-30

BEGIN;

-- Add isArchived column with default value
ALTER TABLE taskos.tasks
ADD COLUMN "isArchived" BOOLEAN DEFAULT false NOT NULL;

-- Create index for filtering active tasks (most common query)
CREATE INDEX idx_tasks_is_archived ON taskos.tasks("isArchived");

-- Create partial index for active tasks query performance
CREATE INDEX idx_tasks_active ON taskos.tasks(id)
WHERE "isArchived" = false;

-- Verify column was added
\d taskos.tasks

COMMIT;
