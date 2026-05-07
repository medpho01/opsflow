# OpsFlow "All Tasks" Feature — BACKEND IMPLEMENTATION PLAN

**Date:** May 1, 2026  
**Target Release:** 7-9 weeks (aligned with Frontend Plan)  
**Team:** 1-2 Backend Engineers  
**Tech Stack:** Node.js/Next.js, Prisma ORM, PostgreSQL, WebSocket (Socket.io or native WS)

---

## EXECUTIVE SUMMARY

This backend plan addresses **20-30 hours of critical fixes** identified in the Technical Audit plus **new API endpoints and features** required for Phase 1-3 frontend capabilities.

**Critical Focus:** Data integrity, race condition prevention, timezone handling, and real-time event streaming.

**Key Changes:**
- Add unique constraint to prevent duplicate tasks
- Implement database-level polling lock
- Add timezone support for SLA calculations
- Implement WebSocket event broadcasting for real-time updates
- Enhanced API responses with assignment metadata
- New endpoints for task history, rule evaluation, and alerts

**Estimated Effort:** 35-45 days of development (fixes + features combined)

---

# CRITICAL FIXES (Priority 1)

These must be completed before any production deployment.

## FIX C1.1: Add Unique Constraint to Prevent Duplicate Tasks

### Problem
Race condition between `isDuplicate()` check and `createTask()` execution allows creating duplicate tasks. Two concurrent polling cycles can both check, both pass, both create.

### Solution

**Database Migration File:** `/Users/maverick/Documents/TaskOs/prisma/migrations/[timestamp]_add_unique_task_constraint/migration.sql`

```sql
-- Step 1: Add UNIQUE constraint for active tasks (isArchived=false)
ALTER TABLE taskos."tasks"
ADD CONSTRAINT "unique_active_task_per_rule_order"
UNIQUE (
  CASE WHEN "isArchived" = false THEN "taskRuleId" ELSE NULL END,
  CASE WHEN "isArchived" = false THEN "entityId" ELSE NULL END,
  CASE WHEN "isArchived" = false THEN "isArchived" ELSE NULL END
);

-- Step 2: Add compound indexes for sorting performance
CREATE INDEX "tasks_appointmentTime_priority_createdAt_idx"
ON taskos."tasks" ("appointmentTime", "priority", "createdAt");

CREATE INDEX "tasks_status_priority_createdAt_idx"
ON taskos."tasks" ("status", "priority", "createdAt");

-- Step 3: Clean up any existing duplicates before constraint takes effect
DELETE FROM taskos."tasks" t1
WHERE t1.id NOT IN (
  SELECT MAX(id) FROM taskos."tasks" t2
  WHERE t2."taskRuleId" = t1."taskRuleId"
    AND t2."entityId" = t1."entityId"
    AND t2."isArchived" = false
  GROUP BY t2."taskRuleId", t2."entityId"
);
```

**Prisma Schema Update:** `/Users/maverick/Documents/TaskOs/prisma/schema.prisma`

```prisma
model Task {
  // ... existing fields ...
  
  // Add unique constraint at model level
  @@unique([
    taskRuleId,
    entityId,
    isArchived
  ], name: "unique_active_task_per_rule_order")
  
  // Add compound indexes
  @@index([appointmentTime, priority, createdAt])
  @@index([status, priority, createdAt])
  @@index([taskRuleId, entityId])  // For duplicate check
}
```

**Code Change:** `/Users/maverick/Documents/TaskOs/src/lib/engine/taskCreator.ts` (lines 243-273)

Replace check-then-create with atomic upsert:

```typescript
// BEFORE (race condition):
async function isDuplicate(ruleId: string, orderId: number): Promise<boolean> {
  const existing = await prisma.task.findFirst({
    where: { taskRuleId: ruleId, entityId: orderId, isArchived: false },
    select: { id: true },
  });
  return existing !== null;
}

// ... later ...
const isDup = await isDuplicate(rule.id, order.id);
if (isDup) continue;
// ... more work ...
await createTask(payload);  // RACE CONDITION HERE

// AFTER (atomic):
async function getOrCreateTask(
  rule: TaskRuleWithRelations,
  order: RawOrder,
  payload: Omit<TaskCreateInput, "taskRuleId" | "entityId">
): Promise<{ task: Task; isNew: boolean }> {
  try {
    const task = await prisma.task.upsert({
      where: {
        // Use composite unique key
        unique_active_task_per_rule_order: {
          taskRuleId: rule.id,
          entityId: order.id,
          isArchived: false,
        },
      },
      create: {
        taskRuleId: rule.id,
        entityId: order.id,
        isArchived: false,
        ...payload,
      },
      update: {
        // If task exists, just return it (no-op)
        // Could update if needed (e.g., refresh SLA)
      },
    });
    return { task, isNew: task.createdAt.getTime() === task.updatedAt.getTime() };
  } catch (e) {
    if (e.code === "P2002") {
      // Unique constraint violation (shouldn't happen with upsert, but log it)
      console.error(`[getOrCreateTask] Unexpected constraint violation for rule=${rule.id}, order=${order.id}`);
      // Fetch existing task
      const existing = await prisma.task.findFirst({
        where: { taskRuleId: rule.id, entityId: order.id, isArchived: false },
      });
      return { task: existing!, isNew: false };
    }
    throw e;
  }
}

// In evaluateAndCreateTasks:
for (const order of orders) {
  for (const rule of rules) {
    if (!evaluateTrigger(rule, order)) continue;
    
    const payload = buildTaskPayload(rule, order);
    const { task, isNew } = await getOrCreateTask(rule, order, payload);
    
    if (isNew) {
      created++;
      await createTaskHistory(task.id, "CREATED");
    } else {
      skipped++;
    }
  }
}
```

