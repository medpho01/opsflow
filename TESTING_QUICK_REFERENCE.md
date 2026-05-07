# OpsFlow Testing - Quick Reference Card

## 🎯 Start Here

**Goal:** Test the complete HOME SAMPLE and INJECTION workflows with TODAY & YESTERDAY orders

**Files to Read:**
1. **`TESTING_MASTER_GUIDE.md`** - Overview
2. **`TESTING_SCENARIOS_TODAY_YESTERDAY.md`** ⭐ - Step-by-step execution

**Test Orders Available:**
- 9 test orders (IDs 2000000-2000011)
- 2 order types: HOME_SAMPLE (7), INJECTION (2)
- 2 appointment times: TODAY & YESTERDAY
- All documented and ready to use

---

## 📋 Test Scenarios

| Scenario | Order ID | Type | Timing | Tests |
|----------|----------|------|--------|-------|
| **A** | 2000000 | HOME_SAMPLE | TODAY 2 PM | Complete HSC workflow (Recommended) |
| **B** | 2000001 | HOME_SAMPLE | YESTERDAY 2 PM | Stale order escalation |
| **C** | 2000002-5 | HOME_SAMPLE | YESTERDAY 2 PM | Multi-status progression |
| **D** | 2000006 | HOME_SAMPLE | TODAY 8 AM | Early morning appointment |
| **E** | 2000010-11 | INJECTION | TODAY 3 PM | Injection workflow |

---

## ⚡ 5-Minute Quick Test

```bash
# 1. Copy SECTION 1 from test-scenarios-today-yesterday.sql
#    (Creates order 2000000)

# 2. Paste and run in psql:
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
-- Paste INSERT for order 2000000 here
EOF

# 3. Wait 5 minutes for poller

# 4. Check tasks created:
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) FROM taskos.tasks WHERE \"entityId\" = 2000000;
"
# Expected: 2 (Confirm Booking + Assign Phlebotomist)

# 5. Done! Scenario A started
```

---

## 📊 Task Rules Matrix

### HOME SAMPLE (HSC) - 8 Rules

| # | Rule | Trigger | SLA |
|---|------|---------|-----|
| 1 | Confirm Booking | NEW order | 30 min |
| 2 | Assign Phlebotomist | ORDER_SCHEDULED | Immediate |
| 3 | Phlebo Dispatch | PHLEBO_ASSIGNED | 30 min BEFORE appt |
| 4 | Confirm Collected | 15+ min AFTER appt | 20 min |
| 5 | Sample Handover | 30+ min after collection | 30 min |
| 6 | Patient Missed | 45+ min AFTER appt | 30 min |
| 7 | Stale Order | 120+ min same status | 30 min |
| 8 | Report Follow-up | 240+ min post-collection | 45 min |

### INJECTION - 3 Rules

| # | Rule | Trigger | SLA |
|---|------|---------|-----|
| 1 | Assign Medic | NEW INJECTION | 30 min |
| 2 | Pre-visit | 60 min before appt | 30 min |
| 3 | Post-Admin | After injection | 15 min |

---

## 🔄 Typical Test Flow

```
Create Order
    ↓
[Poller runs - 5 min]
    ↓
Validate Tasks Created (2-3 tasks)
    ↓
Update Order Status
    ↓
[Poller runs - 5 min]
    ↓
Validate New Tasks Created
    ↓
Repeat until complete
```

---

## ✅ Validation Commands

```bash
# Check created tasks
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT COUNT(*) as total, 
    COUNT(DISTINCT tr.name) as rules_triggered
  FROM taskos.tasks t
  LEFT JOIN taskos.task_rules tr ON tr.id = t.\"taskRuleId\"
  WHERE t.\"entityId\" = 2000000;
"

# Check specific rules triggered
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT DISTINCT tr.name
  FROM taskos.tasks t
  LEFT JOIN taskos.task_rules tr ON tr.id = t.\"taskRuleId\"
  WHERE t.\"entityId\" = 2000000
  ORDER BY tr.name;
"

# Check polling history
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT \"ordersFound\", \"tasksCreated\", status
  FROM taskos.\"PollingLog\" 
  ORDER BY \"startedAt\" DESC LIMIT 3;
"
```

