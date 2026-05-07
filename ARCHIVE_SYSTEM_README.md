# TaskOS Archive System - Complete Implementation Package

## 📦 What's Included

A complete, production-ready solution to archive old stuck tasks and keep the ops dashboard focused on current work.

**Problem:** 275 old April orders stuck in escalation are cluttering the dashboard, creating noise and distraction.

**Solution:** Automatic nightly archiving moves tasks with appointment dates > 10 days old out of active view, while keeping them in the database for audit purposes.

---

## 📁 Files Overview

### 1. Implementation Files (Ready to Deploy)

| File | Purpose | Status |
|------|---------|--------|
| `src/lib/engine/taskArchiver.ts` | Core archiving logic | ✅ Complete |
| `src/lib/engine/archiveScheduler.ts` | Nightly scheduler | ✅ Complete |
| `src/app/api/tasks/archive/route.ts` | Archive API endpoint | ✅ Complete |
| `src/app/api/tasks/[id]/unarchive/route.ts` | Unarchive endpoint | ✅ Complete |
| `migrations/add_isArchived_column.sql` | Database schema | ✅ Complete |
| `migrations/create_archive_views.sql` | SQL views | ✅ Complete |

### 2. Documentation Files

| File | Audience | When to Read |
|------|----------|--------------|
| **ARCHIVE_IMPLEMENTATION_GUIDE.md** | Developers | START HERE - Step-by-step deployment |
| **ARCHIVE_API_UPDATES.md** | Developers | Reference for API endpoint patterns |
| **ARCHIVE_OPS_GUIDE.md** | Operations Team | Explain what changed, how to use it |
| **ARCHIVE_SYSTEM_DESIGN.md** | Architects | Complete design rationale and specs |
| **This file** | Everyone | Overview and quick reference |

### 3. Related Documents (From Previous Work)

| File | Purpose |
|------|---------|
| `task_validation_corrected_final.sql` | Validation queries (separate concern) |
| `VALIDATION_GUIDE_CORRECTED.md` | SOP validation reference |

---

## 🚀 Quick Start (5 Minutes)

### For Developers - Implementation Path

**1. Read the Overview** (You are here - 2 min)

**2. Run Database Migration** (30 seconds)
```bash
psql -d labstack < migrations/add_isArchived_column.sql
psql -d labstack < migrations/create_archive_views.sql
```

**3. Deploy Archive Engine** (1 minute)
- Copy files to src/ directory (already created)
- Verify with: `npm run dev` + `curl -X POST localhost:3000/api/tasks/archive`

**4. Update API Endpoints** (2-3 minutes)
- Follow ARCHIVE_API_UPDATES.md patterns
- Add `isArchived: false` filter to task queries

**5. Update Dashboard** (1-2 minutes)
- Update stats widget to show active vs archived counts
- Verify old April tasks no longer appear in active list

**For Details:** See ARCHIVE_IMPLEMENTATION_GUIDE.md (Phase 1-5)

### For Operations - Understanding Changes

**1. Read ARCHIVE_OPS_GUIDE.md** (5 minutes)
- Explains what changed
- How to use the system
- How to restore archived tasks if needed

**2. Key Changes:**
- Dashboard now shows "Active Tasks: 45" instead of "Tasks: 320"
- Old April orders moved to archive automatically
- Everything remains in database (no data loss)

---

## 📊 System Design

### How It Works

```
Order Created (April 1)
    ↓
Tasks Created for SOP workflows
    ↓
[10 days of operations...]
    ↓
Appointment date reaches April 11
    ↓
April 12 at 2 AM: Nightly Archive Job Runs
    ↓
Tasks moved to archive (isArchived = true)
    ↓
Dashboard shows only active tasks ✅
    ↓
Archive view still available for audit/history
```

### Database Changes

**Added Column:**
```sql
ALTER TABLE taskos.tasks
ADD COLUMN "isArchived" BOOLEAN DEFAULT false NOT NULL;
```

**Added Indexes:**
- `idx_tasks_is_archived` - Fast filtering by archive status
- `idx_tasks_active` - Optimized for "active tasks" queries

**Added Views:**
- `v_active_tasks` - Active tasks only
- `v_archived_tasks` - Archived tasks only
- `v_archive_stats` - Statistics dashboard
- `v_archive_candidates` - Preview next archive run

### Archive Criteria

Tasks are archived when:
- ✅ Order's `appointmentTime` is > 10 days in the past
- ✅ Task is NOT already COMPLETED or CANCELLED
- ✅ Task is NOT already archived

