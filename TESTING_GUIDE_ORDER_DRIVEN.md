# OpsFlow Order-Driven Testing Guide

## Overview

This testing approach validates the **complete end-to-end workflow**:

1. ✅ Create test **orders** in labstack public schema
2. ✅ Poller detects orders and **matches task rules**
3. ✅ Validates **correct tasks are created** from orders
4. ✅ Run archive job and **validate archiving**
5. ✅ Verify **task lifecycle** is correct

---

## Prerequisites

✓ Task rules created (Home Injection & Other Services)
✓ Poller running or accessible
✓ Database connection to both `labstack` (public) and `taskos` schemas
✓ Archive scheduler configured

---

## Test Scenarios

### Test Order Summary

| Order ID | Type | Appointment | Days Old | Expected Status |
|----------|------|-------------|----------|-----------------|
| 1000000 | INJECTION | 25 days ago | 25 | ✓ Archive |
| 1000001 | INJECTION | 20 days ago | 20 | ✓ Archive |
| 1000002 | INJECTION | 2 days ago | 2 | 🟢 Active |
| 1000003 | INJECTION | 10 days ago | 10 | ✓ Archive |
| 1000004 | HOME_SAMPLE | 22 days ago | 22 | ✓ Archive |
| 1000005 | HOME_SAMPLE | 5 days ago | 5 | 🟢 Active |

---

## Step 1: Create Test Orders (2 minutes)

### Run the fixture script:
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/create-test-orders.sql
```

### Expected output:
```
INSERT 0 6
 id  | orderType | orderStatus  | appointmentTime | days_old | expected_status
-----+-----------+--------------+-----------------+----------+------------------
 ... | INJECTION | PHLEBO_ASSIGNED | ... | 25 | ✓ SHOULD ARCHIVE
 ... | INJECTION | PHLEBO_ASSIGNED | ... | 20 | ✓ SHOULD ARCHIVE
 ... | INJECTION | PHLEBO_ASSIGNED | ... | 2  | ✗ KEEP ACTIVE
 ... | INJECTION | PHLEBO_ASSIGNED | ... | 10 | ✓ SHOULD ARCHIVE
 ... | HOME_SAMPLE | PHLEBO_ASSIGNED | ... | 22 | ✓ SHOULD ARCHIVE
 ... | HOME_SAMPLE | PHLEBO_ASSIGNED | ... | 5  | ✗ KEEP ACTIVE
```

### Verify creation:
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as test_orders_created FROM public.\"Order\" WHERE id >= 1000000;
"
# Should return: 6
```

---

## Step 2: Run the Poller (1 minute)

### Option A: Automatic (if poller is running)
The poller runs every 5 minutes automatically. Wait for the next cycle:

```bash
# Monitor poller logs - check server output for:
# [Poller] Cycle started at ...
# [Poller] 6 active orders fetched from labstack
# [Poller] Tasks created: X, skipped: Y
# [Poller] Cycle finished in Xms
```

### Option B: Manual Trigger via API
```bash
# Create a simple endpoint call to trigger the poller
curl -X POST http://localhost:3000/api/internal/run-poller-cycle 2>/dev/null || \
  echo "Poller trigger not available - waiting for automatic cycle"
```

### Option C: Direct Database Check
If poller has run, you should see polling logs:

```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT * FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC 
  LIMIT 3;
"
```

---

## Step 3: Validate Task Creation (3 minutes)

After the poller runs, validate that tasks were created from orders:

```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-tasks-created.sql
```

### Key Validations to Check:

#### A. Task Count Summary
```
Test Orders Created: 6
Tasks Created from Test Orders: 18 (3 tasks per order for INJECTION)
Task Rules Matched: 3-6 (depending on rule matching)
```

#### B. Tasks by Order
Expected breakdown:
```
Order 1000000 (INJECTION, 25 days): 3 tasks
  - Assign Medic - Home Injection
  - Pre-visit Confirmation - Home Injection
  - Post-Admin Monitoring - Home Injection

Order 1000001 (INJECTION, 20 days): 3 tasks
  - Same 3 rules as above
  
Order 1000002 (INJECTION, 2 days): 3 tasks
  - Same 3 rules (should NOT archive)
  
Order 1000003 (INJECTION, 10 days): 3 tasks
  - Same 3 rules (boundary case - should archive)

Order 1000004 (HOME_SAMPLE, 22 days): 1+ tasks
  - May trigger different rules based on configuration
  
Order 1000005 (HOME_SAMPLE, 5 days): 1+ tasks
  - Should NOT archive
```

#### C. Validation Status
Look for **PASS/FAIL** status in the output:
```
✓ PASS - Expected task count matches actual
✗ FAIL - Expected task count does not match
```

### If Tasks Were NOT Created:

**Check 1: Are task rules active?**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, name, \"isActive\" FROM taskos.task_rules 
  WHERE name LIKE '%Injection%' OR name LIKE '%Other%';
"
```
All should show `isActive = true`

**Check 2: What does polling log show?**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"ordersFound\", \"tasksCreated\", status, \"errorMessage\"
  FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 1;
"
```

**Check 3: Are test orders visible to poller?**
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"orderType\", \"orderStatus\", \"appointmentTime\"
  FROM public.\"Order\"
  WHERE id >= 1000000 AND \"orderStatus\" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED');
