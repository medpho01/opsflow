-- W2 — Engine performance: indexes + checkpoint table.

-- ── W2.5 — Indexes ────────────────────────────────────────────────────────
-- isDuplicate / dedup-set preload reads `tasks` filtered by
-- (taskRuleId, isArchived = false). The unique on (taskRuleId, entityId)
-- doesn't cover the partial filter, so PG falls back to a wider scan as
-- the table grows. A partial index on isArchived = false is the cheapest
-- physical fix.
CREATE INDEX IF NOT EXISTS "idx_tasks_taskRuleId_entityType_entityId_active"
  ON taskos.tasks ("taskRuleId", "entityType", "entityId")
  WHERE "isArchived" = false;

-- pickAssignee aggregates "open tasks per assignee" in the load step.
-- Without this index the count fell back to a seq scan as the tasks table
-- grew past ~50K rows.
CREATE INDEX IF NOT EXISTS "idx_tasks_assignedToId_status_open"
  ON taskos.tasks ("assignedToId", "status")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED');

-- ── W2.4 — Lock ownership token ───────────────────────────────────────────
-- The polling lock now carries the owning instance's UUID so release can
-- verify ownership before deleting. Prevents a fresh process from clobbering
-- another instance's still-valid lock if the TTL window straddles a
-- restart-and-restart sequence.
ALTER TABLE taskos.polling_locks
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT;

-- ── W2.2 — Polling checkpoint ─────────────────────────────────────────────
-- Lets the engine ask labstack for "orders updated since <last_seen>"
-- instead of refetching the entire active-order universe every cycle.
-- One row per logical source ("labstack:Order"); we update it at the end
-- of a successful cycle.
CREATE TABLE IF NOT EXISTS taskos.engine_checkpoints (
  "sourceKey"  TEXT NOT NULL PRIMARY KEY,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
