-- ============================================================================
-- TASK CREATION VALIDATION - SOP-ALIGNED QUERIES (CORRECTED)
-- ============================================================================
-- Each section: SOP → System Flow → SQL Query
-- Uses actual Order table columns (no patientName - use userId reference)
-- ============================================================================

-- ============================================================================
-- HSC-R1: LIVE ORDER MONITORING - 30-MIN CONFIRMATION
-- ============================================================================
-- SOP: Every order that comes in should be confirmed within 30 minutes
-- Flow: ORDER_SCHEDULED + 30 mins old
--
-- Find orders requiring HSC-R1 Confirmation Task:
SELECT
    'HSC-R1: 30-Min Confirm' as rule_name,
    o.id as order_id,
    o."createdAt" as order_created_at,
    EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as minutes_old,
    u.name as patient_name,
    o."appointmentTime",
    o."storeId",
    'NEEDS TASK: Confirm booking' as action_required
FROM public."Order" o
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
ORDER BY o."createdAt" DESC
LIMIT 10;

-- ============================================================================
-- HSC-R2: T-1 PREVIOUS DAY CLOSURE
-- ============================================================================
-- SOP: Confirm all next-day orders at end of shift
-- Flow: Appointment = tomorrow + (ORDER_SCHEDULED OR PHLEBO_ASSIGNED)
--
-- Find T-1 orders needing confirmation:
SELECT
    'HSC-R2: T-1 Confirm' as rule_name,
    o.id as order_id,
    o."appointmentTime",
    u.name as patient_name,
    o."orderStatus",
    (o."appointmentTime"::date - CURRENT_DATE) as days_until_appointment,
    o."storeId",
    'NEEDS TASK: T-1 confirm for tomorrow' as action_required
FROM public."Order" o
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."appointmentTime"::date = CURRENT_DATE + INTERVAL '1 day'
    AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')
ORDER BY o."appointmentTime" ASC
LIMIT 10;

-- ============================================================================
-- HSC-R3: PRE-VISIT TRACKING - 30-20 MINS BEFORE APPOINTMENT
-- ============================================================================
-- SOP: 30-20 mins before appointment, verify phlebo is en route
-- Flow: PHLEBO_ASSIGNED + within 30 mins of appointment
--
-- Find orders needing pre-visit verification:
SELECT
    'HSC-R3: Pre-Visit Check' as rule_name,
    o.id as order_id,
    o."appointmentTime",
    u.name as patient_name,
    o."phleboName",
    o."phleboNumber",
    EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as minutes_until_appointment,
    o."storeId",
    'NEEDS TASK: Pre-visit phlebo dispatch check' as action_required
FROM public."Order" o
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
ORDER BY o."appointmentTime" ASC
LIMIT 10;

-- ============================================================================
-- HSC-R4: COLLECTION TRACKING - SAMPLE COLLECTION FOLLOW-UP
-- ============================================================================
-- SOP: 60+ mins after phlebo starts, if sample not collected yet, follow up
-- Flow: PHLEBO_ASSIGNED + 60 mins since status change
--
-- Find orders needing collection follow-up:
SELECT
    'HSC-R4: Collection Track' as rule_name,
    o.id as order_id,
    o."appointmentTime",
    u.name as patient_name,
    o."phleboName",
    o."orderStatus",
    o."statusUpdatedAt",
    EXTRACT(MINUTE FROM (NOW() - o."statusUpdatedAt")) as minutes_in_status,
    EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as minutes_since_appointment,
    o."storeId",
    'NEEDS TASK: Follow-up sample collection' as action_required
FROM public."Order" o
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '60 minutes'
ORDER BY o."statusUpdatedAt" ASC
LIMIT 10;

-- ============================================================================
-- HSC-R5: SAMPLE MOVEMENT TRACKING - WITHIN 2 HOURS OF COLLECTION
-- ============================================================================
-- SOP: Within 2 hours of sample collection, track handover to lab
-- Flow: SAMPLE_COLLECTED + 30 mins since status change
--
-- Find orders needing sample handover follow-up:
SELECT
    'HSC-R5: Sample Movement' as rule_name,
    o.id as order_id,
    o."appointmentTime",
    u.name as patient_name,
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
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '30 minutes'
ORDER BY o."statusUpdatedAt" ASC
LIMIT 10;

-- ============================================================================
-- HSC-R6: REPORT TRACKING - MONITOR ETA AND FOLLOW UP
-- ============================================================================
-- SOP: After sample delivered, monitor report ETA
-- Flow: SAMPLE_DELIVERED + metadata.reportETA exists
--
-- Find orders needing report delivery monitoring:
SELECT
    'HSC-R6: Report Tracking' as rule_name,
    o.id as order_id,
    u.name as patient_name,
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
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_DELIVERED'
    AND o."metadata"->>'reportETA' IS NOT NULL
    AND (o."metadata"->>'reportETA')::timestamp IS NOT NULL
ORDER BY (o."metadata"->>'reportETA')::timestamp ASC
LIMIT 10;

-- ============================================================================
-- HSC-R8: ESCALATION PROTOCOL - ORDERS STUCK IN ANY STAGE
-- ============================================================================
-- SOP: If order stuck in same status for 2+ hours, escalate immediately
-- Flow: PHLEBO_ASSIGNED OR SAMPLE_COLLECTED + 120 mins since status change
--
-- Find orders stuck without status updates:
SELECT
    'HSC-R8: Escalation' as rule_name,
    o.id as order_id,
    o."orderStatus" as current_status,
    u.name as patient_name,
    o."statusUpdatedAt",
    EXTRACT(MINUTE FROM (NOW() - o."statusUpdatedAt")) as minutes_in_current_status,
    o."appointmentTime",
    o."storeId",
    'URGENT TASK: Escalate stuck order' as action_required
FROM public."Order" o
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '120 minutes'
ORDER BY o."statusUpdatedAt" ASC
LIMIT 10;

-- ============================================================================
-- SUMMARY: ALL RULES - GAP ANALYSIS
-- ============================================================================
-- Compare qualifying orders vs actual tasks created

SELECT
    'HSC-R1: 30-Min Confirm' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    'HSC-R3: Pre-Visit Check' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    'HSC-R4: Collection Track' as rule_name,
    COUNT(DISTINCT o.id) as qualifying_orders,
    COUNT(DISTINCT t.id) as tasks_created,
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
    COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id) as gap,
    ROUND(
        (COUNT(DISTINCT o.id) - COUNT(DISTINCT t.id)) * 100.0 /
        NULLIF(COUNT(DISTINCT o.id), 0), 1
    ) as gap_percentage
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
