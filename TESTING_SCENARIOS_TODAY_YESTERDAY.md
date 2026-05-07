# OpsFlow Testing Scenarios - TODAY & YESTERDAY Orders

## Overview

This guide provides **step-by-step testing scenarios** for validating the complete HOME SAMPLE (HSC) and INJECTION workflows using orders with TODAY and YESTERDAY appointment dates.

All test scripts are in: `tests/fixtures/test-scenarios-today-yesterday.sql`

---

## Test Data Summary

### Order IDs 2000000-2000015 Created

| Order ID | Type | Appointment | Initial Status | Purpose |
|----------|------|-------------|-----------------|---------|
| **2000000** | HOME_SAMPLE | TODAY 2:00 PM | ORDER_SCHEDULED | Test complete HSC flow from start |
| **2000001** | HOME_SAMPLE | YESTERDAY 2:00 PM | ORDER_SCHEDULED | Test stale order follow-up (120+ min) |
| **2000002** | HOME_SAMPLE | YESTERDAY 2:00 PM | PHLEBO_ASSIGNED | Test phlebo dispatch scenario |
| **2000003** | HOME_SAMPLE | YESTERDAY 2:00 PM | PHLEBO_DISPATCHED | Test collection and patient missed |
| **2000004** | HOME_SAMPLE | YESTERDAY 2:00 PM | SAMPLE_COLLECTED | Test sample handover and report |
| **2000005** | HOME_SAMPLE | YESTERDAY 2:00 PM | SAMPLE_RECEIVED | Test report delivery follow-up |
| **2000006** | HOME_SAMPLE | TODAY 8:00 AM | PHLEBO_ASSIGNED | Test early morning appointment |
| **2000010** | INJECTION | TODAY 3:00 PM | PHLEBO_ASSIGNED | Test injection assign medic |
| **2000011** | INJECTION | YESTERDAY 3:00 PM | PHLEBO_ASSIGNED | Test injection yesterday flow |

---

## Rule Trigger Reference

### HOME SAMPLE Rules & Their Triggers

```
Rule                          Trigger Condition                    SLA
─────────────────────────────────────────────────────────────────────────
Confirm Booking              NEW order (ORDER_SCHEDULED)            30 min
Assign Phlebotomist          At creation or ORDER_SCHEDULED         Immediate
Phlebo Dispatch              PHLEBO_ASSIGNED status                 30 min BEFORE appt
Confirm Collected            15+ min AFTER appointment              20 min (URGENT)
Sample Handover              30+ min after SAMPLE_COLLECTED         30 min
Patient Missed Follow-up      45+ min AFTER appt (if not collected) 30 min
Stale Order Follow-up        120+ min in same status               30 min
Report Follow-up             240+ min (4h) after collection        45 min
```

### INJECTION Rules & Their Triggers

```
Rule                          Trigger Condition                    SLA
─────────────────────────────────────────────────────────────────────────
Assign Medic                  NEW INJECTION order                   30 min
Pre-visit Confirmation        60 min BEFORE appointment             30 min
Post-Admin Monitoring         After INJECTION_ADMINISTERED          15 min
```

---

## Quick Test Scenarios

### 🟢 SCENARIO A: Complete HSC Today Flow (Recommended First Test)

**Duration:** ~1 hour (if you simulate time progression)  
**Objective:** Test entire HOME SAMPLE workflow from start to finish

#### Step 1: Create Order
```sql
-- Copy SECTION 1 from test-scenarios-today-yesterday.sql
-- Creates order 2000000: TODAY at 2:00 PM, ORDER_SCHEDULED

-- Execute the INSERT for order 2000000
```

**Expected result:** Order 2000000 created

#### Step 2: Wait for Poller (5 minutes)
```bash
# Monitor server logs for:
# [Poller] 1 active orders fetched from labstack
# [Poller] Tasks created: 2, skipped: 0
```

**Expected tasks created:**
- Confirm Booking (30 min SLA)
- Assign Phlebotomist (immediate)

#### Step 3: Validate Task Creation
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT
  t.id,
  t.title,
  tr.name as rule_name,
  t."slaDeadline",
  t.status
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000000
ORDER BY t.id;
EOF
```

**Expected output:**
```
id | title | rule_name | slaDeadline | status
───┼───────┼───────────┼─────────────┼────────
 X | ...   | Confirm Booking | TODAY+30min | CREATED
 Y | ...   | Assign Phlebotomist | TODAY | CREATED
```

#### Step 4: Progress Order Status - Simulate Phlebo Assigned
```sql
UPDATE public."Order"
SET "orderStatus" = 'PHLEBO_ASSIGNED',
    "statusUpdatedAt" = NOW(),
    "phleboName" = 'Test Phlebotomist 1',
    "phleboNumber" = '9999900001'
WHERE id = 2000000;
```

#### Step 5: Wait for Next Poller Cycle
```bash
# Monitor for new tasks created
# [Poller] Tasks created: 1
```

**Expected new task:**
- Phlebo Dispatch Check (30 min BEFORE appointment)

#### Step 6: Progress Order Status - Simulate Phlebo Dispatched
```sql
UPDATE public."Order"
SET "orderStatus" = 'PHLEBO_DISPATCHED',
    "statusUpdatedAt" = NOW()
