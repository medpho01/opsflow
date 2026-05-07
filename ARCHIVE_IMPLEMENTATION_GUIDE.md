# Archive System - Implementation Guide

## 📋 Executive Summary

This guide provides step-by-step instructions to implement the task archive system. The system automatically moves old stuck tasks (appointment date > 10 days ago) out of the active view while preserving them for audit trail.

**Key Benefits:**
- ✅ Reduces dashboard noise from April stuck orders
- ✅ Ops agents focus on current/live orders only
- ✅ All tasks remain in database (audit trail intact)
- ✅ Automatic nightly job (no manual effort)
- ✅ Manual unarchive available if needed

---

## 🗂️ Files Created

```
/src/lib/engine/
  ├── taskArchiver.ts           (Archive logic + manual unarchive)
  └── archiveScheduler.ts       (Nightly scheduling with cron)

/src/app/api/tasks/
  ├── archive/route.ts          (POST to trigger archive manually)
  └── [id]/unarchive/route.ts   (PATCH to restore archived tasks)

/migrations/
  ├── add_isArchived_column.sql (Database schema change)
  └── create_archive_views.sql  (SQL views for reporting)

/Documentation/
  ├── ARCHIVE_SYSTEM_DESIGN.md  (Complete design specification)
  ├── ARCHIVE_API_UPDATES.md    (API endpoint patterns)
  └── this file                 (Implementation steps)
```

---

## 📋 Phase 1: Database Migration (Day 1)

### Step 1.1: Run Migration

```bash
cd /Users/maverick/Documents/TaskOs

# Run the migration to add isArchived column
psql -d labstack < migrations/add_isArchived_column.sql
```

**Expected Output:**
```
ALTER TABLE
CREATE INDEX
CREATE INDEX
                     Table "taskos.tasks"
         Column      |  Type   | Collation | Nullable | Default
─────────────────────┼─────────┼───────────┼──────────┼─────────
 id                  | integer |           | not null |
 ...
 "isArchived"        | boolean |           | not null | false
```

### Step 1.2: Verify Migration

```bash
# Login to database and verify
psql labstack

# Run this query:
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'taskos' AND table_name = 'tasks'
ORDER BY ordinal_position;

# Should see:
# isArchived | boolean | NO | false
```

### Step 1.3: Create Views

```bash
# Create SQL views for archive management
psql -d labstack < migrations/create_archive_views.sql
```

**Expected Output:**
```
CREATE VIEW
COMMENT
CREATE VIEW
COMMENT
CREATE VIEW
COMMENT
CREATE VIEW
COMMENT
```

### Step 1.4: Test Views

```bash
psql labstack

-- Test active tasks view
SELECT COUNT(*) FROM taskos.v_active_tasks;

-- Test archive stats view
SELECT * FROM taskos.v_archive_stats;

-- Test archive candidates (will show next run preview)
SELECT * FROM taskos.v_archive_candidates;
```

---

## 🚀 Phase 2: Deploy Archive Engine (Day 2)

### Step 2.1: Copy Engine Files

The files are already created:
- `src/lib/engine/taskArchiver.ts`
- `src/lib/engine/archiveScheduler.ts`

### Step 2.2: Test Manual Archive

```bash
# Test the archive logic WITHOUT scheduling
npm run dev

# In another terminal, run manual test:
curl -X POST http://localhost:3000/api/tasks/archive

# Check response:
# { "success": true, "message": "Archive job executed successfully" }
```

### Step 2.3: Verify Archive Worked

```bash
# Check that old tasks were archived
psql labstack

-- See how many tasks were archived:
SELECT COUNT(*) as archived_count FROM taskos.tasks WHERE "isArchived" = true;

-- See archived task list:
SELECT * FROM taskos.v_archived_tasks LIMIT 10;

-- See active task count:
SELECT COUNT(*) as active_count FROM taskos.v_active_tasks;
```

**Expected Results:**
- Before: 320 total tasks, 45 active, 275 stuck
- After: 320 total tasks, 45 active, 275 archived

### Step 2.4: Initialize Scheduler (optional for now)

To enable automatic nightly scheduling, update your main app initialization file:

**File: `src/app/layout.tsx` or startup hook**

```typescript
import { initializeArchiveScheduler } from '@/lib/engine/archiveScheduler';

// In your app initialization (e.g., useEffect on root component)
useEffect(() => {
  initializeArchiveScheduler();
}, []);
```

Or in a backend initialization file:

**File: `src/lib/server/init.ts` (or similar)**

```typescript
import { initializeArchiveScheduler } from '@/lib/engine/archiveScheduler';

export async function initializeServer() {
  console.log('Initializing server...');
  initializeArchiveScheduler();
  // ... other initialization
}
```

---