### Testing

```typescript
describe("Duplicate Prevention", () => {
  it("should prevent creating duplicate tasks", async () => {
    const rule = await createTestRule();
    const order = await createTestOrder();
    
    // First task should succeed
    const task1 = await createTask(rule, order);
    expect(task1.id).toBeDefined();
    
    // Second task should return existing, not create new
    const task2 = await createTask(rule, order);
    expect(task2.id).toBe(task1.id);
    
    // Verify only one task in DB
    const count = await prisma.task.count({
      where: { taskRuleId: rule.id, entityId: order.id },
    });
    expect(count).toBe(1);
  });

  it("should handle concurrent creation attempts", async () => {
    const rule = await createTestRule();
    const order = await createTestOrder();
    
    // Simulate 2 concurrent polling cycles
    const [task1, task2] = await Promise.all([
      createTask(rule, order),
      createTask(rule, order),
    ]);
    
    // Both should reference same task
    expect(task1.id).toBe(task2.id);
    
    // Only one task created
    const count = await prisma.task.count({
      where: { taskRuleId: rule.id, entityId: order.id },
    });
    expect(count).toBe(1);
  });
});
```

### Effort: 3-4 hours
- SQL migration: 1 hour
- Prisma schema update: 0.5 hours
- Code refactoring: 1.5 hours
- Testing: 1 hour

### Rollback Strategy
```sql
-- To rollback:
DROP INDEX IF EXISTS "tasks_appointmentTime_priority_createdAt_idx";
DROP INDEX IF EXISTS "tasks_status_priority_createdAt_idx";
ALTER TABLE taskos."tasks"
DROP CONSTRAINT "unique_active_task_per_rule_order";
```

---

## FIX C1.2: Database-Level Polling Lock

### Problem
In-process polling lock (`isRunning` flag) doesn't prevent concurrent polling in multi-process Node cluster. Two processes each think they're the only one polling, both run simultaneously, both create duplicate tasks.

### Solution

**File:** `/Users/maverick/Documents/TaskOs/src/lib/engine/poller.ts` (lines 27-45)

```typescript
const POLLING_LOCK_ID = 1000; // Fixed advisory lock ID
const LOCK_TIMEOUT_MS = 60000;  // 60-second lock timeout

export async function runPollCycle(): Promise<void> {
  let lockAcquired = false;

  try {
    // Try to acquire exclusive PostgreSQL advisory lock (non-blocking)
    const lockResult = await prisma.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
      SELECT pg_try_advisory_lock(${POLLING_LOCK_ID});
    `;

    lockAcquired = lockResult[0].pg_try_advisory_lock;

    if (!lockAcquired) {
      console.log("[Poller] Another process holds the lock, skipping cycle.");
      return;
    }

    console.log("[Poller] Lock acquired, starting polling cycle.");

    // Set lock timeout (in case process crashes)
    const lockTimeoutHandle = setTimeout(async () => {
      try {
        await releaseLock();
      } catch (e) {
        console.error("[Poller] Failed to release lock on timeout:", e);
      }
    }, LOCK_TIMEOUT_MS);

    // ... polling logic here (fetch orders, evaluate rules, create tasks, archive) ...

    clearTimeout(lockTimeoutHandle);

  } catch (err) {
    console.error("[Poller] Error in polling cycle:", err);
    // Don't re-throw; let next cycle attempt
  } finally {
    if (lockAcquired) {
      await releaseLock();
    }
  }
}