WHERE id = 2000000;
```

#### Step 7: New Tasks Should Be Created
**Expected new tasks:**
- Confirm Sample Collected (for 15+ min after appointment)
- Patient Not Available Follow-up (for 45+ min after if patient missed)

#### Step 8: Progress Order Status - Sample Collected
```sql
UPDATE public."Order"
SET "orderStatus" = 'SAMPLE_COLLECTED',
    "statusUpdatedAt" = NOW()
WHERE id = 2000000;
```

#### Step 9: New Tasks Created
**Expected new tasks:**
- Sample Handover to Lab (30+ min after collection)
- Report Follow-up (240+ min after collection)

#### Step 10: Final Status - Sample Received
```sql
UPDATE public."Order"
SET "orderStatus" = 'SAMPLE_RECEIVED',
    "statusUpdatedAt" = NOW()
WHERE id = 2000000;
```

#### Step 11: Validate Complete Flow
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT
  COUNT(*) as total_tasks,
  COUNT(CASE WHEN status = 'CREATED' THEN 1 END) as created,
  COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
  STRING_AGG(DISTINCT tr.name, ' | ') as rules_triggered
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000000;
EOF
```

**Expected:** 8+ tasks triggered from the 8 HSC rules

---

### 🔵 SCENARIO B: Stale Order Follow-up Test

**Duration:** 5 minutes + simulation  
**Objective:** Test that orders stuck in one status trigger escalation

#### Step 1: Create Yesterday's Order
```sql
-- Copy SECTION 2 - Order 2000001
-- Creates: YESTERDAY at 2:00 PM, ORDER_SCHEDULED
```

#### Step 2: Wait for Poller
**Expected tasks:**
- Confirm Booking
- Assign Phlebotomist (if still needed)
- **Stale Order Follow-up** (since 120+ min have passed since yesterday)

#### Step 3: Validate Stale Order Task
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT t.id, tr.name, t."slaDeadline"
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000001
AND tr.name LIKE '%Stale%';
EOF
```

**Expected:** Stale Order Follow-up task created

**This demonstrates:** How old unupdated orders automatically escalate

---

### 🟣 SCENARIO C: Multi-Status Yesterday Order Test

**Duration:** 10 minutes  
**Objective:** Test different statuses from yesterday trigger appropriate tasks

#### Step 1: Create Multiple Yesterday Orders with Different Statuses
```sql
-- Copy SECTION 2 - Orders 2000002, 2000003, 2000004, 2000005
-- Creates 4 orders at different stages of completion
```

#### Step 2: Wait for Poller
**Expected:**
- 2000002 (PHLEBO_ASSIGNED): Phlebo Dispatch + Stale Order
- 2000003 (PHLEBO_DISPATCHED): Confirm Collected + Patient Missed + Stale Order
- 2000004 (SAMPLE_COLLECTED): Sample Handover + Report Follow-up
- 2000005 (SAMPLE_RECEIVED): Report Follow-up

#### Step 3: Validate All Tasks
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT
  t."entityId",
  o."orderStatus",
  COUNT(*) as task_count,
  STRING_AGG(DISTINCT tr.name, ' | ') as rules
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" IN (2000002, 2000003, 2000004, 2000005)
GROUP BY t."entityId", o."orderStatus"
ORDER BY t."entityId";
EOF
```

**This demonstrates:** Different statuses trigger different rule sets

---

### 🟠 SCENARIO D: Early Morning Appointment Test

**Duration:** 5 minutes  
**Objective:** Test pre-visit tasks for early appointments

#### Step 1: Create Early Morning Order
```sql
-- Copy SECTION 3 - Order 2000006
-- Creates: TODAY at 8:00 AM, PHLEBO_ASSIGNED
```

#### Step 2: Wait for Poller
**Expected task:**
- Phlebo Dispatch Check (should trigger since 30 min before 8 AM)

#### Step 3: Validate
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT t.title, tr.name, t."slaDeadline"
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000006
AND tr.name LIKE '%Dispatch%';
EOF
```

---

### 💉 SCENARIO E: Injection Today Flow

**Duration:** 5 minutes  
**Objective:** Test INJECTION rule triggering

#### Step 1: Create INJECTION Order
```sql
-- Copy SECTION 4 - Order 2000010
-- Creates: TODAY at 3:00 PM, PHLEBO_ASSIGNED
```

#### Step 2: Wait for Poller
**Expected task:**
- Assign Medic - Home Injection

#### Step 3: Simulate Medic Assigned
```sql
UPDATE public."Order"
SET "orderStatus" = 'MEDIC_ASSIGNED'
WHERE id = 2000010;
```

#### Step 4: Next Poller Cycle
**Expected new task:**
- Pre-visit Confirmation (60 min before 3 PM)

#### Step 5: Simulate Injection Complete
```sql
UPDATE public."Order"
SET "orderStatus" = 'INJECTION_ADMINISTERED'
WHERE id = 2000010;
```

#### Step 6: Final Task
**Expected:**
- Post-Admin Monitoring

#### Step 7: Validate All Injection Tasks
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT
  COUNT(*) as total_injection_tasks,
  STRING_AGG(DISTINCT tr.name, ' | ') as all_rules
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000010;
EOF
```

