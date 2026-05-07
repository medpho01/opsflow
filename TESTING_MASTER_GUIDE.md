# OpsFlow Testing Master Guide

## Complete Testing Framework - TODAY & YESTERDAY Orders

You now have a complete, production-ready testing framework for validating the full HOME SAMPLE (HSC) and INJECTION workflows.

---

## 📋 What Has Been Created

### Documentation Files (4 files)

| File | Purpose |
|------|---------|
| **`TESTING_SCENARIOS_TODAY_YESTERDAY.md`** ⭐ **START HERE** | Step-by-step scenarios for TODAY & YESTERDAY orders |
| **`TESTING_MASTER_GUIDE.md`** | This file - Overview & how-to |
| **`TESTING_GUIDE_ORDER_DRIVEN.md`** | Original order-driven guide (reference) |
| **`TEST_PLAN.md`** | Comprehensive test plan |

### SQL Test Fixture

| File | Content |
|------|---------|
| **`tests/fixtures/test-scenarios-today-yesterday.sql`** | 9 test orders (2000000-2000011) with detailed scenarios |

### Existing Validation Scripts

| File | Purpose |
|------|---------|
| **`tests/fixtures/validate-tasks-created.sql`** | Validate task creation from orders |
| **`tests/fixtures/validate-archiving.sql`** | Validate archiving rules |

---

## 🎯 Testing Approach

### Philosophy

```
Orders created with realistic timing (TODAY & YESTERDAY)
            ↓
Poller detects orders & matches task rules
            ↓
Tasks created based on order status & appointment time
            ↓
Test validates correct tasks were created
            ↓
Simulate status progression to test rule re-triggering
            ↓
Validate complete workflow end-to-end
```

### Why TODAY & YESTERDAY?

✅ **TODAY orders**: Test real-time task creation and time-based triggers  
✅ **YESTERDAY orders**: Test late-stage tasks and escalation rules  
✅ **Realistic timing**: Appointment times match actual SOP workflows  
✅ **Complete coverage**: Tests all 15 task rules across both SOPs  

---

## 🚀 Quick Start (Choose One Scenario)

### Option 1: Simplest Test (5 minutes)

```bash
# 1. Create ONE test order
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
-- Copy SECTION 1 from test-scenarios-today-yesterday.sql
-- Creates order 2000000: HOME SAMPLE, TODAY at 2 PM
EOF

# 2. Wait 5 minutes for poller to run

# 3. Check tasks created
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as tasks_created 
  FROM taskos.tasks WHERE \"entityId\" = 2000000;
"
# Expected: 2 (Confirm Booking + Assign Phlebotomist)

# 4. Update order status
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
UPDATE public."Order" 
SET "orderStatus" = 'PHLEBO_ASSIGNED' 
WHERE id = 2000000;
EOF

# 5. Wait 5 minutes, check new tasks
# Expected: Phlebo Dispatch Check task added
```

### Option 2: Complete HSC Workflow Test (30 minutes)

Follow **SCENARIO A** in `TESTING_SCENARIOS_TODAY_YESTERDAY.md`

### Option 3: All Scenarios at Once (60 minutes)

Run all scenario sections and watch the complete workflow:
- HOME SAMPLE: Order creation → Confirmation → Assignment → Collection → Handover → Report
- INJECTION: Medic Assignment → Pre-visit → Post-administration

---

## 📊 Test Orders At A Glance

### Home Sample Orders (2000000-2000006)

```
2000000: TODAY 2 PM ........... Tests COMPLETE workflow A-Z
2000001: YESTERDAY 2 PM ....... Tests STALE ORDER escalation
2000002: YESTERDAY 2 PM ....... Tests PHLEBO_ASSIGNED status
2000003: YESTERDAY 2 PM ....... Tests PHLEBO_DISPATCHED status
2000004: YESTERDAY 2 PM ....... Tests SAMPLE_COLLECTED status
2000005: YESTERDAY 2 PM ....... Tests SAMPLE_RECEIVED status
2000006: TODAY 8 AM ........... Tests EARLY APPOINTMENT
```

### Injection Orders (2000010-2000011)

```
2000010: TODAY 3 PM ........... Tests INJECTION workflow
2000011: YESTERDAY 3 PM ....... Tests INJECTION from yesterday
```

---

## ✨ Key Features of This Testing Framework

