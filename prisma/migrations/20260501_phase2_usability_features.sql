-- Phase 2: Usability Features Database Migrations
-- Features: Unified Filter Bar, Assignment Audit Trail, Better SLA Display

-- Feature 6: Saved Filters Table
CREATE TABLE IF NOT EXISTS user_saved_filters (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "filterName" VARCHAR(255) NOT NULL,
  "filterJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "usageCount" INTEGER DEFAULT 0,
  CONSTRAINT "fk_user_saved_filters_user_id" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "unique_user_filter_name" UNIQUE ("userId", "filterName")
);

CREATE INDEX IF NOT EXISTS idx_user_saved_filters_user_id ON user_saved_filters("userId");
CREATE INDEX IF NOT EXISTS idx_user_saved_filters_usage ON user_saved_filters("usageCount" DESC);

-- Feature 10: Assignment Audit Fields
-- These fields track which rule assigned a task and whether it was auto or manual assignment
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS "assignmentRuleId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "assignmentMethod" VARCHAR(50) DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS "lastStatusUpdate" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "slaBreachedAt" TIMESTAMP;

-- Feature 7: SLA Context Fields
-- These fields are calculated on-the-fly in API responses, but we track breach timestamp
CREATE INDEX IF NOT EXISTS idx_tasks_sla_deadline ON tasks("slaDeadline");
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks("status");
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks("assignedToId");
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks("createdAt");

-- Feature 13: Task Aging Configuration (per task type)
ALTER TABLE task_types
  ADD COLUMN IF NOT EXISTS "normalAgingMinutes" INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "warningAgingMinutes" INTEGER DEFAULT 45,
  ADD COLUMN IF NOT EXISTS "criticalAgingMinutes" INTEGER DEFAULT 60;

-- Create indices for efficient filtering
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks("priority");
CREATE INDEX IF NOT EXISTS idx_tasks_store_id ON tasks("storeId");
CREATE INDEX IF NOT EXISTS idx_tasks_entity_id ON tasks("entityId");
