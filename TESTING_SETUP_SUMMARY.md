# OpsFlow Testing Framework - Complete Setup Summary

## What Has Been Created

### 📋 Documentation Files (4 files)

1. **`TEST_PLAN.md`** - Comprehensive test strategy with scenarios and validation criteria
2. **`TESTING_GUIDE_ORDER_DRIVEN.md`** ⭐ **START HERE** - Step-by-step execution guide
3. **`TESTING_SETUP_SUMMARY.md`** - This file (overview)
4. **`TESTING_README.md`** - Quick reference guide

### 🔧 SQL Test Fixtures (3 files)

1. **`tests/fixtures/create-test-orders.sql`**
   - Creates 6 test orders with varying appointment dates
   - Order IDs: 1000000-1000005
   - Types: INJECTION (4), HOME_SAMPLE (2)
   - Ages: 2 days to 25 days old
   - Status: PHLEBO_ASSIGNED

2. **`tests/fixtures/validate-tasks-created.sql`**
   - Validates task creation from orders
   - Checks task rule matching
   - Verifies task counts and properties
   - Shows polling log history

3. **`tests/fixtures/validate-archiving.sql`**
   - Validates archiving correctness
   - Compares expected vs actual archive status
   - Checks days since appointment calculation
   - Provides final test report

---

## Testing Approach

### Philosophy: Order-Driven Testing

**Traditional Approach (❌ Not Used)**
```
Directly create tasks → Test task properties
Problem: Doesn't validate task creation rules
```

**Order-Driven Approach (✅ Used)**
```
Create Orders → Poller creates Tasks → Validate Task Rules Matched
```

This validates the **entire real-world workflow**:
1. Orders exist in labstack
2. Poller detects and processes them
3. Task rules determine which tasks to create
4. Tasks are created with correct properties
5. Tasks are archived based on appointment age

---

## Quick Start (5 minutes)

### Step 1: Create Test Orders
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/create-test-orders.sql
```

### Step 2: Wait for Poller
- Poller runs every 5 minutes automatically
- Or trigger manually if endpoint available
- Check logs for "Tasks created: X"

### Step 3: Validate Task Creation
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-tasks-created.sql
```

### Step 4: Run Archive
```bash
curl -X POST http://localhost:3000/api/tasks/archive
```

### Step 5: Validate Archiving
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-archiving.sql
```

---

## Test Data Overview

### 6 Test Orders Created

| Order ID | Service Type | Appointment | Expected Behavior |
|----------|--------------|-------------|-------------------|
| **1000000** | INJECTION | 25 days ago | ✅ Archive (3 tasks) |
| **1000001** | INJECTION | 20 days ago | ✅ Archive (3 tasks) |
| **1000002** | INJECTION | 2 days ago | 🟢 Stay Active (3 tasks) |
| **1000003** | INJECTION | 10 days ago | ✅ Archive (3 tasks) - Boundary |
| **1000004** | HOME_SAMPLE | 22 days ago | ✅ Archive (1+ tasks) |
| **1000005** | HOME_SAMPLE | 5 days ago | 🟢 Stay Active (1+ tasks) |

### Task Rules Used

**Home Injection (OrderType: INJECTION)**
- Rule 1: Assign Medic (30 min SLA)
- Rule 2: Pre-visit Confirmation (30 min SLA)
- Rule 3: Post-Admin Monitoring (15 min SLA)

**Other Services (OrderType: HOME_SAMPLE)**
- Rule 1: Assign Personnel (45 min SLA)
- Rule 2: Service Delivery (60 min SLA)
- Rule 3: Post-Service Follow-up (120 min SLA)

---

## Expected Results

### After Poller Runs
```
✓ 6 test orders in public."Order"
✓ 18 total tasks created in taskos.tasks (or 8-12 if HOME_SAMPLE rules different)
✓ Task rules matched and applied
✓ Metadata populated with order details
✓ SLA deadlines calculated
✓ Polling log shows success
```

### After Archive Job
```
✓ Orders 1000000, 1000001, 1000003, 1000004: Tasks archived (isArchived = true)
✓ Orders 1000002, 1000005: Tasks remain active (isArchived = false)
✓ daysSinceAppointment calculated (10-25 days for archived, 2-5 days for active)
✓ No data loss or orphaned records
✓ Referential integrity maintained
```

---

## Validation Checkpoints

### 🔍 Checkpoint 1: Order Creation
**Command:**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as orders FROM public.\"Order\" WHERE id >= 1000000;
"
```
**Expected:** 6

### 🔍 Checkpoint 2: Task Creation
**Command:**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as tasks FROM taskos.tasks WHERE \"entityId\" >= 1000000;
"
```
**Expected:** 18+ (3+ per order)

### 🔍 Checkpoint 3: Task Rule Matching
**Check in validate output:**
```
✓ PASS - Expected task count matches actual
```

### 🔍 Checkpoint 4: Archiving
**Check in validate output:**
```
Test Pass Rate: 6/6
Overall Result: ✓ ALL TESTS PASSED
```

### 🔍 Checkpoint 5: Archive View
Navigate to: `http://localhost:3000/head/archive`
- Should show test orders 1000000, 1000001, 1000003, 1000004
- Should NOT show orders 1000002, 1000005
- Days Since Appointment should show 10-25 days