---

## 🔧 Progression Commands

```bash
# Update order status (copy and modify):
psql postgresql://maverick@localhost:5432/labstack << 'EOF'
UPDATE public."Order"
SET "orderStatus" = 'PHLEBO_ASSIGNED',
    "statusUpdatedAt" = NOW(),
    "phleboName" = 'Test Phlebotomist',
    "phleboNumber" = '9999900001'
WHERE id = 2000000;
EOF

# Check current status
psql postgresql://maverick@localhost:5432/labstack -c "
  SELECT id, \"orderStatus\", \"statusUpdatedAt\"
  FROM public.\"Order\" WHERE id >= 2000000;
"

# Full validation
psql postgresql://maverick@localhost:5432/labstack < tests/fixtures/validate-tasks-created.sql
```

---

## 📝 Expected Results

### Scenario A - Order 2000000

```
After 1st poller:
  ✓ Confirm Booking (30 min SLA)
  ✓ Assign Phlebotomist (immediate)

After status → PHLEBO_ASSIGNED:
  ✓ Phlebo Dispatch Check (30 min before appt)

After status → PHLEBO_DISPATCHED:
  ✓ Confirm Sample Collected (20 min SLA)
  ✓ Patient Missed Follow-up (30 min SLA) - if applicable

After status → SAMPLE_COLLECTED:
  ✓ Sample Handover (30 min SLA)
  ✓ Report Follow-up (45 min SLA)

FINAL: 7-8 tasks for complete flow
```

### Scenario B - Order 2000001

```
After 1st poller (YESTERDAY order, >24h old):
  ✓ Confirm Booking
  ✓ Assign Phlebotomist
  ✓ Stale Order Follow-up (120+ min escalation)

DEMONSTRATES: Escalation for old unupdated orders
```

### Scenario E - Orders 2000010-11

```
After 1st poller:
  ✓ Assign Medic

After status → MEDIC_ASSIGNED:
  ✓ Pre-visit Confirmation

After status → INJECTION_ADMINISTERED:
  ✓ Post-Admin Monitoring

FINAL: 3 tasks per injection order
```

---

## 🚨 Troubleshooting

| Problem | Solution |
|---------|----------|
| No tasks created | Check: (1) Is order visible? (2) Are rules active (15)? (3) Did poller run? |
| Wrong task count | Check: Order status matches rule trigger conditions |
| Tasks not updating | Confirm: You waited for next poller cycle (5 min) |
| Can't find orders | Verify: `SELECT COUNT(*) FROM public."Order" WHERE id >= 2000000;` |

---

## 📚 Full Documentation

| Document | Purpose | When to Read |
|----------|---------|--------------|
| `TESTING_MASTER_GUIDE.md` | Complete overview | Before starting |
| `TESTING_SCENARIOS_TODAY_YESTERDAY.md` | Step-by-step guide | During testing |
| `test-scenarios-today-yesterday.sql` | Test order SQL | When creating orders |
| `validate-tasks-created.sql` | Validation queries | After poller runs |

---

## ⏱ Time Estimates

| Activity | Time |
|----------|------|
| Read guide | 5 min |
| Run 1 scenario | 15-30 min |
| Run all 5 scenarios | 45-60 min |
| Full workflow + validation | 90 min |

---

## ✨ Key Points

✅ All test orders ready in `test-scenarios-today-yesterday.sql`  
✅ No execution needed - copy & paste SQL when ready  
✅ Tests all 15 task rules across both SOPs  
✅ TODAY & YESTERDAY orders for complete coverage  
✅ Validation scripts included  
✅ Troubleshooting guide provided  

---

## 🎯 Your Next Step

1. Open: `TESTING_SCENARIOS_TODAY_YESTERDAY.md`
2. Choose Scenario A (recommended)
3. Copy SECTION 1 (order 2000000)
4. Paste into psql and execute
5. Wait 5 minutes for poller
6. Validate tasks created
7. Continue with scenario progression

**You're ready to test! 🚀**

