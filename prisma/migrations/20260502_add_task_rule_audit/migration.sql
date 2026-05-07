-- Create TaskRuleAudit table for Phase 4: Audit Trail

CREATE TABLE "task_rule_audits" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "changedById" INTEGER,
    "action" TEXT NOT NULL,
    "changesSummary" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_rule_audits_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users" ("id") ON DELETE SET NULL
);

-- Create indexes for audit log queries
CREATE INDEX "task_rule_audits_ruleId_idx" ON "task_rule_audits"("ruleId");
CREATE INDEX "task_rule_audits_createdAt_idx" ON "task_rule_audits"("createdAt");
CREATE INDEX "task_rule_audits_changedById_idx" ON "task_rule_audits"("changedById");