---

## Files Map

```
/Users/maverick/Documents/TaskOs/
│
├── Documentation/
│   ├── TEST_PLAN.md ........................... Comprehensive test strategy
│   ├── TESTING_GUIDE_ORDER_DRIVEN.md ......... Step-by-step execution ⭐ START HERE
│   ├── TESTING_README.md ..................... Quick reference
│   └── TESTING_SETUP_SUMMARY.md ............. This file
│
└── tests/fixtures/
    ├── create-test-orders.sql ............... Creates 6 test orders
    ├── validate-tasks-created.sql ........... Validates task creation
    └── validate-archiving.sql ............... Validates archiving
```

---

## Troubleshooting Guide

### ❌ "No tasks created"
1. Check: Are test orders in database?
   ```bash
   psql postgresql://maverick@localhost:5432/labstack -c "
     SELECT COUNT(*) FROM public.\"Order\" WHERE id >= 1000000;
   "
   ```
2. Check: Are task rules active?
   ```bash
   psql postgresql://maverick@localhost:5432/labstack -c "
     SELECT COUNT(*) FROM taskos.task_rules WHERE \"isActive\" = true;
   "
   ```
3. Check: Did poller run?
   ```bash
   psql postgresql://maverick@localhost:5432/labstack -c "
     SELECT * FROM taskos.\"PollingLog\" 
     ORDER BY \"startedAt\" DESC LIMIT 1 \gx
   "
   ```

### ❌ "Wrong number of tasks created"
1. Check task rule matching in validate-tasks-created.sql output
2. Verify task rules have correct trigger conditions
3. Review polling log for any errors

### ❌ "Tasks not archiving"
1. Check: Appointment times in metadata?
   ```bash
   psql postgresql://maverick@localhost:5432/labstack -c "
     SELECT id, (metadata->>'appointmentTime')::timestamp as appt 
     FROM taskos.tasks WHERE \"entityId\" >= 1000000 LIMIT 3;
   "
   ```
2. Check: Is appointment time 10+ days old?
3. Review archive job response and server logs

---

## Performance Notes

- **Order creation:** < 1 second
- **Poller cycle:** 5-30 seconds (depends on system load)
- **Task creation:** < 5 seconds for all 18 tasks
- **Archive job:** < 5 seconds
- **Validation queries:** < 2 seconds each

---

## Key Concepts

### Order Status Flow
```
Orders created as PHLEBO_ASSIGNED → Poller detects → Tasks created → Tasks archived after 10 days
```

### Task Rule Matching
```
Order properties (orderType, appointmentTime, etc.) → Evaluated against trigger conditions → Tasks created if match
```

### Archiving Logic
```
If appointmentTime >= 10 days old → Set isArchived = true
Regardless of task completion status
```

---

## Safety & Cleanup

### Test Data Isolation
- Test order IDs: 1000000-1000005 (easily identifiable)
- Won't interfere with production data
- Can be safely deleted after testing

### Cleanup Commands
```bash
# Remove test orders
psql postgresql://maverick@localhost:5432/labstack -c "
  DELETE FROM public.\"Order\" WHERE id >= 1000000;
"

# Remove test tasks
psql postgresql://maverick@localhost:5432/labstack -c "
  DELETE FROM taskos.tasks WHERE \"entityId\" >= 1000000;
"

# Verify cleanup
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM public.\"Order\" WHERE id >= 1000000;
  SELECT COUNT(*) FROM taskos.tasks WHERE \"entityId\" >= 1000000;
"
# Both should return 0
```

---

## Success Criteria Summary

✅ **All tests pass when:**
- 6 test orders created successfully
- Poller detects and processes all orders
- 18 tasks created with correct properties
- Tasks archived correctly based on appointment age
- No errors in logs or database
- Archive view displays correctly

---

## Getting Started

### 👉 **IMMEDIATE NEXT STEPS:**

1. **Read:** `TESTING_GUIDE_ORDER_DRIVEN.md`
2. **Execute:** `psql < tests/fixtures/create-test-orders.sql`
3. **Monitor:** Wait for poller (or trigger manually)
4. **Validate:** `psql < tests/fixtures/validate-tasks-created.sql`
5. **Archive:** `curl -X POST http://localhost:3000/api/tasks/archive`
6. **Verify:** `psql < tests/fixtures/validate-archiving.sql`

---

## Support & Debugging

- **Task rules not active?** → Check Task Rules dashboard
- **Poller not running?** → Check server logs
- **Tasks not matching?** → Review trigger conditions
- **Archive not working?** → Check appointment time format

All SQL scripts have detailed comments explaining what they check.