"
# Should return 6 orders
```

---

## Step 4: Run Archive Job (1 minute)

```bash
curl -X POST http://localhost:3000/api/tasks/archive
```

**Expected response:**
```json
{
  "success": true,
  "message": "Archive job executed successfully"
}
```

### Monitor execution:
```bash
# Check server logs for:
# [TaskArchiver] Starting archive cycle
# [TaskArchiver] Archiving tasks on orders with appointment before YYYY-MM-DD
# [TaskArchiver] Archived X old tasks
```

---

## Step 5: Validate Archiving (2 minutes)

```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-archiving.sql
```

### Key Validations to Check:

#### A. Archive Status Summary
Expected:
```
Total Test Tasks: 18
Active Tasks: 6 (only orders 1000002 & 1000005)
Archived Tasks: 12 (orders 1000000, 1000001, 1000003, 1000004)
```

#### B. Archive Status by Order
```
1000000 (25 days): 3 archived ✓ CORRECT
1000001 (20 days): 3 archived ✓ CORRECT
1000002 (2 days): 3 active ✓ CORRECT
1000003 (10 days): 3 archived ✓ CORRECT (boundary case)
1000004 (22 days): X archived ✓ CORRECT
1000005 (5 days): X active ✓ CORRECT
```

#### C. Days Since Appointment
Verify calculation works:
```
- Old orders should show 10-25 days
- Recent orders should show 2-5 days
- All values should match order appointment times
```

#### D. Final Test Report
Look for:
```
Test Pass Rate: 6/6 (or similar)
Passed Tests: 6
Failed Tests: 0
Overall Result: ✓ ALL TESTS PASSED
```

---

## Complete Test Flow (Single Command)

Run all steps at once:

```bash
#!/bin/bash

echo "=== Step 1: Create Test Orders ==="
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/create-test-orders.sql
echo ""

echo "=== Waiting for Poller Cycle (next 5 min or trigger manually) ==="
echo "In another terminal, if available, trigger:"
echo "  curl -X POST http://localhost:3000/api/internal/run-poller-cycle"
echo ""
echo "Waiting 30 seconds for poller to process..."
sleep 30

echo "=== Step 2: Validate Task Creation ==="
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-tasks-created.sql
echo ""

echo "=== Step 3: Run Archive Job ==="
curl -X POST http://localhost:3000/api/tasks/archive
echo ""
sleep 2

echo "=== Step 4: Validate Archiving ==="
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-archiving.sql
echo ""

echo "=== TEST COMPLETE ==="
```

---

## Cleanup (Optional)

Remove test data after validation:

```bash
# Delete test tasks
psql postgresql://maverick@localhost:5432/labstack -c "
  DELETE FROM taskos.tasks WHERE \"entityId\" >= 1000000;
"

# Delete test orders
psql postgresql://maverick@localhost:5432/labstack -c "
  DELETE FROM public.\"Order\" WHERE id >= 1000000;
"

echo "✓ Test data cleaned up"
```

---

## Troubleshooting

### Problem: Poller didn't create any tasks

**Check:** Are test orders visible?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM public.\"Order\" WHERE id >= 1000000;
"
```

**Check:** Are task rules active?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.task_rules WHERE \"isActive\" = true;
"
```

**Check:** What does polling log show?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT * FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 1 \gx
"
```

### Problem: Tasks created but not correct number

**Check:** Task rule trigger conditions
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, name, \"triggerCondition\" FROM taskos.task_rules WHERE \"isActive\" = true;
"
```

**Check:** Order status filtering
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"id\", \"orderStatus\" FROM public.\"Order\" WHERE id >= 1000000;
"
```

### Problem: Tasks not archiving

**Check:** Are appointment times in metadata?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, metadata->>'appointmentTime' 
  FROM taskos.tasks WHERE \"entityId\" >= 1000000 LIMIT 3;
"
```

**Check:** Is appointment time 10+ days old?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"entityId\",
    EXTRACT(DAY FROM NOW() - (metadata->>'appointmentTime')::timestamp) as days_old
  FROM taskos.tasks WHERE \"entityId\" >= 1000000;
"
```

---

## Success Criteria

✅ **Phase 1: Task Creation**
- 6 test orders created in public."Order"
- 18 tasks created in taskos.tasks (3 per INJECTION order)
- Task rules matched correctly
- No errors in polling logs

✅ **Phase 2: Task Lifecycle**
- Tasks have correct status (CREATED initially)
- SLA deadlines calculated correctly
- Task metadata contains appointment time

✅ **Phase 3: Archiving**
- Old orders (10+ days): tasks archived (isArchived = true)
- Recent orders (<10 days): tasks remain active (isArchived = false)
- Archive job completes without errors
- daysSinceAppointment calculated correctly

✅ **Phase 4: Data Integrity**
- No orphaned tasks
- No data loss during archiving
- Referential integrity maintained
- Task history preserved

---

## Next Steps

After successful validation:

1. ✅ Review test results for any unexpected behavior
2. ✅ Check archive view UI shows archived test tasks correctly
3. ✅ Monitor live orders to ensure same pattern occurs
4. ✅ Deploy with confidence to production

