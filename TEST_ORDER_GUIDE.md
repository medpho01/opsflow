# Phase 1 QA - Test Order Guide

**Test Order Created:** May 1, 2026  
**Test Order IDs:** 46248, 46249  

---

## 📋 Test Orders Summary

| Order ID | Type | Status | Appointment Time | Purpose |
|----------|------|--------|------------------|---------|
| **46248** | HOME_SAMPLE | ORDER_SCHEDULED | 2 hours from now | Test future appointments |
| **46249** | HOME_SAMPLE | ORDER_SCHEDULED | 2 hours AGO | Test immediate task creation ⭐ |

**Start with Order 46249** - It has a past appointment time, so rules will trigger immediately.

---

## 🚀 Step-by-Step Testing

### Step 1: Start Your Application
```bash
cd /Users/maverick/Documents/TaskOs
npm run build
npm run start
```

Wait for server to be ready (should say "Ready in X ms" or similar).

### Step 2: Manually Trigger the Poller (In another terminal)
```bash
curl -X GET http://localhost:3000/api/debug/trigger-poller

# Expected response:
# { "success": true, "cycle": 1, "tasksCreated": 3, "tasksFailed": 0 }
```

### Step 3: Verify Tasks Were Created
```bash
curl http://localhost:3000/api/tasks | jq '.tasks[] | {id, title, status, slaStatus, entityId}'
```

You should see tasks with:
- `entityId: 46249` (our test order)
- Various statuses (CREATED, ASSIGNED, IN_PROGRESS)
- Various SLA statuses (safe, warning, critical)

### Step 4: Open Browser and View All Tasks Screen
```
http://localhost:3000/api/tasks  (or wherever your app runs)
```

**Verify Features Work:**
- ✅ **Feature 1:** Refresh button visible in header, shows "Last updated: X ago"
- ✅ **Feature 3:** Task rows have background colors (green/yellow/orange/red)
- ✅ **Feature 4:** Status distribution widget shows counts in header
- ✅ **Feature 5:** Task rows show assignment badges ("✓ Auto" or "🔄 Manual")

---

## 📊 Expected Tasks to Be Created

For order **46249** (HOME_SAMPLE with past appointment), these rules should trigger:

### **Immediate Rules (Trigger on ORDER_CREATED or status match):**
1. ✅ **hsc_r1_confirm_booking** - "HSC: Confirm Booking"
   - SLA: 30 minutes
   - Status: CREATED

2. ✅ **hsc_r2_assign_phlebo** - "HSC: Assign Phlebotomist"  
   - SLA: 30 minutes
   - Status: CREATED

### **Time-Based Rules (Trigger based on appointment time):**
3. ✅ **hsc_r3_phlebo_dispatch** - "HSC: Phlebo Dispatch Check"
   - Trigger: PHLEBO_ASSIGNED status + 0 mins
   - SLA: 20 minutes
   - **Status:** Will NOT trigger yet (needs PHLEBO_ASSIGNED status)

4. ✅ **hsc_r4_confirm_collected** - "HSC: Confirm Sample Collected"
   - Trigger: 15 mins after appointment (ALREADY PASSED)
   - SLA: 20 minutes
   - **Status:** Will NOT trigger yet (needs PHLEBO_ASSIGNED status)

5. ⚠️ **hsc_r6_patient_missed** - "HSC: Patient Not Available Follow-up"
   - Trigger: 45 mins after appointment (ALREADY PASSED)
   - SLA: 30 minutes
   - **Status:** Will trigger next poller run

### **Future Rules (Based on status changes):**
6. ⚠️ **hsc_r5_sample_handover** - "HSC: Sample Handover to Lab"
   - Trigger: 30 mins after SAMPLE_COLLECTED
   - **Status:** Triggers after sample collection

7. ⚠️ **hsc_r7_stale_order** - "HSC: Stale Order Follow-up"
   - Trigger: 120 mins same status
   - **Status:** Triggers later

8. ⚠️ **hsc_r8_report_followup** - "HSC: Report Delivery Follow-up"
   - Trigger: 240 mins after sample collected
   - **Status:** Triggers much later

---

## 🔄 Testing the Full Workflow

### To Test More Rules, Update Order Status:

```bash
# Update order status to PHLEBO_ASSIGNED
psql -h localhost -U postgres -d labstack << 'EOF'
UPDATE public."Order"
SET "orderStatus" = 'PHLEBO_ASSIGNED',
    "statusUpdatedAt" = NOW(),
    "updatedAt" = NOW()
WHERE id = 46249;
EOF

# Then trigger poller again
curl -X GET http://localhost:3000/api/debug/trigger-poller
```

This will trigger:
- `hsc_r3_phlebo_dispatch` - Phlebo Dispatch Check
- `hsc_r4_confirm_collected` - Confirm Sample Collected (if 15+ mins after appt)
- Any other PHLEBO_ASSIGNED-dependent rules

### Continue the Workflow:

```bash
# Update to SAMPLE_COLLECTED
psql -h localhost -U postgres -d labstack << 'EOF'
UPDATE public."Order"
SET "orderStatus" = 'SAMPLE_COLLECTED',
    "statusUpdatedAt" = NOW(),
    "updatedAt" = NOW()
WHERE id = 46249;
EOF

# Trigger poller
curl -X GET http://localhost:3000/api/debug/trigger-poller
```

