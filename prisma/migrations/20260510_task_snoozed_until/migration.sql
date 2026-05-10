-- W5 — Task snooze.
-- Agent presses "Ping me in 15m" and the task drops out of their Active
-- list until snoozedUntil passes. Null when not snoozed. No scheduler is
-- needed; the queries that drive the agent's tab simply filter
-- (snoozedUntil IS NULL OR snoozedUntil < NOW()), so a task re-appears
-- automatically once its time is up.
ALTER TABLE taskos.tasks
  ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMPTZ;

-- Partial index speeds up the agent's "Active, not snoozed" filter as
-- the snooze population grows. Tasks with NULL snoozedUntil don't need
-- to live in this index — the predicate excludes them.
CREATE INDEX IF NOT EXISTS "idx_tasks_snoozed_until_active"
  ON taskos.tasks ("snoozedUntil")
  WHERE "snoozedUntil" IS NOT NULL AND "isArchived" = false;