**Expected:** 3 tasks (Assign Medic, Pre-visit, Post-Admin)

---

## Master Test - Run All Scenarios

### Timeline: ~30-45 minutes with poller cycles

```bash
#!/bin/bash

echo "=== STEP 1: Create All Test Orders ==="
echo "Uncomment and run these sections in order:"
echo "1. SECTION 1: Home Sample Today"
echo "2. SECTION 2: Home Sample Yesterday (5 orders)"
echo "3. SECTION 3: Home Sample Early Morning"
echo "4. SECTION 4: Injection Today"
echo "5. SECTION 5: Injection Yesterday"

echo ""
echo "=== STEP 2: Initial Poller Run ==="
echo "Wait 5 minutes or trigger poller manually"
echo "curl -X POST http://localhost:3000/api/internal/run-poller-cycle"

echo ""
echo "=== STEP 3: First Validation ==="
echo "Check: psql < tests/fixtures/validate-tasks-created.sql"

echo ""
echo "=== STEP 4: Progress Orders ==="
echo "Run SELECT queries to show current state"
echo "Then UPDATE orders to new status"

echo ""
echo "=== STEP 5: Poller Cycles ==="
echo "Repeat: Wait 5 min → Validate → Update Status → Wait 5 min"

echo ""
echo "=== STEP 6: Final Validation ==="
echo "psql < tests/fixtures/validate-tasks-created.sql"
echo "psql < tests/fixtures/validate-archiving.sql"
```

---

## Testing Checklist

### ✅ Before Starting
- [ ] Task rules are active (15 rules)
- [ ] Poller is running (check server logs)
- [ ] Database connectivity confirmed
- [ ] Have test user ID, store ID, lab ID ready

### ✅ During Testing
- [ ] Monitor poller logs for each cycle
- [ ] Validate task creation after each poller cycle
- [ ] Update order statuses to progress scenarios
- [ ] Check for any rule matching failures
- [ ] Monitor task SLA deadlines are correct

### ✅ After Testing
- [ ] All test orders show correct task count
- [ ] All rules triggered as expected
- [ ] No orphaned tasks
- [ ] No errors in polling logs
- [ ] Data integrity maintained

---

## Troubleshooting

### ❌ "No tasks created after poller ran"

**Check 1:** Are test orders visible to poller?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"orderType\", \"orderStatus\" 
  FROM public.\"Order\" 
  WHERE id >= 2000000;
"
```

**Check 2:** Are task rules active?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.task_rules WHERE \"isActive\" = true;
"
```

**Check 3:** What does polling log show?
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"ordersFound\", \"tasksCreated\", \"errorMessage\"
  FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 1;
"
```

### ❌ "Wrong number of tasks created"

**Check:** Verify order statuses match rule trigger conditions
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"orderStatus\", \"appointmentTime\", \"statusUpdatedAt\"
  FROM public.\"Order\" WHERE id >= 2000000;
"
```

### ❌ "Tasks not progressing with status updates"

**Check:** Did you wait for the next poller cycle?
- Poller runs every 5 minutes by default
- Or trigger manually if available
- Check logs for "Tasks created: X"

---

## Expected Final Results

### HOME SAMPLE Scenario A Complete
```
Order 2000000 should have 8 tasks:
✓ Confirm Booking
✓ Assign Phlebotomist
✓ Phlebo Dispatch Check
✓ Confirm Sample Collected
✓ Patient Not Available Follow-up (optional)
✓ Sample Handover to Lab
✓ Report Delivery Follow-up (optional)
+ Any stale order tasks if delayed
```

### YESTERDAY Scenario B-C Complete
```
Orders 2000001-2000005 should have:
✓ All expected tasks based on their status
✓ Stale Order Follow-up for old statuses
✓ Time-based tasks (15+ min, 30+ min, 45+, 120+, 240+)
```

### INJECTION Scenario E Complete
```
Orders 2000010-2000011 should have 3 tasks each:
✓ Assign Medic - Home Injection
✓ Pre-visit Confirmation
✓ Post-Admin Monitoring
```

---

## Next: Run the Tests

1. **Open:** `tests/fixtures/test-scenarios-today-yesterday.sql`
2. **Choose a scenario** from the guide above
3. **Copy the relevant INSERT blocks**
4. **Paste into psql** and execute
5. **Wait for poller** (or trigger manually)
6. **Validate** with the provided SQL queries
7. **Progress the order** with UPDATE statements
8. **Repeat** for next scenario

**Recommended order:**
1. Scenario A (Complete HSC)
2. Scenario B (Stale Order)
3. Scenario E (Injection)
4. Scenario C & D (Additional variations)

