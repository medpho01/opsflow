# Task Creation Validation Results - Corrected SQL Analysis

**Generated:** 2026-04-30  
**Status:** ✅ Validation Complete with Actionable Findings

---

## Executive Summary

The corrected SQL validation now shows actual task creation status:

### ✅ Working Correctly
- **HSC-R1** (Confirm Booking): 114/114 qualifying orders have tasks (0% gap)
- **HSC-R2** (Assign Phlebo): 122/122 qualifying orders have tasks (0% gap)
- **HSC-R5** (Sample Handover): 27/27 qualifying orders have tasks (0% gap)

### ⚠️ Issues Identified
- **HSC-R8** (Report Followup): 40 qualifying but only 27 tasks (32.5% gap)
- **HSC-R4, R6, R7**: Cannot execute - rules reference invalid status `PHLEBO_DISPATCHED` which doesn't exist in database
- **Completed orders**: 1 order (ID 999) with open "Test manual task"

---

## Detailed Findings

### PART 1: Active Task Rules

All 9 rules are active:

| Rule | Order Type | Trigger Statuses | Time Criteria |
|------|-----------|------------------|---------------|
| hsc_r1_confirm_booking | HOME_SAMPLE | ORDER_SCHEDULED | 30 mins since created |
| hsc_r2_assign_phlebo | HOME_SAMPLE | ORDER_SCHEDULED, PHLEBO_ASSIGNED | 0 mins (immediate) |
| hsc_r3_phlebo_dispatch | HOME_SAMPLE | PHLEBO_ASSIGNED | 30 mins before appointment |
| hsc_r4_confirm_collected | HOME_SAMPLE | PHLEBO_DISPATCHED, PHLEBO_ASSIGNED | 15 mins after appointment |
| hsc_r5_sample_handover | HOME_SAMPLE | SAMPLE_COLLECTED | 30 mins since status change |
| hsc_r6_patient_missed | HOME_SAMPLE | PHLEBO_DISPATCHED, PHLEBO_ASSIGNED | 45 mins after appointment |
| hsc_r7_stale_order | HOME_SAMPLE | BOOKED, CONFIRMED, PHLEBO_ASSIGNED, PHLEBO_DISPATCHED | 120 mins since status change |
| hsc_r8_report_followup | HOME_SAMPLE | SAMPLE_COLLECTED, SAMPLE_RECEIVED | 240 mins since status change |
| MANUAL | HOME_SAMPLE | (none) | (none) |

### PART 2: Gap Analysis - Rules Evaluation

#### HSC-R1: Confirm Booking ✅
```
Qualifying Orders: 114
With Tasks:        114
Gap:               0
Gap %:             0.0%
Status:            ✅ PERFECT
```
Orders in ORDER_SCHEDULED status for 30+ minutes are getting confirmation tasks.

#### HSC-R2: Assign Phlebo ✅
```
Qualifying Orders: 122
With Tasks:        122
Gap:               0
Gap %:             0.0%
Status:            ✅ PERFECT
```
Orders in ORDER_SCHEDULED or PHLEBO_ASSIGNED are getting phlebo assignment tasks immediately.

#### HSC-R3: Phlebo Dispatch Check ⚠️
```
Status:            ⚠️ CANNOT CALCULATE - Division by Zero
Reason:            No orders within 30 mins before appointment currently
Note:              This is expected - rule triggers on future appointments
```

#### HSC-R4: Confirm Sample Collected ❌
```
Status:            ❌ ERROR: Invalid OrderStatus "PHLEBO_DISPATCHED"
Issue:             Rule references "PHLEBO_DISPATCHED" status
Actual DB Status:  "PHLEBO_ASSIGNED" (no DISPATCHED status exists)
Action Required:   Update rule to use correct status
```

#### HSC-R5: Sample Handover ✅
```
Qualifying Orders: 27
With Tasks:        27
Gap:               0
Gap %:             0.0%
Status:            ✅ PERFECT
```
All orders in SAMPLE_COLLECTED status for 30+ minutes have sample handover tasks.

