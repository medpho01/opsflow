-- C1.1: Add unique constraint to prevent duplicate active tasks (partial unique index)
-- This prevents race condition where two polling cycles create same task
CREATE UNIQUE INDEX "tasks_unique_active_task_per_rule"
ON taskos."tasks" ("taskRuleId", "entityId")
WHERE "isArchived" = false;

-- C1.1: Add assignment tracking fields
ALTER TABLE taskos."tasks"
ADD COLUMN "assignmentMethod" TEXT,
ADD COLUMN "assignmentRuleId" TEXT;

-- C1.1: Add compound index for sorting by appointmentTime
CREATE INDEX "tasks_appointmentTime_priority_createdAt_idx"
ON taskos."tasks" ("appointmentTime" ASC NULLS LAST, "priority" DESC, "createdAt" ASC);

-- C1.1: Add compound index for sorting by status
CREATE INDEX "tasks_status_priority_createdAt_idx"
ON taskos."tasks" ("status" DESC, "priority" DESC, "createdAt" ASC);

-- C1.2: Create polling lock table
CREATE TABLE taskos."polling_locks" (
  "id" SERIAL PRIMARY KEY,
  "lockKey" INTEGER UNIQUE NOT NULL,
  "lockedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil" TIMESTAMP NOT NULL
);

-- Ensure only one lock key exists
CREATE UNIQUE INDEX "polling_locks_lockKey_unique" ON taskos."polling_locks"("lockKey");
