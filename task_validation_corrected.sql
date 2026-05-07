-- ============================================================================
-- TASK CREATION VALIDATION - CORRECTED SQL
-- ============================================================================
-- This script validates task creation against actual SOP rules in the database
-- and identifies gaps between orders that SHOULD have tasks vs those that DO
-- ============================================================================

-- ============================================================================
-- PART 1: Review Active Task Rules and Their Trigger Conditions
-- ============================================================================

SELECT
    r.id as rule_id,
    r.name as rule_name,
    r."orderType",
    r."isActive",
    r."triggerCondition"->>'statusIn' as trigger_status_list,
    r."triggerCondition"->>'minutesSinceCreated' as minutes_since_created,
    r."triggerCondition"->>'minutesSinceStatusUpdated' as minutes_since_status_updated,
    r."triggerCondition"->>'minutesBeforeAppointment' as minutes_before_appt,
    r."triggerCondition"->>'minutesAfterAppointment' as minutes_after_appt
FROM taskos.task_rules r
WHERE r."isActive" = true
ORDER BY r."orderType", r.name;

-- ============================================================================
-- PART 2: For Each Rule - Find Qualifying Orders
-- ============================================================================

-- First, let's create a helper query structure. For HOME_SAMPLE rules:

-- HSC-R1: hsc_r1_confirm_booking
-- Rule: ORDER_SCHEDULED, 30 mins since created
SELECT
    'hsc_r1_confirm_booking' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r1_confirm_booking'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes';

-- HSC-R2: hsc_r2_assign_phlebo
-- Rule: ORDER_SCHEDULED or PHLEBO_ASSIGNED, no time constraint (0 mins)
SELECT
    'hsc_r2_assign_phlebo' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r2_assign_phlebo'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED');

-- HSC-R3: hsc_r3_phlebo_dispatch
-- Rule: PHLEBO_ASSIGNED, 30 mins before appointment
SELECT
    'hsc_r3_phlebo_dispatch' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r3_phlebo_dispatch'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes';

-- HSC-R4: hsc_r4_confirm_collected
-- Rule: PHLEBO_ASSIGNED or PHLEBO_DISPATCHED, 15 mins after appointment
SELECT
    'hsc_r4_confirm_collected' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r4_confirm_collected'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND o."appointmentTime" <= NOW()
    AND (NOW() - o."appointmentTime") >= INTERVAL '15 minutes';

-- HSC-R5: hsc_r5_sample_handover
-- Rule: SAMPLE_COLLECTED, 30 mins since status update
SELECT
    'hsc_r5_sample_handover' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r5_sample_handover'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '30 minutes';

-- HSC-R6: hsc_r6_patient_missed
-- Rule: PHLEBO_ASSIGNED or PHLEBO_DISPATCHED, 45 mins after appointment
SELECT
    'hsc_r6_patient_missed' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r6_patient_missed'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND o."appointmentTime" <= NOW()
    AND (NOW() - o."appointmentTime") >= INTERVAL '45 minutes';

-- HSC-R7: hsc_r7_stale_order
-- Rule: BOOKED, CONFIRMED, PHLEBO_ASSIGNED, PHLEBO_DISPATCHED - 120 mins since status update
-- NOTE: Database has different status values, so this may not match
SELECT
    'hsc_r7_stale_order' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r7_stale_order'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '120 minutes';

-- HSC-R8: hsc_r8_report_followup
-- Rule: SAMPLE_COLLECTED or SAMPLE_RECEIVED, 240 mins since status update
SELECT
    'hsc_r8_report_followup' as rule_id,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_existing_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."taskRuleId" = 'hsc_r8_report_followup'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" IN ('SAMPLE_COLLECTED', 'SAMPLE_PROCESSED')
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '240 minutes';

-- ============================================================================
-- PART 3: Overall Gap Summary
-- ============================================================================

SELECT
    r.id as rule_id,
    r.name as rule_name,
    r."orderType",
    (
        SELECT COUNT(*)
        FROM public."Order" o
        WHERE o."orderType" = r."orderType"
            AND o."orderStatus" IN (
                SELECT jsonb_array_elements(r."triggerCondition"->'statusIn')::text
            )
    ) as orders_matching_status,
    (
        SELECT COUNT(*)
        FROM public."Order" o
        INNER JOIN taskos.tasks t ON t."entityId" = o.id AND t."taskRuleId" = r.id
        WHERE o."orderType" = r."orderType"
            AND o."orderStatus" IN (
                SELECT jsonb_array_elements(r."triggerCondition"->'statusIn')::text
            )
            AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
    ) as orders_with_tasks,
    (
        SELECT COUNT(*)
        FROM public."Order" o
        LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."taskRuleId" = r.id
        WHERE o."orderType" = r."orderType"
            AND o."orderStatus" IN (
                SELECT jsonb_array_elements(r."triggerCondition"->'statusIn')::text
            )
            AND t.id IS NULL
    ) as gap_count
FROM taskos.task_rules r
WHERE r."isActive" = true
ORDER BY r."orderType", r.name;

-- ============================================================================
-- PART 4: Completed Orders with Open Tasks (The Original User Concern)
-- ============================================================================

SELECT
    o.id as order_id,
    o."orderType",
    o."orderStatus",
    COUNT(t.id) as open_task_count,
    STRING_AGG(DISTINCT t."title", '; ') as task_titles,
    STRING_AGG(DISTINCT t."taskRuleId", ', ') as rule_ids,
    MAX(t."createdAt") as oldest_task_created
FROM public."Order" o
LEFT JOIN taskos.tasks t ON
    t."entityId" = o.id
    AND t."entityType" = 'ORDER'
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE o."orderStatus" IN ('REPORT_DELIVERED')
GROUP BY o.id, o."orderType", o."orderStatus"
HAVING COUNT(t.id) > 0
ORDER BY MAX(t."createdAt") DESC;

-- ============================================================================
-- PART 5: Order Status Distribution
-- ============================================================================

SELECT
    "orderType",
    "orderStatus",
    COUNT(*) as order_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY "orderType"), 2) as percentage_of_type
FROM public."Order"
GROUP BY "orderType", "orderStatus"
ORDER BY "orderType", order_count DESC;

-- ============================================================================
-- PART 6: Task Statistics by Rule
-- ============================================================================

SELECT
    "taskRuleId" as rule_id,
    COUNT(*) as total_tasks,
    COUNT(CASE WHEN "status" = 'CREATED' THEN 1 END) as created,
    COUNT(CASE WHEN "status" = 'ASSIGNED' THEN 1 END) as assigned,
    COUNT(CASE WHEN "status" = 'IN_PROGRESS' THEN 1 END) as in_progress,
    COUNT(CASE WHEN "status" = 'COMPLETED' THEN 1 END) as completed,
    COUNT(CASE WHEN "status" = 'CANCELLED' THEN 1 END) as cancelled,
    COUNT(CASE WHEN "status" NOT IN ('COMPLETED', 'CANCELLED') THEN 1 END) as open_tasks
FROM taskos.tasks
GROUP BY "taskRuleId"
ORDER BY open_tasks DESC;

-- ============================================================================
-- PART 7: Poller Health Check
-- ============================================================================

SELECT
    "startedAt",
    "ordersFound",
    "tasksCreated",
    "status",
    COALESCE("durationMs", 0) as duration_ms,
    CASE WHEN "errorMessage" IS NOT NULL THEN 'ERROR: ' || SUBSTR("errorMessage", 1, 80) ELSE 'SUCCESS' END as status_detail
FROM taskos.polling_logs
ORDER BY "startedAt" DESC
LIMIT 20;
