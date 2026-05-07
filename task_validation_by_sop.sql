-- ============================================================================
-- TASK CREATION VALIDATION - STRUCTURED BY SOP FLOWS
-- ============================================================================
-- Each section shows:
-- 1. SOP Section - What the operational procedure requires
-- 2. System Flow - How it translates to database state
-- 3. Query - SQL to find orders matching this flow
-- ============================================================================

-- ============================================================================
-- HOME SAMPLE COLLECTION (HSC) PROCEDURES
-- ============================================================================

-- ============================================================================
-- HSC-R1: LIVE ORDER MONITORING - 30-MIN CONFIRMATION
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 1: Live Order Monitoring
-- "Every order that comes in should be confirmed within 30 minutes"
-- "If not confirmed, escalate to senior"
--
-- What ops team should do:
-- 1. New order created → ORDER_SCHEDULED status
-- 2. Call patient within 30 mins to confirm appointment
-- 3. If unreachable, reschedule or escalate

-- System Flow:
-- Trigger Condition:
--   - Order Status IN ('ORDER_SCHEDULED')
--   - Time Since Created >= 30 minutes
-- Expected Task Action:
--   - Task Title: "Confirm {{patientName}} appointment within 30 mins"
--   - Assigned to: OPS_AGENT with communication skills
--   - SLA: 30 minutes from order creation

-- SQL: Find orders requiring HSC-R1 Confirmation Task
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

-- ============================================================================
-- HSC-R2: T-1 PREVIOUS DAY CLOSURE
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 2: T-1 Previous Day Closure
-- "End of day (before shift closes), confirm all next-day orders"
-- "Check phlebo availability for tomorrow"
-- "Identify and resolve any issues before day starts"
--
-- What ops team should do:
-- 1. Every order scheduled for tomorrow
-- 2. Confirm patient is still available
-- 3. Ensure phlebo is assigned
-- 4. Resolve any conflicts before end of shift

-- System Flow:
-- Trigger Condition:
--   - Appointment Time = Tomorrow (between today midnight and tomorrow midnight)
--   - Order Status IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')
--   - Should trigger near end of shift (implement as manual/scheduled)
-- Expected Task Action:
--   - Task Title: "T-1 Confirm {{patientName}} appointment for tomorrow"
--   - Priority: HIGH (must complete before shift ends)
--   - Assigned to: Shift supervisor

-- SQL: Find T-1 orders needing confirmation
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

-- ============================================================================
-- HSC-R3: PRE-VISIT TRACKING - 30-20 MINS BEFORE APPOINTMENT
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 3: Pre-Visit Tracking
-- "30-20 minutes before appointment"
-- "Verify phlebo has reached patient location (call phlebo)"
-- "Confirm patient is ready"
-- "Update appointment status if needed"
--
-- What ops team should do:
-- 1. 30 mins before scheduled appointment
-- 2. Call phlebo to confirm they're en route
-- 3. Call patient to confirm they're ready
-- 4. Resolve any last-minute issues

-- System Flow:
-- Trigger Condition:
--   - Order Status = PHLEBO_ASSIGNED (phlebo already assigned)
--   - Time = Within 30 mins before appointment (30 mins window)
--   - Appointment is approaching
-- Expected Task Action:
--   - Task Title: "Pre-visit check {{patientName}} - phlebo dispatch"
--   - Action: Call phlebo + verify patient
--   - Assigned to: OPS_AGENT

-- SQL: Find orders needing pre-visit verification
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

-- ============================================================================
-- HSC-R4: COLLECTION TRACKING - TRACK SAMPLE COLLECTION
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 4: Collection Tracking
-- "60+ minutes after phlebo starts (or 15 mins after appointment)"
-- "If sample not collected yet, follow up"
-- "Verify collection completion and condition"
-- "Ensure sample is with phlebo or in transit"
--
-- What ops team should do:
-- 1. Check order status - still PHLEBO_ASSIGNED and not yet SAMPLE_COLLECTED?
-- 2. Call phlebo to confirm sample was collected
-- 3. If not collected, escalate (patient unavailable, issues, etc)
-- 4. Track collection time and quality

-- System Flow:
-- Trigger Condition:
--   - Order Status = PHLEBO_ASSIGNED (still no sample collected)
--   - Time Since Status Change >= 60 minutes (phlebo is taking too long)
--   - OR Time Since Appointment >= 15 minutes (appointment time passed, no collection)
-- Expected Task Action:
--   - Task Title: "Follow up: Sample collection status for {{patientName}}"
--   - Action: Call phlebo to confirm collection
--   - Assigned to: OPS_AGENT
--   - SLA: 5 minutes from trigger