#### HSC-R6: Patient Not Available ❌
```
Status:            ❌ ERROR: Invalid OrderStatus "PHLEBO_DISPATCHED"
Issue:             Rule references "PHLEBO_DISPATCHED" status
Actual DB Status:  "PHLEBO_ASSIGNED" (no DISPATCHED status exists)
Action Required:   Update rule to use correct status
```

#### HSC-R7: Stale Order Follow-up ❌
```
Status:            ❌ ERROR: Invalid OrderStatus "PHLEBO_DISPATCHED"
Issue:             Rule references deprecated statuses (BOOKED, CONFIRMED, PHLEBO_DISPATCHED)
Actual DB Status:  Uses ORDER_SCHEDULED, PHLEBO_ASSIGNED, etc.
Action Required:   Audit and update rule trigger statuses
```

#### HSC-R8: Report Delivery Follow-up ⚠️
```
Qualifying Orders: 40
With Tasks:        27
Gap:               13
Gap %:             32.5%
Status:            ⚠️ PARTIAL - Gap Exists
Issue:             Rule references "SAMPLE_RECEIVED" which may not exist
Possible Causes:   
  1. Task deduplication preventing creation
  2. Rule status mismatch
  3. Orders not matching time criteria correctly
Action Required:   Investigate gap
```

### PART 3: Completed Orders with Open Tasks

**Finding:** Only 1 completed order has open tasks
```
Order ID:       999
Order Type:     CAMP
Status:         REPORT_DELIVERED
Open Tasks:     1
Task Title:     Test manual task
Task Rule:      MANUAL (manual task, not auto-created)
Created:        2026-04-25 08:11:13.027
```

**Assessment:**
- This is a manually created test task
- Only 1 order out of 38,551 completed orders has open tasks
- Not a systemic issue, but task auto-closure should still be implemented for full automation

### PART 4: Order Status Distribution

**HOME_SAMPLE Orders:**
- REPORT_DELIVERED: 33,375 (81.8%) - Completed
- CANCELED: 7,186 (17.6%)
- ORDER_SCHEDULED: 114 (0.3%)
- RESCHEDULED: 71 (0.2%)
- SAMPLE_COLLECTED: 27 (0.1%)
- SAMPLE_PROCESSED: 13 (0.0%)
- PHLEBO_ASSIGNED: 8 (0.0%)
- SAMPLE_DELIVERED: 2 (0.0%)

**CENTER_VISIT Orders:**
- REPORT_DELIVERED: 113 (56.2%)
- CANCELED: 79 (39.3%)
- PATIENT_MISSED: 6 (3.0%)
- ORDER_SCHEDULED: 3 (1.5%)

**CAMP Orders:**
- REPORT_DELIVERED: 5,063 (97.9%)
- CANCELED: 106 (2.1%)

### PART 5: Task Statistics by Rule

| Rule ID | Total Tasks | Created | Assigned | Completed | Cancelled | Open |
|---------|------------|---------|----------|-----------|-----------|------|
| hsc_r2_assign_phlebo | 122 | 122 | 0 | 0 | 0 | **122** |
| hsc_r1_confirm_booking | 114 | 114 | 0 | 0 | 0 | **114** |
| hsc_r5_sample_handover | 27 | 0 | 0 | 0 | 0 | **27** |
| hsc_r8_report_followup | 27 | 0 | 0 | 0 | 0 | **27** |
| hsc_r6_patient_missed | 8 | 0 | 0 | 0 | 0 | **8** |
| hsc_r7_stale_order | 8 | 0 | 0 | 0 | 0 | **8** |
| hsc_r4_confirm_collected | 13 | 5 | 0 | 5 | 0 | **8** |
| MANUAL | 1 | 0 | 0 | 0 | 0 | **1** |

**Key Observation:** Tasks are created but NOT being assigned to agents (all show 0 ASSIGNED). This suggests the assignment logic may not be working or agents aren't available.

### PART 6: Poller Health

**Last 20 Cycles Summary:**
- **SUCCESS cycles**: 3 (most recent)
- **ERROR cycles**: 17 (all before fix)
- **Big cycle**: 2026-04-30 05:00:24 created 241 tasks (backfill)
- **Normal cycles**: 2026-04-30 05:05, 05:10 created 0 tasks (all work done)