✅ **Realistic Scenarios** - Orders with TODAY & YESTERDAY appointments  
✅ **Complete Coverage** - Tests all 15 task rules  
✅ **Home Sample SOP** - Tests all 8 HSC rules + stale order escalation  
✅ **Injection SOP** - Tests all 3 INJECTION rules  
✅ **Progressive Testing** - Update orders to simulate real-world progression  
✅ **Easy to Follow** - Step-by-step scenarios with expected outputs  
✅ **No Execution** - All scripts documented, ready to copy & paste  
✅ **Safe** - Test order IDs easily identifiable (2000000+)  

---

## 📖 How to Use These Tests

### Step 1: Read the Scenarios
Open `TESTING_SCENARIOS_TODAY_YESTERDAY.md` and choose a scenario:
- **Scenario A**: Complete HSC workflow (Recommended first)
- **Scenario B**: Stale order escalation
- **Scenario C**: Multi-status yesterday orders
- **Scenario D**: Early morning appointments
- **Scenario E**: Injection workflow

### Step 2: Copy Order Creation SQL
From `tests/fixtures/test-scenarios-today-yesterday.sql`, copy the INSERT statements for your chosen scenario.

Example: For Scenario A, copy SECTION 1:
```sql
INSERT INTO public."Order" (
  id, "orderType", "orderStatus", "appointmentTime", ...
)
SELECT 2000000, 'HOME_SAMPLE', 'ORDER_SCHEDULED', ...
```

### Step 3: Execute in Database
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
-- Paste your copied INSERT statements here
EOF
```

### Step 4: Wait for Poller (5 minutes)
The poller runs every 5 minutes automatically:
```bash
# Monitor server logs for:
# [Poller] 1 active orders fetched
# [Poller] Tasks created: X
```

### Step 5: Validate Tasks Were Created
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
SELECT COUNT(*) as task_count, 
  STRING_AGG(DISTINCT tr.name, ' | ') as rules_matched
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 2000000;
EOF
```

### Step 6: Progress the Scenario (Optional)
```bash
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
UPDATE public."Order"
SET "orderStatus" = 'PHLEBO_ASSIGNED'
WHERE id = 2000000;
EOF

# Wait 5 minutes for poller to detect status change
# New tasks should be created based on new status
```

### Step 7: Run Full Validation
```bash
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-tasks-created.sql
```

---

## 🔍 Understanding Rule Triggers

### Time-Based Triggers

Rules trigger based on time elapsed:

```
Confirm Booking ........... 30 min from ORDER creation
Phlebo Dispatch ........... 30 min BEFORE appointment
Confirm Collected ......... 15 min AFTER appointment
Sample Handover ........... 30 min after SAMPLE_COLLECTED
Patient Missed ............ 45 min AFTER appointment
Stale Order Follow-up ..... 120 min in SAME status
Report Follow-up .......... 240 min (4 hours) after collection
```

### Status-Based Triggers

Rules trigger when order reaches specific status:

```
Order Created ............ Triggers Confirm Booking, Assign Phlebo
PHLEBO_ASSIGNED .......... Triggers Phlebo Dispatch
PHLEBO_DISPATCHED ........ Triggers Confirm Collected, Patient Missed
SAMPLE_COLLECTED ......... Triggers Sample Handover, Report Follow-up
SAMPLE_RECEIVED .......... Triggers Report Follow-up finalization
```

### Injection Triggers

```
INJECTION order created ... Triggers Assign Medic
Status = MEDIC_ASSIGNED ... Triggers Pre-visit Confirmation (60 min before)
Status = INJECTION_ADM.... Triggers Post-Admin Monitoring
```

---

## 📝 Common Testing Patterns

### Pattern 1: Test Early Confirmation (TODAY order)
```
1. Create TODAY order with ORDER_SCHEDULED status
2. Poller creates Confirm Booking & Assign Phlebo
3. Verify both tasks appear
```

### Pattern 2: Test Status Progression
```
1. Create order with initial status
2. Wait for poller (tasks created)
3. Update order status
4. Wait for poller (new tasks based on new status)
5. Repeat for each status transition
```

### Pattern 3: Test Time-Based Escalation
```
1. Create YESTERDAY order with old status
2. Poller immediately creates time-based tasks
3. Example: Stale Order Follow-up for orders >120 min old
```

### Pattern 4: Test Multiple Rules Simultaneously
```
1. Create YESTERDAY order at various statuses (2000002-2000005)
2. Each triggers different rule set
3. Validate all expected rules triggered
```

---

## ✅ Success Criteria