### Reversibility

- ✅ All archived tasks remain in database
- ✅ Can unarchive individual tasks instantly
- ✅ Can unarchive all tasks for an order
- ✅ No data is deleted, only flagged

---

## 📈 Impact Projection

### Current State (Before)
```
Dashboard: 320 Total Tasks
├── 45 Active (current orders)
├── 275 Stuck (old April orders) ← NOISE
└── Ops agents distracted by old work
```

### After Implementation
```
Active View: 45 Tasks
├── All current orders
├── Clear focus ✅
└── Ops agents productive

Archive View: 275 Tasks
├── Complete history
├── For audit trail ✅
└── Available if needed
```

---

## 🔧 Configuration

### Threshold Setting

Default: **10 days** (tasks archived if appointment date > 10 days ago)

To change, edit `src/lib/engine/taskArchiver.ts`:

```typescript
const DAYS_THRESHOLD = 10;  // Change this number

// Suggested values:
// 3 days = Very aggressive
// 7 days = Standard
// 10 days = Recommended (current)
// 14 days = Conservative
// 30 days = Very conservative
```

### Schedule Setting

Default: **Daily at 2 AM** (can be customized in archiveScheduler.ts)

```typescript
// Current: "0 2 * * *" = 2 AM daily
// Change format: "minute hour day month dayOfWeek"

// Examples:
// "0 1 * * *" = 1 AM daily
// "0 2 * * 0" = 2 AM Sundays only
// "0 * * * *" = Every hour
```

---

## ✅ Implementation Checklist

### Pre-Deployment
- [ ] Read ARCHIVE_IMPLEMENTATION_GUIDE.md
- [ ] Backup database (safety first)
- [ ] Review ARCHIVE_API_UPDATES.md patterns

### Phase 1: Database (15 minutes)
- [ ] Run `add_isArchived_column.sql`
- [ ] Run `create_archive_views.sql`
- [ ] Verify column with: `psql labstack -c "SELECT * FROM taskos.v_archive_stats;"`

### Phase 2: Archive Engine (30 minutes)
- [ ] Deploy taskArchiver.ts
- [ ] Deploy archiveScheduler.ts
- [ ] Test with: `curl -X POST localhost:3000/api/tasks/archive`
- [ ] Verify tasks archived: `psql labstack -c "SELECT COUNT(*) FROM taskos.tasks WHERE isArchived = true;"`

### Phase 3: API Updates (45 minutes)
- [ ] Update GET /api/tasks with `isArchived: false` filter
- [ ] Update GET /api/tasks/stats endpoint
- [ ] Update other task query endpoints
- [ ] Test endpoints return only active tasks

### Phase 4: UI Updates (30 minutes)
- [ ] Update dashboard stats widget
- [ ] Verify old April tasks no longer show in active view
- [ ] Add "View Archive" link (optional)

### Phase 5: Monitoring (Ongoing)
- [ ] Check archive stats daily for first week
- [ ] Verify nightly job runs (check logs)
- [ ] Gather ops team feedback
- [ ] Adjust threshold if needed

---

## 🧪 Testing Guide

### Manual Testing

```bash
# 1. Trigger archive manually
curl -X POST http://localhost:3000/api/tasks/archive

# 2. Check archive stats
curl http://localhost:3000/api/tasks/archive/stats

# 3. Verify archived tasks
psql labstack -c "SELECT COUNT(*) FROM taskos.v_archived_tasks;"

# 4. Test unarchive
curl -X PATCH http://localhost:3000/api/tasks/123/unarchive

# 5. Verify task restored
curl http://localhost:3000/api/tasks/123 | grep isArchived
```

### Automated Testing

Create tests in your test suite:

```typescript
describe('Archive System', () => {
  test('should archive old tasks', async () => {
    const archived = await archiveOldTasks();
    expect(archived.count).toBeGreaterThan(0);
  });

  test('should not show archived in active list', async () => {
    const tasks = await fetchActiveTasks();
    expect(tasks).not.toContainEqual(expect.objectContaining({ isArchived: true }));
  });

  test('should unarchive task', async () => {
    const restored = await unarchiveTask(123);
    expect(restored.isArchived).toBe(false);
  });
});
```

---

## 📋 API Reference

### Archive Endpoints

#### POST /api/tasks/archive
Manually trigger archive job

```bash
curl -X POST http://localhost:3000/api/tasks/archive
```

