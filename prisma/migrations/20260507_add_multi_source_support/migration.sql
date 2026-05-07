-- MultiSource Support Phase 1 Migration
-- Adds data source management, polling logs, and task rule scoping

-- Create enum types
CREATE TYPE "DataSourceType" AS ENUM ('DATABASE', 'API', 'WEBHOOK');
CREATE TYPE "SourceSyncStrategy" AS ENUM ('NONE', 'API', 'DATABASE', 'WEBHOOK');

-- Create DataSource table
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL UNIQUE,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "tableReference" TEXT NOT NULL,
    "primaryKeyField" TEXT NOT NULL DEFAULT 'id',
    "typeFieldName" TEXT NOT NULL,
    "statusFieldName" TEXT NOT NULL,
    "queryTemplate" TEXT NOT NULL,
    "metadataFieldMapping" JSONB,
    "pollingType" "DataSourceType" NOT NULL DEFAULT 'DATABASE',
    "pollingIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncStrategy" "SourceSyncStrategy" NOT NULL DEFAULT 'NONE',
    "syncEndpoint" TEXT,
    "syncCredentials" JSONB,
    "backfillEnabled" BOOLEAN NOT NULL DEFAULT false,
    "backfillDays" INTEGER NOT NULL DEFAULT 7,
    "backfillCompleted" BOOLEAN NOT NULL DEFAULT false,
    "backfillCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" INTEGER NOT NULL,
    CONSTRAINT "data_sources_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create indexes for DataSource
CREATE INDEX "data_sources_sourceId_idx" ON "data_sources"("sourceId");
CREATE INDEX "data_sources_isActive_idx" ON "data_sources"("isActive");

-- Create DataSourcePollingLog table
CREATE TABLE "data_source_polling_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dataSourceId" TEXT NOT NULL,
    "pollStartedAt" TIMESTAMP(3) NOT NULL,
    "pollCompletedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "entitiesFound" INTEGER NOT NULL DEFAULT 0,
    "entitiesProcessed" INTEGER NOT NULL DEFAULT 0,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "data_source_polling_logs_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "data_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create indexes for DataSourcePollingLog
CREATE INDEX "data_source_polling_logs_dataSourceId_idx" ON "data_source_polling_logs"("dataSourceId");
CREATE INDEX "data_source_polling_logs_status_idx" ON "data_source_polling_logs"("status");
CREATE INDEX "data_source_polling_logs_createdAt_idx" ON "data_source_polling_logs"("createdAt");

-- Create TaskRuleSourceScope table
CREATE TABLE "task_rule_source_scopes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskRuleId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "allowedTypes" JSONB NOT NULL,
    "allowedStatuses" JSONB NOT NULL,
    "assignmentStrategy" TEXT NOT NULL DEFAULT 'default',
    "assignmentStrategyConfig" JSONB,
    "slaMinutesOverride" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" INTEGER NOT NULL,
    CONSTRAINT "task_rule_source_scopes_taskRuleId_fkey" FOREIGN KEY ("taskRuleId") REFERENCES "task_rules" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_rule_source_scopes_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "data_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_rule_source_scopes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create unique constraint for task_rule_source_scopes
CREATE UNIQUE INDEX "task_rule_source_scopes_taskRuleId_dataSourceId_key" ON "task_rule_source_scopes"("taskRuleId", "dataSourceId");
CREATE INDEX "task_rule_source_scopes_dataSourceId_idx" ON "task_rule_source_scopes"("dataSourceId");
CREATE INDEX "task_rule_source_scopes_isActive_idx" ON "task_rule_source_scopes"("isActive");

-- Extend Task table with multi-source fields
ALTER TABLE "tasks" ADD COLUMN "source" TEXT DEFAULT 'orders';
ALTER TABLE "tasks" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "tasks" ADD COLUMN "sourceStatus" TEXT;
ALTER TABLE "tasks" ADD COLUMN "sourceEntityId" BIGINT;
ALTER TABLE "tasks" ADD COLUMN "sourceLastSyncedAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "sourceHandlerContext" JSONB;

-- Add indexes for multi-source fields on Task table
CREATE INDEX "tasks_source_idx" ON "tasks"("source");
CREATE INDEX "tasks_source_sourceEntityId_idx" ON "tasks"("source", "sourceEntityId");

-- NOTE: Skipping initial DataSource record insertion as it requires a user with ID 1
-- This will be created through the application UI once an OPS_HEAD user is created

-- Backfill existing tasks with source='orders'
UPDATE "tasks" SET "source" = 'orders' WHERE "source" IS NULL;
