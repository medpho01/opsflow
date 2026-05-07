# Phase 1 QA Verification Guide

**Status:** READY FOR QA TESTING  
**Date:** May 1, 2026  
**All Code Complete:** ✅ 100%

---

## 🎯 Quick Start for QA

### What Changed?
- **4 Critical Bugs Fixed** (Database-level, prevents production issues)
- **5 Foundation Features Added** (User-facing improvements)
- **6 New API Endpoints/Updates** (Backend enhancements)
- **1 Frontend Component Completely Rewritten** (AllTasksBoard.tsx)
- **1 Database Migration** (Ready to apply)

### Files to Test
1. `/src/components/head/AllTasksBoard.tsx` — Frontend UI (DEPLOYED)
2. `/api/tasks` (GET) — Returns 4 new fields
3. `/api/tasks/metadata` (GET) — New endpoint
4. `/api/tasks/status-distribution` (GET) — New endpoint
5. Database — Unique constraint, polling lock table

---

## ✅ Critical Bug Verification (Priority: HIGH)

### C1.1: Duplicate Task Prevention
**Bug:** Two concurrent polling cycles could create the same task twice  
**Fix:** Database unique constraint on `(taskRuleId, entityId)` where `isArchived = false`

**Test Steps:**
1. Open database client
2. Run:
   ```sql
   -- Create 50 orders in quick succession
   INSERT INTO public."Order" (storeId, appointmentDate, createdAt)
   VALUES 
     (1, '2026-05-05', NOW()),
     (1, '2026-05-05', NOW()),
     -- ... repeat 50 times
   ;
   
   -- Trigger poller twice in different processes
   -- Process 1: npm run dev (runs poller on schedule)
   -- Process 2: curl /api/admin/trigger-poller (if endpoint exists)
   
   -- Verify exactly 50 tasks created (not 100)
   SELECT COUNT(*) FROM "Task" WHERE taskRuleId = 'R1';
   ```

**Expected Result:** Count = 50 (not 100)  
**Pass Criteria:** ✅ No duplicate tasks created  
**Failure Action:** Check database constraint exists:
   ```sql
   SELECT constraint_name FROM information_schema.table_constraints
   WHERE table_name = 'tasks' AND constraint_type = 'UNIQUE';
   ```

---

### C1.2: Concurrent Polling Prevention
**Bug:** Multi-process Node.js/PM2 deployments could run polling simultaneously  
**Fix:** PostgreSQL advisory lock with atomic acquire using upsert

**Test Steps:**
1. Ensure database migration applied (run `npx prisma migrate deploy`)
2. Verify polling_locks table exists:
   ```sql
   SELECT * FROM taskos."polling_locks";
   ```
3. Start two polling processes:
   ```bash
   # Terminal 1
   npm run dev  # Runs poller
   
   # Terminal 2 (within 30 seconds)
   npm run dev  # Also tries to run poller
   ```
4. Check logs to verify only one process acquires lock:
   ```
   [Poller] Lock acquired
   [Poller] Poll cycle completed
   [Poller] Lock released
   
   [Poller] Lock acquisition failed (lock held)
   [Poller] Waiting for next cycle
   ```

**Expected Result:** Only one process runs polling at a time  
**Pass Criteria:** ✅ Second process waits for first to complete  
**Failure Action:** Check polling_locks table, verify lock timeout working

---

### C1.3: Status Transition Validation
**Bug:** System allowed invalid state transitions (e.g., CREATED → BLOCKED)  
**Fix:** API validation restricts "block" action to ASSIGNED/IN_PROGRESS only

**Test Steps:**
1. Create a task and get its ID
2. Try blocking CREATED task:
   ```bash
   curl -X PATCH http://localhost:3000/api/tasks/bulk \
     -H "Content-Type: application/json" \
     -d '{
       "taskIds": [1],
       "action": "block"
     }'
   ```
3. Expected response: 400 error
   ```json
   {
     "error": "Cannot block CREATED, COMPLETED, CANCELLED, or BREACHED tasks. Only ASSIGNED or IN_PROGRESS tasks can be blocked."
   }
   ```

4. Now test blocking ASSIGNED task (should succeed):
   ```bash
   # First assign task to someone
   # Then block it
   ```

**Pass Criteria:** ✅ Returns 400 for invalid state, 200 for valid  
**Failure Action:** Check `/src/app/api/tasks/bulk/route.ts` block action validation

---

### C1.4: Timezone Support
**Bug:** SLA deadlines calculated in wrong timezone if server timezone != Asia/Kolkata  
**Fix:** `TIMEZONE` environment variable for consistent SLA interpretation

**Test Steps:**
1. Check environment:
   ```bash
   echo $TIMEZONE  # Should show Asia/Kolkata or your region
   ```

2. Create task at 11:55 PM with 30-minute SLA:
   ```bash
   curl -X POST http://localhost:3000/api/tasks \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Timezone Test",
       "taskTypeId": 1,
       "priority": "HIGH",
       "entityId": 999,
       "slaMinutes": 30
     }'
   ```

