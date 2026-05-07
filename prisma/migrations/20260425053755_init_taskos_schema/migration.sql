-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OPS_HEAD', 'STORE_ADMIN', 'OPS_AGENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'BREACHED', 'CANCELLED', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('HOME_SAMPLE', 'CENTER_VISIT', 'INJECTION', 'CAMP', 'KIT_BASED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('SLA_WARNING', 'SLA_URGENT', 'SLA_BREACHED', 'TASK_UNASSIGNED', 'AGENT_AT_CAPACITY', 'ORDER_STUCK', 'SKILL_GAP', 'DAILY_SUMMARY');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('IN_APP', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED');

-- CreateEnum
CREATE TYPE "RosterStatus" AS ENUM ('ON_DUTY', 'OFF_SHIFT', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "AssignmentMethod" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "maxConcurrentTasks" INTEGER NOT NULL DEFAULT 5,
    "storeIds" INTEGER[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_tags" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member_skills" (
    "teamMemberId" INTEGER NOT NULL,
    "skillTagId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_skills_pkey" PRIMARY KEY ("teamMemberId","skillTagId")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "daysOfWeek" INTEGER[],
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakStart" TEXT,
    "breakEnd" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_roster" (
    "id" SERIAL NOT NULL,
    "teamMemberId" INTEGER NOT NULL,
    "shiftId" INTEGER,
    "rosterDate" DATE NOT NULL,
    "status" "RosterStatus" NOT NULL DEFAULT 'ON_DUTY',
    "leaveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_roster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_types" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" SERIAL NOT NULL,
    "taskTypeId" INTEGER NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "stepText" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "orderType" "OrderType" NOT NULL,
    "taskTypeId" INTEGER NOT NULL,
    "titleTemplate" TEXT NOT NULL,
    "slaMinutes" INTEGER NOT NULL,
    "priority" "TaskPriority" NOT NULL,
    "assignmentMethod" "AssignmentMethod" NOT NULL DEFAULT 'AUTO',
    "triggerCondition" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "escalationChainId" INTEGER,
    "storeScoped" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_rule_skills" (
    "taskRuleId" TEXT NOT NULL,
    "skillTagId" INTEGER NOT NULL,

    CONSTRAINT "task_rule_skills_pkey" PRIMARY KEY ("taskRuleId","skillTagId")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "taskRuleId" TEXT NOT NULL,
    "taskTypeId" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "storeId" INTEGER,
    "orderType" "OrderType" NOT NULL,
    "priority" "TaskPriority" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'CREATED',
    "assignedToId" INTEGER,
    "teamMemberId" INTEGER,
    "assignedAt" TIMESTAMP(3),
    "assignedById" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "slaDeadline" TIMESTAMP(3) NOT NULL,
    "slaBreachedAt" TIMESTAMP(3),
    "blockReason" TEXT,
    "completionNote" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "stepText" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_history" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "fromStatus" "TaskStatus",
    "toStatus" "TaskStatus" NOT NULL,
    "changedById" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_chains" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_levels" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "levelNumber" INTEGER NOT NULL,
    "minutesAfterBreach" INTEGER NOT NULL,
    "notifyRoles" "UserRole"[],
    "message" TEXT,
    "sendWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" SERIAL NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "severity" "TaskPriority" NOT NULL,
    "entityType" TEXT,
    "entityId" INTEGER,
    "taskId" INTEGER,
    "userId" INTEGER,
    "message" TEXT NOT NULL,
    "channel" "AlertChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "acknowledgedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polling_logs" (
    "id" SERIAL NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "ordersChecked" INTEGER NOT NULL DEFAULT 0,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polling_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_breach_logs" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "taskRuleId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "assignedToId" INTEGER,
    "slaDeadline" TIMESTAMP(3) NOT NULL,
    "breachedAt" TIMESTAMP(3) NOT NULL,
    "breachMinutes" INTEGER NOT NULL,
    "rootCauseTag" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_breach_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_userId_key" ON "team_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_tags_name_key" ON "skill_tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "daily_roster_teamMemberId_rosterDate_key" ON "daily_roster"("teamMemberId", "rosterDate");

-- CreateIndex
CREATE UNIQUE INDEX "task_types_name_key" ON "task_types"("name");

-- CreateIndex
CREATE INDEX "tasks_entityType_entityId_idx" ON "tasks"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_assignedToId_idx" ON "tasks"("assignedToId");

-- CreateIndex
CREATE INDEX "tasks_slaDeadline_idx" ON "tasks"("slaDeadline");

-- CreateIndex
CREATE INDEX "tasks_storeId_idx" ON "tasks"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_levels_chainId_levelNumber_key" ON "escalation_levels"("chainId", "levelNumber");

-- CreateIndex
CREATE INDEX "alerts_userId_status_idx" ON "alerts"("userId", "status");

-- CreateIndex
CREATE INDEX "alerts_taskId_idx" ON "alerts"("taskId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member_skills" ADD CONSTRAINT "team_member_skills_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "team_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member_skills" ADD CONSTRAINT "team_member_skills_skillTagId_fkey" FOREIGN KEY ("skillTagId") REFERENCES "skill_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_roster" ADD CONSTRAINT "daily_roster_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "team_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_roster" ADD CONSTRAINT "daily_roster_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_taskTypeId_fkey" FOREIGN KEY ("taskTypeId") REFERENCES "task_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_rules" ADD CONSTRAINT "task_rules_taskTypeId_fkey" FOREIGN KEY ("taskTypeId") REFERENCES "task_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_rules" ADD CONSTRAINT "task_rules_escalationChainId_fkey" FOREIGN KEY ("escalationChainId") REFERENCES "escalation_chains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_rule_skills" ADD CONSTRAINT "task_rule_skills_taskRuleId_fkey" FOREIGN KEY ("taskRuleId") REFERENCES "task_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_rule_skills" ADD CONSTRAINT "task_rule_skills_skillTagId_fkey" FOREIGN KEY ("skillTagId") REFERENCES "skill_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_taskRuleId_fkey" FOREIGN KEY ("taskRuleId") REFERENCES "task_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_levels" ADD CONSTRAINT "escalation_levels_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "escalation_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