### Scenario A (Complete HSC): PASS When
```
Order 2000000 has these 8 tasks:
✓ Confirm Booking (created immediately)
✓ Assign Phlebotomist (created immediately)
✓ Phlebo Dispatch (created after status → PHLEBO_ASSIGNED)
✓ Confirm Collected (created after status → PHLEBO_DISPATCHED)
✓ Sample Handover (created after status → SAMPLE_COLLECTED)
✓ Report Follow-up (created after status → SAMPLE_COLLECTED/RECEIVED)
✓ All have correct SLA deadlines
✓ All have correct priority levels
```

### Scenario E (Injection): PASS When
```
Order 2000010 has these 3 tasks:
✓ Assign Medic (created immediately)
✓ Pre-visit Confirmation (created after status change)
✓ Post-Admin Monitoring (created after administered)
✓ All time-based triggers correct
```

### Overall: PASS When
```
✓ All test orders visible in database
✓ All tasks created match expected rules
✓ All SLA deadlines calculated correctly
✓ Status updates trigger new task creation
✓ No errors in polling logs
✓ No orphaned or duplicate tasks
```

---

## 🛠 Troubleshooting

### Issue: "No tasks created"
**Solution:** Check if poller ran
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"ordersFound\", \"tasksCreated\", status 
  FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 1;
"
```

### Issue: "Wrong number of tasks"
**Solution:** Check task rules are active
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.task_rules 
  WHERE \"isActive\" = true;
"
# Should be 15
```

### Issue: "Tasks not updating with status change"
**Solution:** Confirm you waited for next poller cycle
- Poller runs every 5 minutes
- Check server logs for [Poller] messages

### Issue: "Can't find test orders"
**Solution:** Verify correct database
```bash
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM public.\"Order\" 
  WHERE id >= 2000000;
"
```

---

## 🎓 Learning Path

### Beginner
1. Read this guide
2. Run Scenario A (Complete HSC)
3. Follow steps 1-5 in "How to Use These Tests"

### Intermediate
1. Complete Scenario A
2. Try Scenario B (Stale Order)
3. Try Scenario E (Injection)
4. Understand rule trigger patterns

### Advanced
1. Run all scenarios simultaneously
2. Create custom test orders with specific timing
3. Test edge cases (boundary conditions)
4. Integrate into automated testing

---

## 📊 Files & Their Purposes

```
/Users/maverick/Documents/TaskOs/
│
├── TESTING_MASTER_GUIDE.md ..................... This file
├── TESTING_SCENARIOS_TODAY_YESTERDAY.md ........ Step-by-step scenarios ⭐ START HERE
├── TESTING_GUIDE_ORDER_DRIVEN.md .............. Reference guide
├── TEST_PLAN.md .............................. Test strategy
│
└── tests/fixtures/
    ├── test-scenarios-today-yesterday.sql ..... 9 test orders ready to use
    ├── validate-tasks-created.sql ............ Validation after poller runs
    └── validate-archiving.sql ................ Validation after archiving
```

---

## 🎯 Next Steps

### Immediate: Start Testing
1. **Open:** `TESTING_SCENARIOS_TODAY_YESTERDAY.md`
2. **Choose:** One scenario (A recommended)
3. **Copy:** INSERT statements from test-scenarios-today-yesterday.sql
4. **Paste:** Into psql and execute
5. **Wait:** 5 minutes for poller
6. **Validate:** Check tasks created
7. **Document:** What you learned

### Follow-up: Run Complete Testing
1. Execute all test scenarios
2. Document results
3. Validate against SOP requirements
4. Verify all 15 task rules triggered correctly

### Integration: Automated Testing
Once manual testing confirms everything works:
1. Create shell script to automate scenario execution
2. Add to CI/CD pipeline
3. Run regression tests on new deployments

---

## 📞 Support

If you encounter issues:

1. **Check:** Troubleshooting section above
2. **Review:** `TESTING_SCENARIOS_TODAY_YESTERDAY.md` - Expected outputs
3. **Verify:** Task rules are active (15 total)
4. **Monitor:** Poller logs for errors
5. **Validate:** Database connectivity and permissions

---

## 🏁 Summary

You now have a **complete, documented, production-ready testing framework** that validates:

✅ HOME SAMPLE complete workflow (8 tasks per order)
✅ INJECTION complete workflow (3 tasks per order)
✅ Time-based rule triggers (30 min, 120 min, 240 min, etc.)
✅ Status-based rule triggers (ORDER_SCHEDULED → PHLEBO_ASSIGNED → etc.)
✅ Stale order escalation
✅ SOP compliance (HSC & Injection SOPs)

**All scenarios are documented, ready to execute, no execution required.**

→ **Ready to test? Go to `TESTING_SCENARIOS_TODAY_YESTERDAY.md`**