async function releaseLock(): Promise<void> {
  try {
    await prisma.$executeRaw`
      SELECT pg_advisory_unlock(${POLLING_LOCK_ID});
    `;
    console.log("[Poller] Lock released.");
  } catch (e) {
    console.error("[Poller] Failed to release lock:", e);
  }
}
```

### Testing

```typescript
describe("Polling Lock", () => {
  it("should acquire lock and release after cycle", async () => {
    // Mock successful polling
    jest.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ pg_try_advisory_lock: true }]);
    
    await runPollCycle();
    
    // Verify lock was acquired and released
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      expect.stringContaining("pg_try_advisory_lock")
    );
  });

  it("should skip cycle if lock is held", async () => {
    // Mock lock already held
    jest.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ pg_try_advisory_lock: false }]);
    
    const originalFetch = jest.spyOn(prisma.order, "findMany");
    
    await runPollCycle();
    
    // Should not fetch orders
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("should release lock even if polling fails", async () => {
    jest.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ pg_try_advisory_lock: true }]);
    jest.spyOn(prisma.order, "findMany").mockRejectedValueOnce(new Error("DB error"));
    
    await runPollCycle();
    
    // Lock should be released even on error
    expect(prisma.$executeRaw).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_unlock")
    );
  });
});
```

### Effort: 2-3 hours
- Code implementation: 1 hour
- Testing (mock external calls): 1 hour
- Stress testing (concurrent processes): 1 hour

---

## FIX C1.3: Prevent Invalid Status Transitions (CREATED → BLOCKED)

### Problem
Allows marking CREATED tasks as BLOCKED. BLOCKED should only apply to ASSIGNED or IN_PROGRESS tasks (tasks that have an agent but are stuck).

### Solution

**File:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/bulk/route.ts` (lines 74-90)

```typescript
// Valid status transitions map
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: [TaskStatus.ASSIGNED, TaskStatus.CANCELLED],
  ASSIGNED: [TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
  IN_PROGRESS: [TaskStatus.COMPLETED, TaskStatus.BLOCKED, TaskStatus.BREACHED],
  BLOCKED: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
  BREACHED: [TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  COMPLETED: [TaskStatus.COMPLETED],  // Terminal: no transitions
  CANCELLED: [TaskStatus.CANCELLED],  // Terminal: no transitions
};

async function validateStatusTransition(
  taskIds: number[],
  newStatus: TaskStatus
): Promise<{ valid: boolean; validIds: number[] }> {
  // Fetch current status of all tasks
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, status: true },
  });

  const validIds = tasks
    .filter(t => VALID_TRANSITIONS[t.status]?.includes(newStatus))
    .map(t => t.id);

  const invalidCount = taskIds.length - validIds.length;
  
  if (invalidCount > 0) {
    console.warn(
      `[BulkActions] Rejected ${invalidCount} tasks from transitioning to ${newStatus}`
    );
  }

  return { valid: validIds.length > 0, validIds };
}

// In POST handler:
else if (action === "block") {
  // Only ASSIGNED and IN_PROGRESS can be blocked
  const { valid, validIds } = await validateStatusTransition(taskIds, TaskStatus.BLOCKED);

  if (!valid) {
    return NextResponse.json({
      error: "Cannot block CREATED, COMPLETED, or CANCELLED tasks. Only ASSIGNED or IN_PROGRESS tasks can be blocked.",
      rejected: taskIds.length - validIds.length,
      accepted: validIds.length,
    }, { status: 400 });
  }

  // Update only valid tasks
  const result = await prisma.task.updateMany({
    where: { id: { in: validIds } },
    data: {
      status: TaskStatus.BLOCKED,
      updatedAt: new Date(),
    },
  });

  // Create history for each updated task
  await Promise.all(
    validIds.map(taskId =>
      prisma.taskHistory.create({
        data: {
          taskId,
          status: TaskStatus.BLOCKED,
          changedById: user.id,
          note: "Bulk marked as blocked",
        },
      })
    )
  );

  return NextResponse.json({
    success: true,
    updated: result.count,
    message: `${result.count} task(s) marked as blocked`,
  });
}
```

### Testing

```typescript
describe("Status Transition Validation", () => {
  it("should allow ASSIGNED → BLOCKED", async () => {
    const task = await createTestTask({ status: "ASSIGNED" });
    
    const { valid, validIds } = await validateStatusTransition([task.id], "BLOCKED");
    
    expect(valid).toBe(true);
    expect(validIds).toContain(task.id);
  });

  it("should reject CREATED → BLOCKED", async () => {
    const task = await createTestTask({ status: "CREATED" });
    
    const { valid, validIds } = await validateStatusTransition([task.id], "BLOCKED");
    
    expect(valid).toBe(false);
    expect(validIds).not.toContain(task.id);
  });

  it("should reject COMPLETED → BLOCKED", async () => {
    const task = await createTestTask({ status: "COMPLETED" });
    
    const { valid, validIds } = await validateStatusTransition([task.id], "BLOCKED");
    
    expect(valid).toBe(false);
  });

  it("should handle mixed valid/invalid tasks", async () => {
    const validTask = await createTestTask({ status: "ASSIGNED" });
    const invalidTask = await createTestTask({ status: "CREATED" });
    
    const { valid, validIds } = await validateStatusTransition(
      [validTask.id, invalidTask.id],
      "BLOCKED"
    );
    
    expect(validIds).toEqual([validTask.id]);
    expect(validIds).not.toContain(invalidTask.id);
  });
});
```

### Effort: 2 hours
- Implementation: 1 hour
- Testing: 1 hour

---

## FIX C1.4: Add Timezone Support for SLA Calculations

### Problem
SLA calculations don't account for server timezone vs. application timezone (India IST). Creates incorrect deadline windows.

