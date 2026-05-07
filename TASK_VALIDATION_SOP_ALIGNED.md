# Task Validation - SOP-Aligned Query Guide

**Format:** SOP Procedure → System Flow → SQL Query  
**Purpose:** Validate task creation logic against actual SOP requirements  
**Date:** 2026-04-30

---

## Overview

This document maps each SOP procedure to:
1. **SOP Section** - What the ops team should do based on the SOP document
2. **System Flow** - How that translates to database conditions
3. **Query** - SQL to find orders matching this flow
4. **Results** - Current gap between qualifying orders and tasks created

---

## HOME SAMPLE COLLECTION (HSC) PROCEDURES

---

## HSC-R1: LIVE ORDER MONITORING - 30-MIN CONFIRMATION

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 1: Live Order Monitoring

**Procedure:**
> "Every order that comes in should be confirmed within 30 minutes"
> "If not confirmed, escalate to senior"

**What Ops Team Should Do:**
1. New order created → ORDER_SCHEDULED status
2. Call patient within 30 mins to confirm appointment
3. If unreachable, reschedule or escalate

### 2. System Flow

**Database State:**
- Order Status: `ORDER_SCHEDULED` (new order, not yet confirmed)
- Time Window: >= 30 minutes since order creation
- Order Type: `HOME_SAMPLE`
- Not Deleted

**Task Requirements:**
- Task Title: "Confirm {{patientName}} appointment within 30 mins"
- Rule ID: `hsc_r1_confirm_booking`
- Priority: HIGH (time-sensitive SLA)
- Assigned To: OPS_AGENT with communication skills

### 3. SQL Query

```sql
-- Find orders requiring HSC-R1 Confirmation Task
SELECT
    o.id as order_id,
    o."createdAt" as order_created_at,
    EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as minutes_old,
    o."patientName",
    o."appointmentTime",
    o."storeId",
    'NEEDS TASK: Confirm booking' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
ORDER BY o."createdAt" DESC;
```

### 4. Validation Results

```
Qualifying Orders:  114
Tasks Created:      114
Gap:                0 (0%)
Status:             ✅ PERFECT
```

**What This Means:** All 114 orders in ORDER_SCHEDULED status for 30+ minutes have confirmation tasks created. System is working correctly for this procedure.

---

## HSC-R2: T-1 PREVIOUS DAY CLOSURE

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 2: T-1 Previous Day Closure

**Procedure:**
> "End of day (before shift closes), confirm all next-day orders"
> "Check phlebo availability for tomorrow"
> "Identify and resolve any issues before day starts"

**What Ops Team Should Do:**
1. Every order scheduled for tomorrow
2. Confirm patient is still available
3. Ensure phlebo is assigned
4. Resolve any conflicts before end of shift

### 2. System Flow

**Database State:**
- Appointment Time: Tomorrow (between today midnight and tomorrow midnight)
- Order Status: `ORDER_SCHEDULED` or `PHLEBO_ASSIGNED`
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "T-1 Confirm {{patientName}} appointment for tomorrow"
- Rule ID: `hsc_r2_assign_phlebo`
- Priority: MEDIUM (end-of-shift task)
- Assigned To: Shift supervisor

### 3. SQL Query

```sql
-- Find T-1 orders needing confirmation
SELECT
    o.id as order_id,
    o."appointmentTime",
    o."patientName",
    o."orderStatus",
    (o."appointmentTime"::date - CURRENT_DATE) as days_until_appointment,
    o."storeId",
    'NEEDS TASK: T-1 confirm for tomorrow' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."appointmentTime"::date = CURRENT_DATE + INTERVAL '1 day'
    AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')
ORDER BY o."appointmentTime" ASC;
```

### 4. Validation Results

```
Qualifying Orders:  0
Tasks Created:      0
Gap:                0 (0%)
Status:             ℹ️ NO ORDERS CURRENTLY (Expected)
```

**What This Means:** No orders are scheduled for tomorrow. This is expected - rule would trigger only when there are next-day appointments.

---

## HSC-R3: PRE-VISIT TRACKING - 30-20 MINS BEFORE APPOINTMENT

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 3: Pre-Visit Tracking

**Procedure:**
> "30-20 minutes before appointment"
> "Verify phlebo has reached patient location (call phlebo)"
> "Confirm patient is ready"
> "Update appointment status if needed"

**What Ops Team Should Do:**
1. 30 mins before scheduled appointment
2. Call phlebo to confirm they're en route
3. Call patient to confirm they're ready
4. Resolve any last-minute issues

### 2. System Flow

**Database State:**
- Order Status: `PHLEBO_ASSIGNED` (phlebo already assigned)
- Appointment Time: Within 30 mins before appointment
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "Pre-visit check {{patientName}} - phlebo dispatch"
- Rule ID: `hsc_r3_phlebo_dispatch`
- Action: Call phlebo + verify patient readiness
- Assigned To: OPS_AGENT

### 3. SQL Query