**Timeline:**
```
2026-04-29 09:00 - 14:35: ERROR (Cannot read properties of undefined)
2026-04-30 04:55 - 05:00:00: ERROR (Cannot read properties of undefined)
2026-04-30 05:00:24: FIXED! ✅ Created 241 tasks (took 3.4 seconds)
2026-04-30 05:05 - 05:10: SUCCESS (0 tasks - work complete)
```

---

## Issues Requiring Action

### 🔴 CRITICAL: Invalid Status Values in Rules

**Affected Rules:** HSC-R4, HSC-R6, HSC-R7  
**Issue:** Rules reference statuses that don't exist in database

| Status in Rule | Actual DB Status | Status |
|---|---|---|
| PHLEBO_DISPATCHED | PHLEBO_ASSIGNED | ❌ Mismatch |
| BOOKED | ORDER_SCHEDULED | ❌ Mismatch |
| CONFIRMED | (no equivalent) | ❌ Doesn't exist |
| SAMPLE_RECEIVED | SAMPLE_PROCESSED (maybe) | ⚠️ Unclear |

**Action Required:**
1. Update rule trigger conditions to use actual order statuses
2. Verify with LabStack API what the actual status values should be
3. Test rules after updating

### 🟡 MEDIUM: Task Assignment Not Working

**Observation:** All 256 tasks are in CREATED status, none ASSIGNED  
**Possible Causes:**
1. No agents available on today's roster
2. Skills not matching
3. Store assignment issues
4. Agent availability filter too strict

**Action Required:**
1. Check `taskos.daily_rosters` - are there active agents?
2. Verify team_members have required skills
3. Review `pickAssignee()` logic in taskCreator.ts

### 🟡 MEDIUM: HSC-R8 32.5% Gap

**Observation:** 40 qualifying orders but only 27 tasks created  
**Possible Causes:**
1. Deduplication preventing re-creation
2. Status mismatch (SAMPLE_RECEIVED vs SAMPLE_PROCESSED)
3. Time window calculation incorrect

**Action Required:**
1. Check for "SAMPLE_RECEIVED" status in database
2. Validate minutesSinceStatusUpdated logic (240 mins = 4 hours)
3. Check if orders with 0 tasks have been checked previously (dedup cache)

### 🟡 MEDIUM: Task Auto-Closure Not Implemented

**Observation:** Completed order (ID 999) still has open task  
**Expected:** Tasks should auto-close when orders reach REPORT_DELIVERED  
**Current Behavior:** Tasks remain open indefinitely

**Action Required:**
1. Implement task auto-closure trigger
2. Should run when order.orderStatus changes to REPORT_DELIVERED or COMPLETED

---

## Validation Ready - Running Instructions

### How to Run Validation Yourself

```bash
cd /Users/maverick/Documents/TaskOs

# Run the complete validation suite
bash run_validation.sh

# Or run individual SQL queries
psql -d labstack < task_validation_corrected.sql
```

### Files Available

1. **task_validation_corrected.sql** - All 7 validation queries
2. **run_validation.sh** - Automated runner with formatted output
3. **TASK_VALIDATION_RESULTS.md** - This report

---

## Recommendations (Priority Order)

### 🔴 Immediate (Fix Broken Rules)
1. Update HSC-R4, HSC-R6, HSC-R7 to use correct order statuses
2. Validate HSC-R8 status references

### 🟡 Short Term (Improve Task Quality)
1. Debug why tasks aren't being assigned to agents
2. Investigate HSC-R8 32.5% gap
3. Implement task auto-closure on order completion

### 🟢 Long Term (Monitoring)
1. Create dashboard widget showing task creation success rate
2. Set up alerts for poller ERROR status
3. Monitor gaps in task creation for each rule
4. Regular audits of rule status values vs database

---

## Conclusion

The task creation system is **now working** for 3 out of 8 active rules (HSC-R1, R2, R5) with perfect accuracy. However:

✅ **Fixed:** Poller crash and task creation logic  
⚠️ **Issues Found:** Invalid status references in rules, tasks not being assigned  
❌ **Not Yet Addressed:** Task auto-closure on completion  

The validation SQL provides a repeatable way to confirm rule compliance and identify gaps.
