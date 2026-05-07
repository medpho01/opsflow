# Task Archive System Design

**Purpose:** Move old stuck tasks out of active view without losing audit trail  
**Implementation:** Simple flag-based approach with nightly automation  
**Status:** Ready to implement

---

## 1. Database Changes

### Migration: Add isArchived Column

```sql
-- Add isArchived column to tasks table
ALTER TABLE taskos.tasks
ADD COLUMN "isArchived" BOOLEAN DEFAULT false NOT NULL;

-- Add index for performance
CREATE INDEX idx_tasks_is_archived ON taskos.tasks("isArchived");

-- Create partial index for active tasks (most common query)
CREATE INDEX idx_tasks_active ON taskos.tasks(id) 
WHERE "isArchived" = false;
```

### Verify Changes
```sql
-- Check column added
\d taskos.tasks | grep isArchived

-- Expected: isArchived | boolean | not null | default false
```

---

## 2. Automatic Archive Script

### Nightly Archive Job

Create file: `/Users/maverick/Documents/TaskOs/src/lib/engine/taskArchiver.ts`

```typescript
/**
 * Task Archiver - Archives old stuck tasks automatically
 * Runs nightly to move 10+ day old tasks out of active view
 * Keeps them for audit trail but ops focus stays on live tasks
 */

import prisma from "@/lib/db/client";

const DAYS_THRESHOLD = 10; // Archive tasks on orders 10+ days old

export async function archiveOldTasks(): Promise<void> {
  console.log("[TaskArchiver] Starting archive cycle");
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_THRESHOLD);
  
  console.log(`[TaskArchiver] Archiving tasks on orders with appointment before ${cutoffDate.toISOString()}`);
  
  try {
    // Find all tasks on orders where appointment was 10+ days ago
    // AND task is still open (not completed/cancelled)
    // AND not already archived
    const result = await prisma.task.updateMany({
      where: {
        "isArchived": false,
        "status": { notIn: ["COMPLETED", "CANCELLED"] },
        // Join with Order to check appointmentTime
        order: {
          appointmentTime: { lt: cutoffDate }
        }
      },
      data: { "isArchived": true }
    });
    
    console.log(`[TaskArchiver] Archived ${result.count} old tasks`);
    
    // Log archive action for audit trail
    if (result.count > 0) {
      await logArchiveAction(result.count, cutoffDate);
    }
  } catch (err) {
    console.error("[TaskArchiver] Error archiving tasks:", err);
    throw err;
  }
}

async function logArchiveAction(count: number, cutoffDate: Date): Promise<void> {
  // Optional: Create audit log entry
  console.log(`[TaskArchiver] ${count} tasks archived - cutoff date: ${cutoffDate.toISOString()}`);
}
```

### Alternative: Raw SQL Query (if Prisma has relation issues)

```sql
-- Archive old stuck tasks (nightly script version)
UPDATE taskos.tasks t
SET "isArchived" = true
WHERE 
    t."isArchived" = false
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
    AND t."entityType" = 'ORDER'
    AND EXISTS (
        SELECT 1 FROM public."Order" o
        WHERE o.id = t."entityId"
        AND o."appointmentTime" < (NOW() - INTERVAL '10 days')
    );

-- Log how many were archived
-- SELECT COUNT(*) FROM taskos.tasks WHERE "isArchived" = true;
```

---

## 3. Update Active Task Queries

### Dashboard Query (Show Only Active)

**Before:**
```sql
SELECT * FROM taskos.tasks
WHERE status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY createdAt DESC;
```

**After:**
```sql
SELECT * FROM taskos.tasks
WHERE "isArchived" = false
  AND status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY createdAt DESC;
```

### API Endpoint Update

**File:** `src/app/api/tasks/route.ts`

```typescript
// GET /api/tasks - Get active tasks (exclude archived)
export async function GET(request: NextRequest) {
  const tasks = await prisma.task.findMany({
    where: {
      isArchived: false,  // <-- ADD THIS
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
    },
    orderBy: { createdAt: "desc" }
  });
  return NextResponse.json({ tasks });
}
```

### Dashboard Component Update