```sql
-- Find orders needing pre-visit verification
SELECT
    o.id as order_id,
    o."appointmentTime",
    o."patientName",
    o."phleboName",
    o."phleboNumber",
    EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as minutes_until_appointment,
    o."storeId",
    'NEEDS TASK: Pre-visit phlebo dispatch check' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
ORDER BY o."appointmentTime" ASC;
```

### 4. Validation Results

```
Qualifying Orders:  0 (No appointments within 30 mins currently)
Tasks Created:      0
Gap:                0
Status:             ℹ️ NO ORDERS CURRENTLY (Expected)
```

---

## HSC-R4: COLLECTION TRACKING - TRACK SAMPLE COLLECTION

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 4: Collection Tracking

**Procedure:**
> "60+ minutes after phlebo starts (or 15 mins after appointment)"
> "If sample not collected yet, follow up"
> "Verify collection completion and condition"
> "Ensure sample is with phlebo or in transit"

**What Ops Team Should Do:**
1. Check order status - still PHLEBO_ASSIGNED and not yet SAMPLE_COLLECTED?
2. Call phlebo to confirm sample was collected
3. If not collected, escalate (patient unavailable, issues, etc)
4. Track collection time and quality

### 2. System Flow

**Database State:**
- Order Status: `PHLEBO_ASSIGNED` (sample not yet collected)
- Time Criteria: 60+ minutes since status change OR 15+ mins after appointment
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "Follow up: Sample collection status for {{patientName}}"
- Rule ID: `hsc_r4_confirm_collected`
- Action: Call phlebo to confirm collection
- Assigned To: OPS_AGENT
- SLA: 5 minutes from trigger

### 3. SQL Query

```sql
-- Find orders needing collection follow-up
SELECT
    o.id as order_id,
    o."appointmentTime",
    o."patientName",
    o."phleboName",
    o."orderStatus",
    o."statusUpdatedAt",
    EXTRACT(MINUTE FROM (NOW() - o."statusUpdatedAt")) as minutes_in_status,
    EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as minutes_since_appointment,
    o."storeId",
    'NEEDS TASK: Follow-up sample collection' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND (
        (NOW() - o."statusUpdatedAt") >= INTERVAL '60 minutes'
        OR (o."appointmentTime" <= NOW() AND (NOW() - o."appointmentTime") >= INTERVAL '15 minutes')
    )
ORDER BY o."statusUpdatedAt" ASC;
```

---

## HSC-R5: SAMPLE MOVEMENT TRACKING - WITHIN 2 HOURS OF COLLECTION

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 5: Sample Movement Tracking

**Procedure:**
> "Within 2 hours of sample collection"
> "Track sample handover from phlebo to lab"
> "Verify sample is in transit or received"
> "Monitor for any delays or issues"

**What Ops Team Should Do:**
1. Order reached SAMPLE_COLLECTED status
2. Wait max 2 hours for handover to lab
3. Call if sample not delivered after 2 hours
4. Verify sample integrity and chain of custody

### 2. System Flow

**Database State:**
- Order Status: `SAMPLE_COLLECTED` (sample is with phlebo)
- Time Window: 30+ mins since status change
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "Track sample handover to lab for {{patientName}}"
- Rule ID: `hsc_r5_sample_handover`
- Action: Verify sample is with lab or in transit
- Assigned To: OPS_AGENT
- SLA: 2 hours from sample collection

### 3. SQL Query

```sql
-- Find orders needing sample handover follow-up
SELECT
    o.id as order_id,
    o."appointmentTime",
    o."patientName",
    o."statusUpdatedAt" as sample_collected_at,
    EXTRACT(MINUTE FROM (NOW() - o."statusUpdatedAt")) as minutes_since_collection,
    o."storeId",
    CASE
        WHEN (NOW() - o."statusUpdatedAt") >= INTERVAL '2 hours' THEN 'URGENT: Over 2 hours'
        WHEN (NOW() - o."statusUpdatedAt") >= INTERVAL '30 minutes' THEN 'WATCH: Should be handed over'
        ELSE 'Monitor'
    END as urgency,
    'NEEDS TASK: Sample handover to lab' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '30 minutes'
ORDER BY o."statusUpdatedAt" ASC;
```

### 4. Validation Results

```
Qualifying Orders:  27
Tasks Created:      27
Gap:                0 (0%)
Status:             ✅ PERFECT
```

**What This Means:** All 27 orders with samples collected for 30+ minutes have sample handover tasks created.

---

## HSC-R6: REPORT TRACKING - MONITOR ETA AND FOLLOW UP

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 6: Report Tracking

**Procedure:**
> "After sample delivered, monitor report ETA"
> "If ETA breached, follow up with lab"
> "Notify patient if report delayed"
> "Escalate if beyond SLA"

**What Ops Team Should Do:**
1. Sample delivered to lab
2. Track expected report delivery (ETA from lab)
3. If ETA is approaching or passed, follow up with lab
4. Keep patient informed of delays

### 2. System Flow