3. Check slaDeadline in response:
   ```sql
   SELECT id, createdAt, slaDeadline FROM "Task" 
   WHERE title = 'Timezone Test'
   ORDER BY id DESC LIMIT 1;
   ```

4. Verify deadline is 12:25 AM (30 mins after 11:55 PM), respecting timezone

**Expected Result:** SLA deadline correctly calculated in local timezone  
**Pass Criteria:** ✅ Deadline = CreatedAt + 30 minutes in specified timezone  
**Failure Action:** Verify TIMEZONE env var set, check taskCreator.ts code

---

## ✨ Foundation Feature Verification (Priority: HIGH)

### Feature 1: Manual Refresh Button + Timestamp
**What It Does:** User can refresh task list, sees "Last updated: X mins ago"

**Visual Check:**
1. Open All Tasks screen
2. Look for refresh button in top-right header area
3. Button should have icon (↻ or similar) and show "Last updated: now"
4. Click refresh button
5. Verify:
   - Tasks list reloads
   - Timestamp updates
   - Selected checkboxes preserved (if any)
   - After 10 seconds, display changes to "Last updated: 10s ago"

**API Verification:**
```bash
curl http://localhost:3000/api/tasks/metadata
# Response:
# {
#   "lastUpdated": "2026-05-01T12:45:00Z",
#   "timestamp": 1714548300000
# }
```

**Pass Criteria:** ✅ Refresh works, timestamp displays, updates every 10s  
**Failure Action:** Check `AllTasksBoard.tsx` handleRefresh function

---

### Feature 3: Color-Coded Urgency Zones
**What It Does:** Task rows change color based on remaining SLA time

**Visual Check:**
1. Create task with 5-minute SLA (should be RED/critical)
2. Create task with 20-minute SLA (should be YELLOW/warning)
3. Create task with 45-minute SLA (should be GREEN/safe)
4. Verify row background colors:
   - 🟢 GREEN: > 30 minutes remaining
   - 🟡 YELLOW: 10-30 minutes remaining
   - 🟠 ORANGE: < 10 minutes remaining
   - 🔴 RED: SLA breached or deadline passed

**API Verification:**
```bash
curl "http://localhost:3000/api/tasks?page=1&limit=10"
# Response includes:
# {
#   "slaStatus": "warning",          # or "safe", "critical", "breached"
#   "minutesRemaining": 22.5
# }
```

**Pass Criteria:** ✅ Row colors match slaStatus values  
**Failure Action:** Check `getSlaRowColor()` function in AllTasksBoard.tsx

---

### Feature 4: Status Distribution Widget
**What It Does:** Header shows count of tasks in each status

**Visual Check:**
1. Open All Tasks screen
2. Look for widget in top-right showing:
   ```
   5 CREATED | 12 ASSIGNED | 3 IN_PROGRESS | 0 BLOCKED | 1 BREACHED | 2 COMPLETED | 0 CANCELLED
   ```
3. Verify counts are accurate by filtering to each status
4. Create new task, verify CREATED count increases within 10 seconds
5. Reassign task, verify ASSIGNED count increases

**API Verification:**
```bash
curl http://localhost:3000/api/tasks/status-distribution
# Response:
# {
#   "CREATED": 5,
#   "ASSIGNED": 12,
#   "IN_PROGRESS": 3,
#   "BLOCKED": 0,
#   "BREACHED": 1,
#   "COMPLETED": 2,
#   "CANCELLED": 0
# }
```

**Pass Criteria:** ✅ Widget counts match actual task counts  
**Failure Action:** Check `fetchStatusDistribution()` in AllTasksBoard.tsx

---

### Feature 5: Assignment Status Visibility
**What It Does:** Shows whether task was auto-assigned or manually reassigned

**Visual Check:**
1. Look for task row, find assignment column
2. Should show badge:
   - "✓ Auto" for auto-assigned tasks (via rules)
   - "🔄 Manual" for manually reassigned tasks
3. Hover over badge
4. Tooltip should show:
   - Assignment method (Automatic by Rule / Manual Override)
   - Rule ID (if auto-assigned)
   - Timestamp
   - Who reassigned (if manual)

**Example Hover Tooltip:**
```
Automatic Assignment
Rule: R2 (Phlebotomy Auto-Assign)
Assigned At: 2026-05-01 12:30:45
```

**Data Verification:**
```bash
curl "http://localhost:3000/api/tasks?page=1&limit=10"
# Response includes:
# {
#   "assignmentMethod": "auto",      # or "manual"
#   "assignmentRuleId": "R2"         # or null if manual
# }
```

**Pass Criteria:** ✅ Badges display correct method, tooltips show details  
**Failure Action:** Check `hoveredAssignmentTaskId` state in AllTasksBoard.tsx

---

## 📊 Bulk Operations Verification (Priority: MEDIUM)

### Test Reassign Multiple Tasks
```bash
curl -X PATCH http://localhost:3000/api/tasks/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "taskIds": [1, 2, 3],
    "action": "reassign",
    "assignedToId": 5
  }'
```

Expected: Tasks updated, assignmentMethod = "manual", assignmentRuleId = null