**File:** `src/app/head/tasks/page.tsx` (or wherever tasks are displayed)

```typescript
// Add isArchived filter to all queries
const tasks = await fetchTasks({
  includeArchived: false,  // Default: show only active
  // ...
});
```

---

## 4. Archive Views and Reports

### View: Active Tasks (For Ops)
```sql
CREATE OR REPLACE VIEW taskos.v_active_tasks AS
SELECT *
FROM taskos.tasks
WHERE "isArchived" = false
  AND "status" NOT IN ('COMPLETED', 'CANCELLED');

-- Usage: SELECT * FROM taskos.v_active_tasks;
```

### View: Archived Tasks (For Audit)
```sql
CREATE OR REPLACE VIEW taskos.v_archived_tasks AS
SELECT *
FROM taskos.tasks
WHERE "isArchived" = true;

-- Usage: SELECT * FROM taskos.v_archived_tasks;
```

### View: Archive Stats
```sql
CREATE OR REPLACE VIEW taskos.v_archive_stats AS
SELECT
    'Active Tasks' as category,
    COUNT(*) as count
FROM taskos.tasks
WHERE "isArchived" = false
  AND "status" NOT IN ('COMPLETED', 'CANCELLED')

UNION ALL

SELECT 'Archived Tasks', COUNT(*)
FROM taskos.tasks
WHERE "isArchived" = true

UNION ALL

SELECT 'Completed Tasks', COUNT(*)
FROM taskos.tasks
WHERE "status" = 'COMPLETED'

UNION ALL

SELECT 'Cancelled Tasks', COUNT(*)
FROM taskos.tasks
WHERE "status" = 'CANCELLED';

-- Usage: SELECT * FROM taskos.v_archive_stats;
```

---

## 5. Unarchive Capability (For Manual Override)

### If Ops Needs to Bring Back an Archived Task

```sql
-- Unarchive a specific task (if needed)
UPDATE taskos.tasks
SET "isArchived" = false
WHERE id = :task_id;

-- Unarchive all tasks for a specific order
UPDATE taskos.tasks
SET "isArchived" = false
WHERE "entityId" = :order_id;
```

### API Endpoint for Manual Unarchive

```typescript
// PATCH /api/tasks/:id/unarchive
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const taskId = parseInt(params.id);
  
  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { "isArchived": false }
  });
  
  return NextResponse.json({ task: updated });
}
```

---

## 6. Dashboard Widgets

### Before & After Comparison

**Before Archive System:**
```
Dashboard Shows:
├── 74 Open Tasks
│   ├── 45 Active (live orders)
│   ├── 29 Stuck (old orders from April - NOISE!)
└── Ops agents distracted by old tasks
```

**After Archive System:**
```
Dashboard Shows:
├── Active Tasks: 45
│   └── Only live/current orders
├── Archived Tasks: 29
│   └── Hidden by default (available in archive view)
└── Ops agents focus on current work
```

### Widget Code

```typescript
// src/components/TaskDashboard.tsx

export function TaskStatsWidget() {
  const [stats, setStats] = useState({
    activeTasks: 0,
    archivedTasks: 0,
    completedTasks: 0
  });

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    const res = await fetch('/api/task-stats');
    const data = await res.json();
    setStats(data);
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <h3>Active Tasks</h3>
        <p className="text-2xl">{stats.activeTasks}</p>
        <p className="text-sm text-gray-500">Focus on these</p>
      </Card>
      
      <Card>
        <h3>Archived</h3>
        <p className="text-2xl">{stats.archivedTasks}</p>
        <p className="text-sm text-gray-500">For audit trail</p>
      </Card>
      
      <Card>
        <h3>Completed</h3>
        <p className="text-2xl">{stats.completedTasks}</p>
        <p className="text-sm text-gray-500">Done</p>
      </Card>
    </div>
  );
}
```

---

## 7. Implementation Checklist

### Phase 1: Database (Day 1)
- [ ] Run migration to add `isArchived` column
- [ ] Create indexes for performance
- [ ] Create views for archive reporting
- [ ] Test: Verify column exists and defaults to false