### Solution

**Environment Config:** `.env.local`

```env
# Timezone for SLA calculations (e.g., Asia/Kolkata for India)
TIMEZONE=Asia/Kolkata
```

**File:** `/Users/maverick/Documents/TaskOs/src/lib/engine/slaConfig.ts` (new)

```typescript
import { toZonedTime, fromZonedTime } from "date-fns-tz";

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

/**
 * Get current time in application timezone
 */
export function getNowInAppTimezone(): Date {
  return toZonedTime(new Date(), TIMEZONE);
}

/**
 * Create SLA deadline: given a start time in app timezone,
 * add minutes and return UTC DateTime for storage
 */
export function createSLADeadline(
  startTimeInAppTimezone: Date,
  slaMinutes: number
): Date {
  // Add minutes to the zoned time
  const deadlineInAppTimezone = new Date(
    startTimeInAppTimezone.getTime() + slaMinutes * 60_000
  );
  
  // Convert back to UTC for database storage
  const deadlineUTC = fromZonedTime(deadlineInAppTimezone, TIMEZONE);
  return deadlineUTC;
}

/**
 * Calculate remaining time until deadline (in app timezone)
 */
export function getTimeRemaining(slaDeadlineUTC: Date): {
  milliseconds: number;
  minutes: number;
  isBreached: boolean;
} {
  const nowInAppTimezone = getNowInAppTimezone();
  const milliseconds = slaDeadlineUTC.getTime() - nowInAppTimezone.getTime();
  const minutes = milliseconds / 60000;
  const isBreached = milliseconds < 0;

  return { milliseconds, minutes, isBreached };
}

/**
 * Format deadline for display in app timezone
 */
export function formatDeadlineInAppTimezone(slaDeadlineUTC: Date): string {
  const inAppTimezone = toZonedTime(slaDeadlineUTC, TIMEZONE);
  return inAppTimezone.toLocaleString();
}
```

**Update Task Creator:** `/Users/maverick/Documents/TaskOs/src/lib/engine/taskCreator.ts`

```typescript
import { getNowInAppTimezone, createSLADeadline } from "./slaConfig";

export async function evaluateAndCreateTasks(
  orders: RawOrder[],
  rules: TaskRuleWithRelations[]
): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0;

  // Get current time in app timezone (IST)
  const nowInAppTimezone = getNowInAppTimezone();

  for (const order of orders) {
    for (const rule of rules) {
      if (!evaluateTrigger(rule, order)) continue;

      // Create SLA deadline using app timezone
      const slaDeadline = createSLADeadline(
        nowInAppTimezone,
        rule.slaMinutes
      );

      const payload = {
        title: generateTaskTitle(rule, order),
        taskTypeId: rule.taskTypeId,
        taskRuleId: rule.id,
        entityId: order.id,
        priority: calculatePriority(order),
        slaDeadline,  // Now correctly in app timezone
        status: TaskStatus.CREATED,
        isArchived: false,
      };

      const { task, isNew } = await getOrCreateTask(rule, order, payload);
      if (isNew) created++;
      else skipped++;
    }
  }

  return { created, skipped };
}
```

**Update SLA Watcher:** `/Users/maverick/Documents/TaskOs/src/lib/engine/slaWatcher.ts`

```typescript
import { getNowInAppTimezone, getTimeRemaining } from "./slaConfig";

export async function runSlaWatcher(): Promise<void> {
  const nowInAppTimezone = getNowInAppTimezone();

  // Find all active, non-breached tasks
  const tasks = await prisma.task.findMany({
    where: {
      isArchived: false,
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
    },
    include: {
      escalations: true,
    },
  });

  for (const task of tasks) {
    const { isBreached, minutes } = getTimeRemaining(task.slaDeadline);

    // Mark as breached if past deadline
    if (isBreached && task.status !== TaskStatus.BREACHED) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.BREACHED },
      });

      await createEscalation(task.id, "SLA_BREACHED");
    }
    // Alert if approaching breach (5 minutes remaining)
    else if (minutes > 0 && minutes < 5 && !task.escalations.some(e => e.type === "SLA_WARNING")) {
      await createEscalation(task.id, "SLA_WARNING", `Breaching in ${Math.ceil(minutes)} minutes`);
    }
  }
}
```

### Testing

```typescript
describe("Timezone-Aware SLA", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.TIMEZONE = "Asia/Kolkata";
  });

  it("should create deadline in correct timezone", () => {
    const now = getNowInAppTimezone();
    const deadline = createSLADeadline(now, 60);  // 60 minutes
    
    const remaining = getTimeRemaining(deadline);
    
    // Should have ~60 minutes remaining
    expect(remaining.minutes).toBeGreaterThan(59);
    expect(remaining.minutes).toBeLessThan(61);
    expect(remaining.isBreached).toBe(false);
  });

  it("should correctly identify breached tasks", async () => {
    // Create task with deadline 5 minutes ago
    const now = getNowInAppTimezone();
    const pastDeadline = createSLADeadline(now, -5);
    
    const remaining = getTimeRemaining(pastDeadline);
    
    expect(remaining.isBreached).toBe(true);
    expect(remaining.minutes).toBeLessThan(0);
  });

  it("should handle DST transitions (if applicable)", async () => {
    // This test is more complex but important if deployed in DST regions
    // Skip for Asia/Kolkata since it doesn't observe DST
  });
});
```