-- SQL: Find orders needing collection follow-up
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

-- ============================================================================
-- HSC-R5: SAMPLE MOVEMENT TRACKING - WITHIN 2 HOURS OF COLLECTION
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 5: Sample Movement Tracking
-- "Within 2 hours of sample collection"
-- "Track sample handover from phlebo to lab"
-- "Verify sample is in transit or received"
-- "Monitor for any delays or issues"
--
-- What ops team should do:
-- 1. Order reached SAMPLE_COLLECTED status
-- 2. Wait max 2 hours for handover to lab
-- 3. Call if sample not delivered after 2 hours
-- 4. Verify sample integrity and chain of custody

-- System Flow:
-- Trigger Condition:
--   - Order Status = SAMPLE_COLLECTED (sample is with phlebo)
--   - Time Since Status Change >= 30 minutes (should be handover soon)
--   - Time Since Status Change >= 2 hours (escalate - too long)
-- Expected Task Action:
--   - Task Title: "Track sample handover to lab for {{patientName}}"
--   - Action: Verify sample is with lab or in transit
--   - Assigned to: OPS_AGENT
--   - SLA: 2 hours from sample collection

-- SQL: Find orders needing sample handover follow-up
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

-- ============================================================================
-- HSC-R6: REPORT TRACKING - MONITOR ETA AND FOLLOW UP
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 6: Report Tracking
-- "After sample delivered, monitor report ETA"
-- "If ETA breached, follow up with lab"
-- "Notify patient if report delayed"
-- "Escalate if beyond SLA"
--
-- What ops team should do:
-- 1. Sample delivered to lab
-- 2. Track expected report delivery (ETA from lab)
-- 3. If ETA is approaching or passed, follow up with lab
-- 4. Keep patient informed of delays

-- System Flow:
-- Trigger Condition:
--   - Order Status = SAMPLE_DELIVERED (sample is with lab)
--   - Report ETA is set in metadata
--   - Time Until ETA <= 2 hours OR ETA has passed
-- Expected Task Action:
--   - Task Title: "Monitor report delivery for {{patientName}} - ETA: [eta]"
--   - Action: Check with lab on report status
--   - Assigned to: OPS_AGENT
--   - SLA: Depends on ETA

-- SQL: Find orders needing report delivery monitoring
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

-- ============================================================================
-- HSC-R8: ESCALATION PROTOCOL - ORDERS STUCK IN ANY STAGE
-- ============================================================================
-- SOP Context:
-- From "SOP for Ops.docx" - SECTION 8: Escalation Protocol
-- "If order stuck in same status for 2+ hours"
-- "No status updates, unclear what happened"
-- "Escalate immediately to senior/supervisor"
-- "Determine issue and resolve"
--
-- What ops team should do:
-- 1. Detect orders that haven't moved in 2 hours
-- 2. In critical stages (phlebo assigned, sample collected)
-- 3. Call phlebo/lab to find out what's happening
-- 4. Resolve or escalate to supervisor

-- System Flow:
-- Trigger Condition:
--   - Order Status IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
--   - No Status Change for >= 2 hours
--   - Time-sensitive operations that shouldn't stall
-- Expected Task Action:
--   - Task Title: "ESCALATE: Order {{orderId}} stuck for 2+ hours"
--   - Priority: URGENT
--   - Action: Immediate follow-up call
--   - Assigned to: Supervisor/Senior agent

-- SQL: Find orders stuck without status updates
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

-- ============================================================================
-- SUMMARY: ALL ORDERS NEEDING TASKS BY RULE
-- ============================================================================
-- This query shows the complete picture:
-- For each rule, count qualifying orders and compare to actual tasks created

SELECT
    'HSC-R1: 30-Min Confirm' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r1_confirm_booking'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'

UNION ALL

SELECT
    'HSC-R2: T-1 Confirm' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r2_assign_phlebo'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."appointmentTime"::date = CURRENT_DATE + INTERVAL '1 day'
    AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')

UNION ALL

SELECT
    'HSC-R3: Pre-Visit Phlebo' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r3_phlebo_dispatch'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'

UNION ALL

SELECT
    'HSC-R4: Collection Tracking' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r4_confirm_collected'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '60 minutes'

UNION ALL

SELECT
    'HSC-R5: Sample Movement' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r5_sample_handover'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '30 minutes'

UNION ALL

SELECT
    'HSC-R6: Report Tracking' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r8_report_followup'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_DELIVERED'
    AND o."metadata"->>'reportETA' IS NOT NULL

UNION ALL

SELECT
    'HSC-R8: Escalation' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."taskRuleId" = 'hsc_r7_stale_order'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '120 minutes'

ORDER BY rule_name;