## 🔌 Phase 3: Update API Endpoints (Day 2)

### Step 3.1: Update GET /api/tasks

**File: `src/app/api/tasks/route.ts`**

Add the `isArchived` filter (see ARCHIVE_API_UPDATES.md for full code):

```typescript
const tasks = await prisma.task.findMany({
  where: {
    isArchived: false,  // <- ADD THIS LINE
    status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] }
  },
  orderBy: { createdAt: "desc" }
});
```

### Step 3.2: Update GET /api/tasks/stats

**File: `src/app/api/task-stats/route.ts` (or similar)**

Update to show separate active vs archived counts:

```typescript
const activeTasks = await prisma.task.count({
  where: {
    isArchived: false,  // <- ADD THIS
    status: { notIn: ['COMPLETED', 'CANCELLED'] }
  }
});

const archivedTasks = await prisma.task.count({
  where: {
    isArchived: true,  // <- ADD THIS
    status: { notIn: ['COMPLETED', 'CANCELLED'] }
  }
});
```

### Step 3.3: Update Dashboard Component

**File: `src/app/head/tasks/page.tsx` or dashboard component**

Update task queries to exclude archived:

```typescript
// BEFORE:
const tasks = await fetchTasks({ 
  status: 'active' 
});

// AFTER:
const tasks = await fetchTasks({ 
  includeArchived: false,  // <- Explicit exclusion
  status: 'active' 
});
```

### Step 3.4: Test API Changes

```bash
# Terminal 1:
npm run dev

# Terminal 2 - test the updated endpoints
curl http://localhost:3000/api/tasks
# Should return only active tasks (isArchived: false)

curl http://localhost:3000/api/tasks/stats
# Should show activeTasks, archivedTasks separately

curl http://localhost:3000/api/tasks/archive/stats
# Should show candidates for next archive run
```

---

## 🖼️ Phase 4: Update Dashboard UI (Day 3)

### Step 4.1: Update Task Stats Widget

**File: `src/components/TaskDashboard.tsx` or similar**

```typescript
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
    const res = await fetch('/api/tasks/stats');
    const data = await res.json();
    setStats(data);
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* Active Tasks - Primary Focus */}
      <Card className="border-2 border-blue-500">
        <h3>Active Tasks</h3>
        <p className="text-3xl font-bold">{stats.activeTasks}</p>
        <p className="text-sm text-gray-600">Focus on these</p>
        <p className="text-xs text-gray-400">Live orders</p>
      </Card>
      
      {/* Archived Tasks - Secondary Info */}
      <Card className="border border-gray-300">
        <h3>Archived</h3>
        <p className="text-2xl">{stats.archivedTasks}</p>
        <p className="text-sm text-gray-600">For audit trail</p>
        <button className="text-xs text-blue-500 hover:underline">
          View Archive
        </button>
      </Card>
      
      {/* Completed - Reference */}
      <Card className="border border-gray-300">
        <h3>Completed</h3>
        <p className="text-2xl">{stats.completedTasks}</p>
        <p className="text-sm text-gray-600">Done</p>
      </Card>
    </div>
  );
}
```

### Step 4.2: Add Archive View Link (Optional)

Add a link to view archived tasks:

```typescript
<Link href="/tasks/archive" className="text-sm text-blue-500">
  View {stats.archivedTasks} archived tasks
</Link>
```

### Step 4.3: Test UI Changes

```bash
npm run dev

# Open http://localhost:3000/tasks
# Verify:
# ✅ Active task count shows only non-archived tasks
# ✅ Archived count shows in secondary area
# ✅ Completed count shows separately
```

---

## ⚙️ Phase 5: Monitoring & Optimization (Day 3+)

### Step 5.1: Monitor Archive Stats Daily

```bash
# Check archive stats:
curl http://localhost:3000/api/tasks/archive/stats

# Expected JSON response:
{
  "stats": [
    { "category": "Active Tasks", "count": 45, "percentage": 12 },
    { "category": "Archived Tasks", "count": 275, "percentage": 78 },
    { "category": "Completed Tasks", "count": 45, "percentage": 10 }
  ],
  "candidates": [
    // Tasks that will be archived in next run
  ],
  "nextArchiveThreshold": 10
}
```

### Step 5.2: Verify Nightly Job Runs

Check server logs for archive execution (if scheduler initialized):

```
[ArchiveScheduler] Initialized - archive runs daily at 2 AM
[ArchiveScheduler] Running scheduled archive job
[TaskArchiver] Starting archive cycle
[TaskArchiver] Archiving tasks on orders with appointment before 2026-04-20T02:30:45.123Z
[TaskArchiver] Archived 12 old tasks
[ArchiveScheduler] Archive job completed successfully
```