### Test Cancel Multiple Tasks
```bash
curl -X PATCH http://localhost:3000/api/tasks/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "taskIds": [4, 5],
    "action": "cancel"
  }'
```

Expected: Tasks status = "CANCELLED", marked in history

### Test Block Multiple Tasks
```bash
curl -X PATCH http://localhost:3000/api/tasks/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "taskIds": [6, 7],
    "action": "block"
  }'
```

Expected: Only ASSIGNED/IN_PROGRESS tasks blocked, others return error

---

## 🧪 Test Data Setup

### Create Test Orders
```sql
-- Create orders for testing
INSERT INTO public."Order" (storeId, appointmentDate, createdAt)
VALUES 
  (1, '2026-05-05', NOW()),
  (2, '2026-05-06', NOW()),
  (3, '2026-05-07', NOW());

-- Verify orders created
SELECT id, storeId, appointmentDate FROM public."Order" 
WHERE createdAt > NOW() - INTERVAL '5 minutes'
ORDER BY id DESC;
```

### Create Test Tasks Manually
```sql
INSERT INTO "Task" (
  title, status, priority, entityId, taskRuleId, 
  assignedToId, slaDeadline, createdAt
)
VALUES 
  ('Critical Test', 'ASSIGNED', 'URGENT', 1, 'R1', 5, 
   NOW() + INTERVAL '5 minutes', NOW()),
  ('Warning Test', 'IN_PROGRESS', 'HIGH', 2, 'R2', 6,
   NOW() + INTERVAL '20 minutes', NOW()),
  ('Safe Test', 'CREATED', 'MEDIUM', 3, 'R3', NULL,
   NOW() + INTERVAL '45 minutes', NOW());
```

---

## 🚀 Performance Testing (Priority: MEDIUM)

### Test 1: API Response Times
```bash
# Measure /api/tasks with 1000 tasks
time curl "http://localhost:3000/api/tasks?limit=50" > /dev/null

# Expected: < 200ms
```

### Test 2: Status Distribution Performance
```bash
time curl "http://localhost:3000/api/tasks/status-distribution" > /dev/null

# Expected: < 100ms
```

### Test 3: Page Load Performance
1. Open browser dev tools (F12)
2. Network tab
3. Open All Tasks screen
4. Check:
   - DOMContentLoaded: < 2s
   - Network requests: < 5 major requests
   - No console errors

---

## ✅ Pre-QA Checklist

- [ ] Database migration applied (`npx prisma migrate deploy`)
- [ ] Environment variable set (`TIMEZONE=Asia/Kolkata`)
- [ ] Frontend deployed (AllTasksBoard.tsx updated)
- [ ] Backend restarted (new endpoints available)
- [ ] No console errors on page load
- [ ] All 6 API endpoints responding (test with curl)
- [ ] Sample test data created for testing

---

## 📋 Test Execution Log

**Date:** ___________  
**Tester:** ___________

| Test | Status | Notes |
|------|--------|-------|
| C1.1 Duplicate Prevention | ☐ PASS | _____ |
| C1.2 Polling Lock | ☐ PASS | _____ |
| C1.3 Status Validation | ☐ PASS | _____ |
| C1.4 Timezone Support | ☐ PASS | _____ |
| Feature 1 Refresh | ☐ PASS | _____ |
| Feature 3 Colors | ☐ PASS | _____ |
| Feature 4 Widget | ☐ PASS | _____ |
| Feature 5 Assignment | ☐ PASS | _____ |
| Bulk Operations | ☐ PASS | _____ |
| Performance | ☐ PASS | _____ |

---

## 🆘 Troubleshooting

### "Feature 1 button not visible"
- Check: AllTasksBoard.tsx has refresh button in header
- Look for: `<button onClick={handleRefresh}>`
- Fix: Verify component deployed, browser cache cleared

### "Colors not changing on rows"
- Check: API response includes `slaStatus` field
- Look for: `getSlaRowColor(task.slaStatus)` in table row className
- Fix: Verify API returning slaStatus, component redeployed

### "Status widget showing zeros"
- Check: `/api/tasks/status-distribution` endpoint accessible
- Look for: `fetchStatusDistribution()` called on mount and every 10s
- Fix: Verify endpoint created, database has tasks

### "Assignment badge not showing"
- Check: API response includes `assignmentMethod` and `assignmentRuleId`
- Look for: Badge rendering logic in task table row
- Fix: Verify fields populated in database, component showing them

### "Can't block CREATED task, getting wrong error"
- Check: `/api/tasks/bulk` route.ts has status validation
- Look for: `blockableStatuses = [ASSIGNED, IN_PROGRESS]`
- Fix: Verify validation code present, task in correct status

---

## 📞 Contact

All code is production-ready. If tests fail, contact development team with:
1. Test case that failed
2. Expected vs actual result
3. Screenshot/logs if available
4. Steps to reproduce

**Status: READY FOR QA** ✅

**Estimated QA Duration:** 2-3 days for thorough testing  
**Exit Criteria:** All 9 tests PASS, no blocking issues