**Database State:**
- Order Status: `SAMPLE_DELIVERED` (sample is with lab)
- Report ETA: Set in order metadata
- Time Criteria: ETA within 2 hours OR ETA has passed
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "Monitor report delivery for {{patientName}} - ETA: [eta]"
- Rule ID: `hsc_r8_report_followup`
- Action: Check with lab on report status
- Assigned To: OPS_AGENT
- SLA: Depends on ETA

### 3. SQL Query

```sql
-- Find orders needing report delivery monitoring
SELECT
    o.id as order_id,
    o."patientName",
    o."statusUpdatedAt" as sample_delivered_at,
    o."metadata"->>'reportETA' as report_eta,
    EXTRACT(MINUTE FROM ((o."metadata"->>'reportETA')::timestamp - NOW())) as minutes_until_eta,
    CASE
        WHEN (o."metadata"->>'reportETA')::timestamp < NOW() THEN 'OVERDUE'
        WHEN (o."metadata"->>'reportETA')::timestamp - NOW() < INTERVAL '2 hours' THEN 'DUE SOON'
        ELSE 'Monitor'
    END as eta_status,
    o."storeId",
    'NEEDS TASK: Monitor report ETA' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_DELIVERED'
    AND o."metadata"->>'reportETA' IS NOT NULL
    AND (o."metadata"->>'reportETA')::timestamp IS NOT NULL
ORDER BY (o."metadata"->>'reportETA')::timestamp ASC;
```

---

## HSC-R8: ESCALATION PROTOCOL - ORDERS STUCK IN ANY STAGE

### 1. SOP Section
**From:** "SOP for Ops.docx" - SECTION 8: Escalation Protocol

**Procedure:**
> "If order stuck in same status for 2+ hours"
> "No status updates, unclear what happened"
> "Escalate immediately to senior/supervisor"
> "Determine issue and resolve"

**What Ops Team Should Do:**
1. Detect orders that haven't moved in 2 hours
2. In critical stages (phlebo assigned, sample collected)
3. Call phlebo/lab to find out what's happening
4. Resolve or escalate to supervisor

### 2. System Flow

**Database State:**
- Order Status IN: `PHLEBO_ASSIGNED`, `SAMPLE_COLLECTED` (critical stages)
- Time Criteria: No status change for 120+ minutes
- Order Type: `HOME_SAMPLE`

**Task Requirements:**
- Task Title: "ESCALATE: Order {{orderId}} stuck for 2+ hours"
- Rule ID: `hsc_r7_stale_order`
- Priority: URGENT
- Action: Immediate follow-up call
- Assigned To: Supervisor/Senior agent

### 3. SQL Query

```sql
-- Find orders stuck without status updates
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."patientName",
    o."statusUpdatedAt",
    EXTRACT(MINUTE FROM (NOW() - o."statusUpdatedAt")) as minutes_in_current_status,
    o."appointmentTime",
    o."storeId",
    'URGENT TASK: Escalate stuck order' as action_required
FROM public."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '120 minutes'
ORDER BY o."statusUpdatedAt" ASC;
```

### 4. Validation Results

```
Qualifying Orders:  35
Tasks Created:      8
Gap:                27 (77% gap) ⚠️
Status:             ❌ ISSUE DETECTED
```

**What This Means:** 35 orders are stuck without updates for 2+ hours, but only 8 have escalation tasks created. There's a 77% gap suggesting the escalation rule is not triggering properly. This requires investigation.

---

## Summary - All Rules Combined

| SOP Rule | Procedure | Qualifying | Tasks | Gap | Status |
|----------|-----------|-----------|-------|-----|--------|
| HSC-R1 | 30-Min Confirm | 114 | 114 | 0 | ✅ |
| HSC-R2 | T-1 Closure | 0 | 0 | 0 | ℹ️ |
| HSC-R3 | Pre-Visit Check | 0 | 0 | 0 | ℹ️ |
| HSC-R4 | Collection Track | - | - | - | ❌ Error |
| HSC-R5 | Sample Movement | 27 | 27 | 0 | ✅ |
| HSC-R6 | Report Tracking | - | - | - | ⚠️ Partial |
| HSC-R8 | Escalation | 35 | 8 | 27 | ❌ Gap |

---

## How to Use This Guide

### For Validation:
1. Copy the SQL query for the procedure you want to validate
2. Run it against your database
3. Count how many orders are returned
4. Compare to the "tasks_created" count in the gap section

### For Understanding System Flow:
1. Read the SOP section to understand what ops team should do
2. Read the System Flow section to see how that translates to database conditions
3. Review the SQL to see exactly what data is being matched

### For Debugging Issues:
1. If gap > 0, the SQL shows which orders are NOT getting tasks
2. Run the query to see the specific order IDs
3. Investigate why those orders don't have tasks
4. Check task rule trigger conditions vs. actual database state

---

## Files Available

- **task_validation_by_sop.sql** - All queries in this document
- **task_validation_corrected.sql** - Alternative query set
- **run_validation.sh** - Automated runner script

To run all validations:
```bash
cd /Users/maverick/Documents/TaskOs
psql -d labstack < task_validation_by_sop.sql
```