This will trigger:
- `hsc_r5_sample_handover` - Sample Handover to Lab

---

## ✅ Phase 1 Feature Testing

While testing the order, verify all Phase 1 features work:

### Feature 1: Refresh Button + Timestamp
- [ ] Click refresh button in header
- [ ] Verify "Last updated: X ago" updates every 10 seconds
- [ ] Verify task list reloads
- [ ] Verify selected tasks preserved

### Feature 3: Color-Coded Urgency
- [ ] Create task with 5-min SLA → should be RED
- [ ] Create task with 20-min SLA → should be ORANGE/YELLOW
- [ ] Create task with 45-min SLA → should be GREEN
- [ ] Colors update as SLA countdown progresses

### Feature 4: Status Distribution Widget
- [ ] Widget visible in top-right of header
- [ ] Shows format: "X CREATED | Y ASSIGNED | Z IN_PROGRESS | ..."
- [ ] Counts match actual tasks
- [ ] Updates every 10 seconds

### Feature 5: Assignment Status Visibility
- [ ] Tasks show "✓ Auto" badge (auto-assigned by rules)
- [ ] Hover over badge shows tooltip with rule name
- [ ] Manual reassignments show "🔄 Manual" badge

---

## 🔍 Debugging Commands

### Check All Tasks for Your Test Order:
```bash
psql -h localhost -U postgres -d labstack << 'EOF'
SELECT 
  t.id, t.title, t.status, t.priority, t."slaDeadline", t."slaStatus", r.name
FROM taskos.tasks t
LEFT JOIN taskos.task_rules r ON t."taskRuleId" = r.id
WHERE t."entityId" = 46249
ORDER BY t."createdAt";
EOF
```

### Check Order Status:
```bash
psql -h localhost -U postgres -d labstack << 'EOF'
SELECT id, "orderType", "orderStatus", "appointmentTime", "createdAt"
FROM public."Order"
WHERE id IN (46248, 46249);
EOF
```

### Check Polling Lock Status:
```bash
psql -h localhost -U postgres -d labstack << 'EOF'
SELECT "lockKey", "lockedAt", "lockedUntil" FROM taskos.polling_locks;
EOF
```

### Check Task Counts by Status:
```bash
curl http://localhost:3000/api/tasks/status-distribution | jq
```

---

## 📝 Test Checklist

### Critical Bug Fixes Verification:
- [ ] **C1.1** No duplicate tasks created (run poller twice on same order)
- [ ] **C1.2** Only one poller instance runs (check logs for lock acquisition)
- [ ] **C1.3** Can't block CREATED tasks (try bulk block on fresh task)
- [ ] **C1.4** SLA deadlines respect timezone (check slaDeadline in UTC)

### Foundation Features Verification:
- [ ] **Feature 1** Refresh button works, timestamp updates
- [ ] **Feature 3** Task rows color-coded by SLA status
- [ ] **Feature 4** Status widget shows accurate counts
- [ ] **Feature 5** Assignment badges show correct method

### Bulk Operations:
- [ ] Reassign multiple tasks
- [ ] Cancel multiple tasks
- [ ] Block multiple ASSIGNED tasks (should work)
- [ ] Try to block CREATED tasks (should fail with error)

---

## 🚨 Common Issues & Solutions

### "No tasks created after poller trigger"
- Check: Order appointment time is in the PAST
- Check: Order status matches rule conditions
- Check: Task rules are ACTIVE in database
- Fix: Run poller multiple times if needed

### "Duplicate tasks created"
- Check: Unique constraint is working
- Verify: `tasks_unique_active_task_per_rule` index exists
- Query: `SELECT * FROM taskos.tasks WHERE "entityId" = 46249`

### "Refresh button not showing"
- Check: AllTasksBoard.tsx deployed (grep Feature 1)
- Check: Browser cache cleared (Ctrl+Shift+Delete)
- Check: /api/tasks/metadata endpoint returns 200

### "Colors not appearing on rows"
- Check: API response includes `slaStatus` field
- Check: Component receiving slaStatus data
- Check: Tailwind CSS classes applied correctly

### "Status widget shows zeros"
- Check: /api/tasks/status-distribution endpoint accessible
- Check: Database has tasks
- Check: Role scoping correct (OPS_AGENT sees only assigned)

---

## 🎯 Success Criteria

**Phase 1 QA PASS when:**
- ✅ All 4 critical bugs verified fixed
- ✅ All 5 features working end-to-end
- ✅ Test order creates multiple tasks
- ✅ Tasks have correct SLA deadlines
- ✅ Tasks grouped by status correctly
- ✅ Color coding visible and updating
- ✅ No duplicate tasks created
- ✅ Bulk operations work without errors

---

## Test Order Reference

| Field | Value |
|-------|-------|
| **Test Order ID** | 46249 |
| **Order Type** | HOME_SAMPLE |
| **Status** | ORDER_SCHEDULED |
| **Appointment Time** | ~2 hours ago (triggers immediate rules) |
| **Store ID** | 1 |
| **Expected Tasks** | 3-4 (on first poller run) |
| **Expected SLA Range** | 20-30 minutes |

---

**Ready to test?** Start with Step 1 above! 🚀