### Effort: 3-4 hours
- Lib creation: 1.5 hours
- Task creator updates: 1 hour
- SLA watcher updates: 1 hour
- Testing: 1 hour

---

# HIGH-PRIORITY FIXES (Priority 2)

These should be completed before any release candidate.

## FIX H2.1: Fix Null Handling in appointmentTime Sort

### Problem
PostgreSQL puts NULLs first by default in ASC sort. Tasks without appointmentTime appear at top instead of bottom.

### Solution

**File:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts` (lines 43-84)

```typescript
type SortBy = "priority" | "createdAt" | "appointmentTime" | "status" | "slaDeadline";

function buildOrderBy(
  sortBy: SortBy,
  sortOrder: "asc" | "desc"
): Prisma.TaskFindManyArgs["orderBy"] {
  switch (sortBy) {
    case "appointmentTime":
      // NULLS LAST: non-null values first, nulls at end
      // In Prisma, we use raw SQL for this control
      return {
        // Cannot do NULLS LAST in Prisma orderBy directly,
        // so we need to use a different approach:
        // Sort by: (1) not null (0 if null, 1 if not), then (2) value
        _relevance: {
          search: "",
          sort: sortOrder === "asc" ? "asc" : "desc",
        },
      };
      // Actually, better approach: use findRaw or query builder
      // See below for raw SQL implementation

    case "priority":
      // Enum order: URGENT (highest) → HIGH → MEDIUM → LOW
      const priorityOrder = {
        URGENT: 1,
        HIGH: 2,
        MEDIUM: 3,
        LOW: 4,
      };
      return [
        {
          priority: sortOrder === "asc" ? "asc" : "desc",
        },
        { createdAt: "asc" },  // Tiebreaker
        { id: "asc" },  // Final tiebreaker for determinism
      ];

    case "status":
      // Status workflow order: CREATED → ASSIGNED → IN_PROGRESS → {BLOCKED, BREACHED} → COMPLETED → CANCELLED
      const statusOrder = {
        CREATED: 1,
        ASSIGNED: 2,
        IN_PROGRESS: 3,
        BLOCKED: 4,
        BREACHED: 4,
        COMPLETED: 5,
        CANCELLED: 6,
      };
      
      // Can't directly order by custom mapping in Prisma
      // Use raw SQL instead
      return null;  // Handled separately below

    case "slaDeadline":
      return [
        { slaDeadline: sortOrder === "asc" ? "asc" : "desc" },
        { priority: "desc" },
        { createdAt: "asc" },
        { id: "asc" },
      ];

    case "createdAt":
    default:
      return [
        { createdAt: sortOrder === "asc" ? "asc" : "desc" },
        { priority: "desc" },
        { id: "asc" },
      ];
  }
}

// For complex sorting (NULLS LAST, custom enum order), use raw SQL
async function getTasksWithComplexSort(
  where: Prisma.TaskWhereInput,
  sortBy: SortBy,
  sortOrder: "asc" | "desc",
  skip: number,
  take: number
): Promise<Task[]> {
  let orderByClause = "";

  switch (sortBy) {
    case "appointmentTime":
      // NULLS LAST
      orderByClause = `
        CASE WHEN t."appointmentTime" IS NULL THEN 1 ELSE 0 END ${sortOrder === "asc" ? "ASC" : "DESC"},
        t."appointmentTime" ${sortOrder === "asc" ? "ASC" : "DESC"},
        t."priority" DESC,
        t."createdAt" ASC,
        t."id" ASC
      `;
      break;

    case "status":
      // Custom status order
      const statusCase = `
        CASE t."status"
          WHEN 'CREATED' THEN 1
          WHEN 'ASSIGNED' THEN 2
          WHEN 'IN_PROGRESS' THEN 3
          WHEN 'BLOCKED' THEN 4
          WHEN 'BREACHED' THEN 4
          WHEN 'COMPLETED' THEN 5
          WHEN 'CANCELLED' THEN 6
          ELSE 99
        END
      `;
      orderByClause = `
        ${statusCase} ${sortOrder === "asc" ? "ASC" : "DESC"},
        t."priority" DESC,
        t."createdAt" ASC,
        t."id" ASC
      `;
      break;

    default:
      // For other sorts, Prisma orderBy is fine
      const result = await prisma.task.findMany({
        where,
        orderBy: buildOrderBy(sortBy, sortOrder) || { createdAt: "desc" },
        skip,
        take,
      });
      return result;
  }

  // Execute raw SQL for complex sorts
  const whereClause = buildWhereClause(where);  // Convert Prisma where to SQL
  const tasks = await prisma.$queryRaw`
    SELECT * FROM taskos."tasks" t
    WHERE ${whereClause}
    ORDER BY ${Prisma.raw(orderByClause)}
    LIMIT ${take} OFFSET ${skip}
  `;

  return tasks;
}
```

**Simpler Alternative (Prisma-friendly):**

```typescript
// Instead of complex raw SQL, fetch all and sort in-memory for small datasets
// OR use this simpler approach:

