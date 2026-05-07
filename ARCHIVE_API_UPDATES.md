# API Updates for Archive System

## Overview
All task queries need to be updated to exclude archived tasks by default. This ensures the ops dashboard shows only active/current tasks.

## API Endpoint Updates

### 1. GET /api/tasks (Main task list endpoint)

**Current (before):**
```typescript
export async function GET(request: NextRequest) {
  const tasks = await prisma.task.findMany({
    where: {
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
    },
    orderBy: { createdAt: "desc" }
  });
  return NextResponse.json({ tasks });
}
```

**Updated (after):**
```typescript
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('includeArchived') === 'true' ?? false;

  const tasks = await prisma.task.findMany({
    where: {
      isArchived: includeArchived ? undefined : false,  // Exclude archived by default
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
    },
    orderBy: { createdAt: "desc" },
    include: {
      order: {
        select: {
          id: true,
          orderStatus: true,
          appointmentTime: true,
          user: {
            select: { name: true }
          }
        }
      }
    }
  });
  return NextResponse.json({ 
    tasks,
    includeArchived: includeArchived,
    activeCount: tasks.filter(t => !t.isArchived).length
  });
}
```

**Usage:**
```
GET /api/tasks                    # Only active tasks
GET /api/tasks?includeArchived=true  # All tasks including archived
```

---

### 2. GET /api/tasks/stats (Task statistics endpoint)

**Updated:**
```typescript
export async function GET(request: NextRequest) {
  const activeTasks = await prisma.task.count({
    where: {
      isArchived: false,
      status: { notIn: ['COMPLETED', 'CANCELLED'] }
    }
  });

  const archivedTasks = await prisma.task.count({
    where: {
      isArchived: true,
      status: { notIn: ['COMPLETED', 'CANCELLED'] }
    }
  });

  const completedTasks = await prisma.task.count({
    where: {
      status: 'COMPLETED'
    }
  });

  const cancelledTasks = await prisma.task.count({
    where: {
      status: 'CANCELLED'
    }
  });

  return NextResponse.json({
    activeTasks,
    archivedTasks,
    completedTasks,
    cancelledTasks,
    total: activeTasks + archivedTasks + completedTasks + cancelledTasks
  });
}
```

---

### 3. GET /api/tasks/:id (Single task endpoint)

**Update to include archival status:**
```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const taskId = parseInt(params.id);
  
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      order: {
        select: {
          id: true,
          orderStatus: true,
          appointmentTime: true
        }
      }
    }
  });

  if (!task) {
    return NextResponse.json(
      { error: "Task not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    task,
    isArchived: task.isArchived
  });
}
```

---

### 4. GET /api/orders/:orderId/tasks (Tasks for a specific order)

**Updated:**
```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('includeArchived') === 'true' ?? false;

  const orderId = parseInt(params.orderId);
  
  const tasks = await prisma.task.findMany({
    where: {
      entityId: orderId,
      isArchived: includeArchived ? undefined : false,  // Exclude archived by default
      status: { notIn: ['COMPLETED', 'CANCELLED'] }
    },
    orderBy: { createdAt: "desc" }
  });

  return NextResponse.json({
    orderId,
    tasks,
    totalActive: tasks.filter(t => !t.isArchived).length,
    totalArchived: tasks.filter(t => t.isArchived).length
  });
}
```

---

## Database Query Pattern

### Pattern: Always filter archived tasks from dashboard queries

```typescript
// ✅ GOOD - Excludes archived tasks
const tasks = await prisma.task.findMany({
  where: {
    isArchived: false,  // <- ALWAYS ADD THIS
    status: { notIn: ['COMPLETED', 'CANCELLED'] }
  }
});

// ❌ BAD - Shows archived tasks in active view
const tasks = await prisma.task.findMany({
  where: {
    status: { notIn: ['COMPLETED', 'CANCELLED'] }
  }
});
```

---

## Raw SQL Pattern

### Pattern: Always include isArchived filter in WHERE clause

```sql
-- ✅ GOOD
SELECT * FROM taskos.tasks
WHERE "isArchived" = false
  AND status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY "createdAt" DESC;

-- ❌ BAD  
SELECT * FROM taskos.tasks
WHERE status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY "createdAt" DESC;
```

---

## Files to Update

1. **src/app/api/tasks/route.ts**
   - Add `isArchived: false` filter to GET method
   - Add optional query param `includeArchived` for audit queries

2. **src/app/api/tasks/:id/route.ts**
   - Include `isArchived` in response
   - No filter needed (can view archived task details)

3. **src/app/api/tasks/stats/route.ts**
   - Separate active vs archived counts
   - Show in statistics widget

4. **src/app/api/orders/:orderId/tasks/route.ts**
   - Add `isArchived: false` filter by default
   - Add optional `includeArchived` query param

5. **src/app/head/tasks/page.tsx** (or dashboard component)
   - Use `isArchived: false` filter when fetching tasks
   - Display active task count only

6. **src/components/TaskDashboard.tsx** (if exists)
   - Update stats queries
   - Show "Active Tasks" count prominently
   - Add "Archived Tasks" count in secondary area

---

## Testing Checklist

- [ ] Verify archived tasks do not appear in active task list
- [ ] Verify archived tasks appear when `includeArchived=true`
- [ ] Verify task stats show correct counts
- [ ] Verify single task can still be viewed if archived
- [ ] Verify unarchive endpoint restores task to active view
- [ ] Verify nightly archive job runs and marks old tasks
- [ ] Verify archive SQL views return correct data

---

## Gradual Rollout

1. **Phase 1:** Add `isArchived` column to database
2. **Phase 2:** Deploy archiveScheduler (no impact on existing queries yet)
3. **Phase 3:** Update API endpoints to filter archived tasks
4. **Phase 4:** Update dashboard components
5. **Phase 5:** Monitor and adjust threshold if needed

This approach allows testing at each phase before full rollout.