### Phase 2: Archive Script (Day 2)
- [ ] Create taskArchiver.ts
- [ ] Test archive logic with sample data
- [ ] Schedule nightly job (add to poller or separate cron)
- [ ] Create logging/audit trail

### Phase 3: API Updates (Day 2)
- [ ] Update all task queries to exclude archived (WHERE isArchived = false)
- [ ] Add unarchive endpoint
- [ ] Add isArchived to task response objects
- [ ] Test: Verify archived tasks don't show in active views

### Phase 4: UI Updates (Day 3)
- [ ] Update dashboard to show active count only
- [ ] Add "Archive" section to UI
- [ ] Add manual unarchive button (if needed)
- [ ] Add archive stats widget
- [ ] Test: Verify old tasks disappear from active view

### Phase 5: Monitoring (Day 3+)
- [ ] Monitor archive stats daily
- [ ] Verify nightly script runs
- [ ] Check for any manual unarchive requests
- [ ] Adjust 10-day threshold if needed

---

## 8. Threshold Tuning

The **10-day threshold** can be adjusted based on ops needs:

| Threshold | Use Case |
|-----------|----------|
| 3 days | Very aggressive - archive recent old tasks |
| 7 days | Standard - most operations prefer this |
| **10 days** | Current choice - keeps 1+ week visible |
| 14 days | Conservative - keeps 2 weeks visible |
| 30 days | Very conservative - keep month visible |

**How to Change:**
```typescript
// In taskArchiver.ts, line 8:
const DAYS_THRESHOLD = 10;  // ← Change this number
```

---

## 9. Example: Running Archive Script

### Manual Test Run
```bash
# Via Node.js API
curl -X POST http://localhost:3000/api/tasks/archive

# Or directly via SQL
psql -d labstack << 'EOF'
UPDATE taskos.tasks t
SET "isArchived" = true
WHERE t."isArchived" = false
  AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
  AND EXISTS (
    SELECT 1 FROM public."Order" o
    WHERE o.id = t."entityId"
    AND o."appointmentTime" < (NOW() - INTERVAL '10 days')
  );
EOF
```

### Scheduled (Nightly)
```typescript
// Add to poller.ts or separate cron file
import { archiveOldTasks } from "@/lib/engine/taskArchiver";

// Run at 2 AM daily
cron.schedule("0 2 * * *", async () => {
  try {
    await archiveOldTasks();
  } catch (err) {
    console.error("Archive failed:", err);
  }
});
```

---

## 10. Expected Impact

### Current Situation
```
Total Tasks: 320
├── Active (live): 45
└── Stuck/Old: 275 (cluttering dashboard)
```

### After Archive System
```
Total Tasks: 320 (unchanged)
├── Active View: 45 (ops focus)
└── Archive View: 275 (audit trail)
```

**Ops Agent Experience:**
- ✅ Dashboard shows only 45 relevant tasks
- ✅ No distraction from old April orders
- ✅ Can still access archive if needed
- ✅ Automatic - no manual effort required

---

## Files to Create/Modify

### New Files
- `src/lib/engine/taskArchiver.ts` - Archive script

### Modified Files
- `src/app/api/tasks/route.ts` - Add isArchived filter
- `src/app/api/task-stats/route.ts` - Update stats queries
- `src/app/head/tasks/page.tsx` - Update dashboard display
- `prisma/schema.prisma` - Add isArchived field (optional)

### SQL Scripts
- Migration: Add isArchived column
- Views: v_active_tasks, v_archived_tasks, v_archive_stats

---

## Safety Notes

✅ **Non-Destructive:** Tasks are marked archived, not deleted  
✅ **Reversible:** Can unarchive anytime with one flag change  
✅ **Auditable:** All tasks still in database for audit trail  
✅ **Performant:** Index on isArchived keeps queries fast  
✅ **Simple:** Just a boolean flag, no complex logic

---

## Next Steps

1. **Approval:** Do you want to proceed with this design?
2. **Timing:** When should this be implemented?
3. **Threshold:** Should the 10-day threshold be different?
4. **Validation:** Should archived tasks get a special status or just hidden?

Ready to implement?
