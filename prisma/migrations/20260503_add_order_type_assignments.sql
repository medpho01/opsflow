-- CreateTable team_member_order_types
CREATE TABLE "taskos"."team_member_order_types" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  "orderType" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("teamMemberId") REFERENCES "taskos"."team_members"("id") ON DELETE CASCADE,
  UNIQUE("teamMemberId", "orderType")
);

-- CreateIndex
CREATE INDEX "team_member_order_types_teamMemberId_idx" ON "taskos"."team_member_order_types"("teamMemberId");

-- CreateIndex
CREATE INDEX "team_member_order_types_orderType_idx" ON "taskos"."team_member_order_types"("orderType");

-- CreateIndex
CREATE INDEX "team_member_order_types_assignedAt_idx" ON "taskos"."team_member_order_types"("assignedAt");

-- CreateTable round_robin_states
CREATE TABLE "taskos"."round_robin_states" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderType" TEXT NOT NULL,
  "lastAssignedMemberId" INTEGER,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("orderType")
);

-- CreateIndex
CREATE INDEX "round_robin_states_orderType_idx" ON "taskos"."round_robin_states"("orderType");