**Response:**
```json
{
  "success": true,
  "message": "Archive job executed successfully"
}
```

#### GET /api/tasks/archive/stats
Get archive statistics

```bash
curl http://localhost:3000/api/tasks/archive/stats
```

**Response:**
```json
{
  "stats": [
    { "category": "Active Tasks", "count": 45, "percentage": 12 },
    { "category": "Archived Tasks", "count": 275, "percentage": 78 }
  ],
  "candidates": [ /* tasks to archive next */ ],
  "nextArchiveThreshold": 10
}
```

#### PATCH /api/tasks/:id/unarchive
Restore archived task

```bash
curl -X PATCH http://localhost:3000/api/tasks/123/unarchive
```

**Response:**
```json
{
  "success": true,
  "message": "Task 123 restored to active view",
  "task": { /* full task object */ }
}
```

---

## 🆘 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Archive job not running | Check logs for "[TaskArchiver]" messages |
| Archived tasks still visible | Verify `isArchived: false` filter in API |
| Can't unarchive task | Check task exists: `SELECT * FROM taskos.tasks WHERE id = 123;` |
| Views not working | Verify migration ran: `\dv taskos.v_*` in psql |
| Slow queries | Verify indexes created: `\di taskos.idx_*` in psql |

### Debug Commands

```bash
# Check if migration was applied
psql labstack -c "\d taskos.tasks | grep isArchived"

# Check archive status
psql labstack -c "SELECT COUNT(*), SUM(CASE WHEN isArchived THEN 1 ELSE 0 END) FROM taskos.tasks;"

# Check views exist
psql labstack -c "\dv taskos.v_*"

# Preview next archive candidates
psql labstack -c "SELECT * FROM taskos.v_archive_candidates LIMIT 10;"
```

---

## 📚 Documentation Map

```
START HERE
    ↓
Developers → ARCHIVE_IMPLEMENTATION_GUIDE.md (5 phases)
    ↓
Need API patterns? → ARCHIVE_API_UPDATES.md
    ↓
Operations team? → ARCHIVE_OPS_GUIDE.md
    ↓
Want full context? → ARCHIVE_SYSTEM_DESIGN.md
    ↓
Reference current deployment → This file
```

---

## 🔐 Safety & Reversibility

All design decisions prioritize safety:

### No Data Loss
- ✅ Tasks marked with flag, never deleted
- ✅ Complete history remains in database
- ✅ Unarchive available instantly

### Non-Destructive
- ✅ Can run archive multiple times safely (idempotent)
- ✅ Can pause archiving anytime (just don't run job)
- ✅ Can adjust threshold without affecting archived tasks

### Transparent
- ✅ All archived tasks viewable anytime
- ✅ Audit trail preserved
- ✅ All operations logged

---

## 🎯 Success Criteria

After implementation, you should see:

✅ **Dashboard** shows "Active Tasks: 45" instead of "Tasks: 320"
✅ **April orders** no longer in active task list
✅ **Archive view** shows 275 old tasks (still accessible)
✅ **Nightly job** runs automatically at 2 AM
✅ **Ops team** reports better focus on current work
✅ **Audit trail** remains complete and intact

---

## 📞 Support Path

1. **During Implementation:** Follow ARCHIVE_IMPLEMENTATION_GUIDE.md (Phase 1-5)
2. **For API Questions:** Reference ARCHIVE_API_UPDATES.md
3. **For Ops Questions:** Share ARCHIVE_OPS_GUIDE.md with team
4. **For Design Questions:** Review ARCHIVE_SYSTEM_DESIGN.md
5. **For Troubleshooting:** See Troubleshooting section above

---

## 🚀 Next Steps

1. **Today:** Read this file and ARCHIVE_IMPLEMENTATION_GUIDE.md
2. **Tomorrow:** Run Phase 1-2 (database + engine)
3. **Day 3:** Run Phase 3-4 (API + UI updates)
4. **Day 4+:** Monitor and optimize

**Estimated Total Time:** 3-4 hours of development work

---

## 📝 Summary

The archive system is a **non-invasive, reversible solution** that:

- 🎯 Keeps ops dashboard focused on current work
- 🔍 Preserves complete audit trail
- ⏱️ Runs automatically (no manual effort)
- 🔄 Allows instant restoration if needed
- 📊 Provides visibility into archived tasks

**Result:** Happier ops team, better focus, zero data loss, complete transparency.

Ready to implement? Start with **ARCHIVE_IMPLEMENTATION_GUIDE.md**.