### Step 5.3: Adjust Threshold if Needed

If you want to change from 10 days to something else, update:

**File: `src/lib/engine/taskArchiver.ts`, line 7:**

```typescript
const DAYS_THRESHOLD = 10;  // Change this number

// Suggested values:
// 3 days   = Very aggressive (archive recent old tasks)
// 7 days   = Standard (most operations)
// 10 days  = Current (keeps 1+ week visible)
// 14 days  = Conservative (keeps 2 weeks)
// 30 days  = Very conservative (keeps month)
```

### Step 5.4: Set Up Manual Unarchive Testing

Test the unarchive endpoint:

```bash
# Get an archived task ID:
curl http://localhost:3000/api/tasks/archive/stats

# Unarchive a specific task:
curl -X PATCH http://localhost:3000/api/tasks/123/unarchive

# Expected response:
{
  "success": true,
  "message": "Task 123 restored to active view",
  "task": { /* full task object */ }
}

# Verify it's active again:
curl http://localhost:3000/api/tasks | grep '"id":123'
```

---

## ✅ Verification Checklist

### Database Layer
- [ ] Migration ran successfully
- [ ] `isArchived` column exists on tasks table
- [ ] Indexes created (`idx_tasks_is_archived`, `idx_tasks_active`)
- [ ] Views created (v_active_tasks, v_archived_tasks, v_archive_stats)
- [ ] Views return correct data

### Archive Engine
- [ ] taskArchiver.ts file deployed
- [ ] archiveScheduler.ts file deployed
- [ ] Manual archive job executed successfully
- [ ] Old tasks marked as archived (isArchived = true)
- [ ] Active tasks remain unarchived (isArchived = false)

### API Layer
- [ ] GET /api/tasks returns only active tasks
- [ ] GET /api/tasks/archive/stats shows statistics
- [ ] POST /api/tasks/archive manually triggers archive
- [ ] PATCH /api/tasks/:id/unarchive restores archived task
- [ ] Query performance acceptable with new indexes

### UI Layer
- [ ] Dashboard shows active task count only
- [ ] Archived count displayed in secondary area
- [ ] Old April orders no longer cluttering active view
- [ ] Archive link provides access to archived tasks (optional)

### Scheduling (if enabled)
- [ ] archiveScheduler initialized on app startup
- [ ] Nightly job logs show execution
- [ ] No task creation failures due to archiving
- [ ] Archive runs at consistent time daily

---

## 📊 Expected Impact

### Before Archive System
```
Dashboard shows 320 tasks:
├── 45 Active (current orders)
├── 275 Stuck (old April orders) ← DISTRACTION
└── Ops agents unfocused on old noise
```

### After Archive System
```
Dashboard shows 45 active tasks:
├── All from current orders
├── 275 tasks in archive view (for audit)
└── Ops agents focused on live work ✅
```

---

## 🆘 Troubleshooting

### Issue: Archive button not working

```bash
# Check API is running:
curl http://localhost:3000/api/tasks/archive

# Check logs for errors:
# Look for [TaskArchiver] or [ArchiveAPI] messages
```

### Issue: Archived tasks still showing in active view

```bash
# Verify column exists:
psql labstack
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'tasks';

# Check isArchived value:
SELECT id, title, "isArchived" FROM taskos.tasks LIMIT 5;

# Verify API filter is in place:
# Check src/app/api/tasks/route.ts has: isArchived: false
```

### Issue: Nightly job not running

```bash
# If using scheduler, verify it initialized:
# Check app startup logs for "[ArchiveScheduler] Initialized"

# If missing, manually add to app initialization

# Or trigger manually:
curl -X POST http://localhost:3000/api/tasks/archive
```

---

## 📝 Next Steps

1. ✅ Run Phase 1 (Database) today
2. ✅ Run Phase 2 (Archive Engine) tomorrow
3. ✅ Run Phase 3 (API Updates) tomorrow
4. ✅ Run Phase 4 (UI Updates) day 3
5. ⏭️ Monitor for 1-2 weeks
6. ⏭️ Adjust 10-day threshold if needed based on ops feedback

---

## 📞 Support

If you encounter issues:

1. Check the verification checklist above
2. Review the troubleshooting section
3. Check application logs for error messages
4. Verify SQL views are returning data: `SELECT * FROM taskos.v_archive_stats;`
5. Test manual archive trigger: `POST /api/tasks/archive`

---

## 📄 Related Documents

- **ARCHIVE_SYSTEM_DESIGN.md** - Complete design specification
- **ARCHIVE_API_UPDATES.md** - Detailed API patterns and examples
- **task_validation_corrected_final.sql** - Validation queries (separate concern)
- **VALIDATION_GUIDE_CORRECTED.md** - SOP validation reference