async function getTasksSorted(params: {
  where: Prisma.TaskWhereInput;
  sortBy: string;
  sortOrder: "asc" | "desc";
  skip: number;
  take: number;
}): Promise<Task[]> {
  // For appointmentTime with NULLS LAST:
  if (params.sortBy === "appointmentTime") {
    const tasks = await prisma.task.findMany({
      where: params.where,
      orderBy: [
        { createdAt: "desc" },  // Default order
      ],
    });

    // Sort in-memory
    const sorted = tasks.sort((a, b) => {
      // NULLs last
      if (a.appointmentTime === null) return 1;
      if (b.appointmentTime === null) return -1;

      const aTime = new Date(a.appointmentTime).getTime();
      const bTime = new Date(b.appointmentTime).getTime();

      if (params.sortOrder === "asc") {
        return aTime - bTime;
      } else {
        return bTime - aTime;
      }
    });

    return sorted.slice(params.skip, params.skip + params.take);
  }

  // For other sorts, use Prisma
  return prisma.task.findMany({
    where: params.where,
    orderBy: buildOrderBy(params.sortBy as SortBy, params.sortOrder),
    skip: params.skip,
    take: params.take,
  });
}
```

### Effort: 2-3 hours

---

## FIX H2.2: Validate All Filter Inputs

### Problem
Invalid filter values silently return empty results. E.g., `priority=invalid` should error, not return 0 tasks.

### Solution

**File:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts` (new validation)

```typescript
// Validation schemas
const TaskStatusSchema = z.enum([
  "CREATED",
  "ASSIGNED",
  "IN_PROGRESS",
  "BLOCKED",
  "BREACHED",
  "COMPLETED",
  "CANCELLED",
]);

const TaskPrioritySchema = z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]);

const QueryParamsSchema = z.object({
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignmentMethod: z.enum(["AUTO", "MANUAL"]).optional(),
  sortBy: z.enum(["priority", "createdAt", "appointmentTime", "status", "slaDeadline"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.string().pipe(z.coerce.number().min(1)).optional(),
  limit: z.string().pipe(z.coerce.number().min(1).max(100)).optional(),
  dateFrom: z.string().pipe(z.coerce.date()).optional(),
  dateTo: z.string().pipe(z.coerce.date()).optional(),
});

export async function GET(request: NextRequest) {
  try {
    // Parse and validate query params
    const params = QueryParamsSchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    // Build where clause with validated params
    const where: Prisma.TaskWhereInput = {
      isArchived: false,
    };

    if (params.status) {
      where.status = params.status;
    }

    if (params.priority) {
      where.priority = params.priority;
    }

    if (params.assignmentMethod) {
      where.assignmentMethod = params.assignmentMethod;
    }

    // Fetch and return...

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Invalid query parameters",
          details: error.errors.map(e => ({
            field: e.path.join("."),
            message: e.message,
            code: e.code,
          })),
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

### Effort: 2 hours

---

## FIX H2.3: Add Type Safety to Archive Stats

### Problem
Archive stats use `any` type, allowing runtime errors. Response format not validated.

### Solution

**File:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/stats/route.ts` (new)

```typescript
interface ArchiveStats {
  category: "Active Tasks" | "Archived Tasks";
  count: number;
  percentage: number;
}

const ArchiveStatsSchema = z.array(
  z.object({
    category: z.enum(["Active Tasks", "Archived Tasks"]),
    count: z.number().int().min(0),
    percentage: z.number().min(0).max(100),
  })
);

export async function GET(request: NextRequest) {
  try {
    const [activeTasks, archivedTasks] = await Promise.all([
      prisma.task.count({ where: { isArchived: false } }),
      prisma.task.count({ where: { isArchived: true } }),
    ]);

    const total = activeTasks + archivedTasks;

    const stats: ArchiveStats[] = [
      {
        category: "Active Tasks",
        count: activeTasks,
        percentage: total > 0 ? (activeTasks / total) * 100 : 0,
      },
      {
        category: "Archived Tasks",
        count: archivedTasks,
        percentage: total > 0 ? (archivedTasks / total) * 100 : 0,
      },
    ];

    // Validate before returning
    const validated = ArchiveStatsSchema.parse(stats);

    return NextResponse.json({ stats: validated });
  } catch (error) {
    console.error("[Stats] Error:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
```

### Effort: 1.5 hours

---

# FEATURE IMPLEMENTATION (NEW ENDPOINTS & APIs)

## F-B1.1: WebSocket Event Broadcasting

### Problem
Real-time task updates (F1.2 frontend feature) require backend to broadcast task events to connected clients.

### Solution

**New File:** `/Users/maverick/Documents/TaskOs/src/lib/websocket/taskEventBroadcaster.ts`

```typescript
import { WebSocketServer, WebSocket } from "ws";
import type { Task } from "@prisma/client";

export enum TaskEventType {
  TASK_CREATED = "task_created",
  TASK_UPDATED = "task_updated",
  TASK_ARCHIVED = "task_archived",
}

export interface TaskEvent {
  type: TaskEventType;
  task: Task;
  timestamp: Date;
}

class TaskEventBroadcaster {
  private connections: Set<WebSocket> = new Set();

  registerConnection(ws: WebSocket): void {
    this.connections.add(ws);

    ws.on("close", () => {
      this.connections.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("[Broadcaster] WebSocket error:", error);
      this.connections.delete(ws);
    });
  }

  broadcast(event: TaskEvent): void {
    const message = JSON.stringify(event);

    // Send to all connected clients
    for (const client of this.connections) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  broadcastTaskCreated(task: Task): void {
    this.broadcast({
      type: TaskEventType.TASK_CREATED,
      task,
      timestamp: new Date(),
    });
  }

  broadcastTaskUpdated(task: Task): void {
    this.broadcast({
      type: TaskEventType.TASK_UPDATED,
      task,
      timestamp: new Date(),
    });
  }

  broadcastTaskArchived(task: Task): void {
    this.broadcast({
      type: TaskEventType.TASK_ARCHIVED,
      task,
      timestamp: new Date(),
    });
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

export const taskEventBroadcaster = new TaskEventBroadcaster();
```

**WebSocket Route:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/events/route.ts`

```typescript
import { NextRequest } from "next/server";
import { taskEventBroadcaster } from "@/lib/websocket/taskEventBroadcaster";

// Upgrade HTTP to WebSocket
export async function GET(request: NextRequest) {
  const { socket, response } = Bun.upgrade(request, {
    data: { clientId: crypto.randomUUID() },
  });

  // Register connection
  taskEventBroadcaster.registerConnection(socket);

  console.log(`[WS] Client connected. Active connections: ${taskEventBroadcaster.getConnectionCount()}`);

  return response;
}
```

**Integrate with Task Creation:** `/Users/maverick/Documents/TaskOs/src/lib/engine/taskCreator.ts`

```typescript
import { taskEventBroadcaster } from "@/lib/websocket/taskEventBroadcaster";

async function createTask(payload: TaskCreateInput): Promise<Task> {
  const task = await prisma.task.create({ data: payload });

  // Broadcast event to all clients
  taskEventBroadcaster.broadcastTaskCreated(task);

  return task;
}

async function updateTaskStatus(taskId: number, newStatus: TaskStatus): Promise<Task> {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { status: newStatus, updatedAt: new Date() },
  });

  // Broadcast update
  taskEventBroadcaster.broadcastTaskUpdated(task);

  return task;
}
```

### Effort: 3-4 days

---

## F-B1.2: Enhanced Task Response with Assignment Metadata

### Problem
Frontend needs `assignmentMethod`, `assignedByRuleId`, `assignedAt` to display assignment status.

### Solution

**Database Schema Update:** `/Users/maverick/Documents/TaskOs/prisma/schema.prisma`

```prisma
model Task {
  // ... existing fields ...
  
  assignmentMethod  String?         @db.VarChar(10)  // "AUTO" | "MANUAL"
  assignedByRuleId  String?                          // Rule ID that triggered assignment
  assignedAt        DateTime?                        // When task was assigned
  reassignedBy      User?           @relation(name: "TaskReassignedBy", fields: [reassignedById], references: [id])
  reassignedById    Int?
  reassignedAt      DateTime?
  reassignmentReason String?
  
  @@index([assignmentMethod])
}
```

**Migration File:** `prisma/migrations/[timestamp]_add_assignment_metadata/migration.sql`

```sql
ALTER TABLE taskos."tasks"
ADD COLUMN "assignmentMethod" VARCHAR(10),
ADD COLUMN "assignedByRuleId" VARCHAR(255),
ADD COLUMN "assignedAt" TIMESTAMP,
ADD COLUMN "reassignedById" INTEGER,
ADD COLUMN "reassignedAt" TIMESTAMP,
ADD COLUMN "reassignmentReason" TEXT;

CREATE INDEX "tasks_assignmentMethod_idx" ON taskos."tasks" ("assignmentMethod");

-- Backfill existing tasks: if they have assignedToId, mark as auto-assigned
UPDATE taskos."tasks"
SET "assignmentMethod" = 'AUTO',
    "assignedAt" = "updatedAt"  -- Use last update time as proxy
WHERE "assignedToId" IS NOT NULL
  AND "assignmentMethod" IS NULL;
```

**Updated API Response:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/route.ts`

```typescript
// Include assignment metadata in response
const tasks = await prisma.task.findMany({
  where,
  orderBy,
  skip,
  take,
  include: {
    assignedTo: { select: { id: true, name: true } },
    reassignedBy: { select: { id: true, name: true } },
  },
});

const formatted = tasks.map(task => ({
  id: task.id,
  title: task.title,
  status: task.status,
  priority: task.priority,
  assignedToId: task.assignedToId,
  assignedToName: task.assignedTo?.name,
  assignmentMethod: task.assignmentMethod || "AUTO",  // Default to AUTO for backward compat
  assignedByRuleId: task.assignedByRuleId,
  assignedAt: task.assignedAt,
  reassignedByName: task.reassignedBy?.name,
  reassignedAt: task.reassignedAt,
  reassignmentReason: task.reassignmentReason,
  // ... other fields ...
}));

return NextResponse.json({ tasks: formatted, total, totalPages });
```

### Effort: 2-3 days

---

## F-B1.3: Task History Endpoint

### Problem
Frontend side panel needs to display task status change history.

### Solution

**New Route:** `/Users/maverick/Documents/TaskOs/src/app/api/tasks/[id]/history/route.ts`

```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const taskId = parseInt(params.id);

  try {
    const history = await prisma.taskHistory.findMany({
      where: { taskId },
      include: {
        changedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,  // Last 50 changes
    });

    return NextResponse.json({ history });
  } catch (error) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
```

**TaskHistory Model (ensure exists):** `/Users/maverick/Documents/TaskOs/prisma/schema.prisma`

```prisma
model TaskHistory {
  id        Int      @id @default(autoincrement())
  taskId    Int
  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  status    String   @db.VarChar(50)
  changedBy User?    @relation(fields: [changedById], references: [id])
  changedById Int?
  note      String?
  createdAt DateTime @default(now())

  @@index([taskId, createdAt])
}
```

### Effort: 1-2 days

---

## F-B1.4: Filter Endpoints for Assignment Method

### Problem
Frontend filter bar needs to filter by `assignmentMethod` (AUTO | MANUAL).

### Solution

**Updated GET /api/tasks:**

```typescript
interface QueryParams {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignmentMethod?: "AUTO" | "MANUAL";  // NEW
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

const where: Prisma.TaskWhereInput = {
  isArchived: false,
};

if (params.assignmentMethod) {
  where.assignmentMethod = params.assignmentMethod;
}

// ... rest of fetch ...
```

### Effort: 1 hour

---

# IMPLEMENTATION PRIORITY & TIMELINE

## Week 1-2: Critical Fixes
1. **C1.1: Unique Constraint** (3-4 hrs) ✓
2. **C1.2: Polling Lock** (2-3 hrs) ✓
3. **C1.3: Status Transitions** (2 hrs) ✓
4. **C1.4: Timezone Support** (3-4 hrs) ✓
5. **H2.1: Null Handling Sort** (2-3 hrs) ✓
6. **H2.2: Filter Validation** (2 hrs) ✓
7. **H2.3: Archive Stats Types** (1.5 hrs) ✓

**Subtotal: 15-19.5 hours**

## Week 3: Phase 1 Features
1. **F-B1.1: WebSocket Broadcasting** (3-4 days) ✓
2. **F-B1.2: Assignment Metadata** (2-3 days) ✓
3. **F-B1.3: Task History** (1-2 days) ✓
4. **F-B1.4: Filter Endpoints** (1 hour) ✓

**Subtotal: 7-10 days**

## Week 4-6: Phase 2-3 Features
1. Additional endpoints for side panel
2. Alert/escalation tracking
3. Performance optimizations

**Subtotal: 5-10 days**

---

# TESTING STRATEGY

## Unit Tests
```bash
npm test -- --testPathPattern="src/lib/engine" --coverage
```

- Task deduplication: concurrent creation, race conditions
- Polling lock: acquire, release, timeout
- Status transitions: valid vs. invalid
- Timezone calculations: SLA deadline accuracy
- Filter validation: invalid inputs, edge cases

## Integration Tests
```bash
npm test -- --testPathPattern="src/app/api" --integration
```

- Full polling cycle with real database
- WebSocket event broadcasting
- Task creation → broadcast → client receives
- Assignment metadata in responses

## E2E Tests
- User creates order → task created → appears on frontend → correct SLA color
- User manually reassigns → assignment metadata updates → reflected in UI
- Multiple clients connected → one creates task → all receive event

---

# DATABASE MIGRATIONS CHECKLIST

- [ ] Unique constraint added
- [ ] Compound indexes created
- [ ] Assignment metadata columns added
- [ ] Data backfilled (existing tasks marked AUTO)
- [ ] Polling lock verified working
- [ ] Timezone env var configured

---

# MONITORING & OBSERVABILITY

**Key Metrics to Track:**
- Polling cycle duration (target: <5 seconds)
- Duplicate task creation rate (target: 0)
- WebSocket connection count
- Task event broadcast latency (target: <100ms)
- SLA breach accuracy rate (target: 99.9%)

---

**Next:** See QA/Testing Plan for comprehensive test scenarios.
