-- ============================================================================
-- TASK CREATION VALIDATION SUITE
-- Analyzes which orders SHOULD have tasks created based on SOP procedures
-- ============================================================================

-- ============================================================================
-- PART 1: HOME SAMPLE COLLECTION (HSC) PROCEDURES
-- ============================================================================

-- ============================================================================
-- HSC-R1: 30-MINUTE CONFIRMATION (Rule 1: Critical SLA)
-- Trigger: Every new/pending order created
-- Expected Task: "Confirm booking within 30 mins"
-- Status Window: ORDER_SCHEDULED (order just created, not yet confirmed)
-- Age Window: >= 30 mins since creation
-- ============================================================================

-- 1.1: Orders that SHOULD have "HSC-R1: Confirm Booking" task
-- These are orders in ORDER_SCHEDULED status that haven't been confirmed within 30 mins
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."createdAt" as order_created_at,
    EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
    o."appointmentTime",
    o."patientName",
    'SHOULD CREATE: HSC-R1 Confirm Booking Task' as task_required,
    o."orderType"
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
    AND o."deletedAt" IS NULL
ORDER BY
    o."createdAt" DESC
LIMIT 20;

-- ============================================================================
-- HSC-R2: T-1 CONFIRMATION (Previous Day Closure)
-- Trigger: End of shift for orders scheduled tomorrow
-- Expected Task: "Confirm T-1 orders before shift end"
-- Status Window: ORDER_SCHEDULED or PHLEBO_ASSIGNED
-- Timing: All orders with appointmentTime = tomorrow (between today midnight+1 and tomorrow midnight)
-- ============================================================================

-- 1.2: Orders that SHOULD have "HSC-R2: T-1 Confirmation" task
-- These are orders for tomorrow that need T-1 confirmation
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as scheduled_appointment,
    o."createdAt",
    o."patientName",
    'SHOULD CREATE: HSC-R2 T-1 Confirmation Task' as task_required,
    (o."appointmentTime"::date - CURRENT_DATE) as days_until_appointment
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."appointmentTime"::date = CURRENT_DATE + INTERVAL '1 day'
    AND o."orderStatus" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED')
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- HSC-R3: PRE-VISIT TRACKING (30-20 mins before appointment)
-- Trigger: 30-20 mins before appointment time
-- Expected Status: PHLEBO_ASSIGNED (phlebo should be assigned by now)
-- Expected Task: "Verify phlebo assignment before visit"
-- ============================================================================

-- 1.3: Orders that SHOULD have "HSC-R3: Pre-Visit Tracking" task
-- Orders within 30-20 mins before appointment that don't have phlebo assigned
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as appointment,
    EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
    o."patientName",
    'SHOULD CREATE: HSC-R3 Pre-Visit Tracking Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
    AND o."orderStatus" NOT IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED', 'SAMPLE_DELIVERED', 'REPORT_DELIVERED')
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- HSC-R4: COLLECTION TRACKING (After Phlebo Starts)
-- Trigger: Status = PHLEBO_ASSIGNED AND 60+ mins have passed
-- Expected Task: "Track sample collection"
-- Status Window: PHLEBO_ASSIGNED (not yet collected)
-- Age Window: >= 60 mins since phlebo assigned
-- ============================================================================

-- 1.4: Orders that SHOULD have "HSC-R4: Collection Tracking" task
-- Orders where phlebo started but collection hasn't been updated in 60 mins
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime",
    oh."createdAt" as phlebo_assigned_at,
    EXTRACT(MINUTE FROM (NOW() - oh."createdAt")) as mins_since_phlebo_assignment,
    o."patientName",
    'SHOULD CREATE: HSC-R4 Collection Tracking Task' as task_required
FROM
    source_schema."Order" o
LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId" AND oh."status" = 'PHLEBO_ASSIGNED'
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND (NOW() - oh."createdAt") >= INTERVAL '60 minutes'
    AND o."deletedAt" IS NULL
ORDER BY
    oh."createdAt" ASC
LIMIT 20;

-- ============================================================================
-- HSC-R5: SAMPLE MOVEMENT TRACKING (Within 2 hours of collection)
-- Trigger: Status = SAMPLE_COLLECTED AND NOT SAMPLE_DELIVERED
-- Expected Task: "Track sample delivery within 2 hours"
-- Status Window: SAMPLE_COLLECTED (collected but not delivered)
-- Age Window: >= 2 hours since collection
-- ============================================================================

-- 1.5: Orders that SHOULD have "HSC-R5: Sample Movement" task
-- Samples collected but not delivered within 2 hours
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    oh."createdAt" as sample_collected_at,
    EXTRACT(MINUTE FROM (NOW() - oh."createdAt")) as mins_since_collection,
    o."patientName",
    'SHOULD CREATE: HSC-R5 Sample Movement Task' as task_required
FROM
    source_schema."Order" o
LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId" AND oh."status" = 'SAMPLE_COLLECTED'
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - oh."createdAt") >= INTERVAL '2 hours'
    AND o."deletedAt" IS NULL
ORDER BY
    oh."createdAt" ASC
LIMIT 20;

-- ============================================================================
-- HSC-R6: REPORT TRACKING (ETA Monitoring & Follow-up)
-- Trigger: Status = SAMPLE_DELIVERED AND ETA provided
-- Expected Task: "Monitor report delivery"
-- Status Window: SAMPLE_DELIVERED (sample delivered, waiting for report)
-- Age Window: >= 2 hours or ETA breached
-- ============================================================================

-- 1.6: Orders that SHOULD have "HSC-R6: Report Tracking" task
-- Orders with samples delivered, waiting for reports
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."metadata"->>'reportETA' as report_eta,
    EXTRACT(MINUTE FROM (NOW() - (o."metadata"->>'sampleDeliveredAt')::timestamp)) as mins_since_delivery,
    o."patientName",
    CASE
        WHEN (o."metadata"->>'reportETA')::timestamp < NOW() THEN 'OVERDUE'
        ELSE 'PENDING'
    END as eta_status,
    'SHOULD CREATE: HSC-R6 Report Tracking Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'SAMPLE_DELIVERED'
    AND o."deletedAt" IS NULL
    AND o."metadata"->>'reportETA' IS NOT NULL
ORDER BY
    (o."metadata"->>'reportETA')::timestamp ASC
LIMIT 20;

-- ============================================================================
-- HSC-R8: ESCALATION MONITORING (Orders stuck in any stage)
-- Trigger: Orders unchanged for > 2 hours in mid-flow statuses
-- Expected Task: "Escalate stuck order"
-- Status Window: PHLEBO_ASSIGNED or SAMPLE_COLLECTED (mid-flow states)
-- Age Window: >= 2 hours without status change
-- ============================================================================

-- 1.7: Orders that SHOULD have "HSC-R8: Escalation" task
-- Orders stuck without status updates for 2+ hours
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    MAX(oh."createdAt") as last_status_update,
    EXTRACT(MINUTE FROM (NOW() - MAX(oh."createdAt"))) as mins_since_last_update,
    o."patientName",
    'SHOULD CREATE: HSC-R8 Escalation Task' as task_required
FROM
    source_schema."Order" o
LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId"
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" IN ('PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED')
    AND o."deletedAt" IS NULL
GROUP BY
    o.id, o."orderStatus", o."patientName"
HAVING
    (NOW() - MAX(oh."createdAt")) >= INTERVAL '2 hours'
ORDER BY
    MAX(oh."createdAt") ASC
LIMIT 20;

-- ============================================================================
-- PART 2: CENTRE VISIT (CV) PROCEDURES
-- ============================================================================

-- ============================================================================
-- CV-R1: 30-MINUTE CONFIRMATION (Same as HSC-R1, but for centre visits)
-- ============================================================================

-- 2.1: Orders that SHOULD have "CV-R1: Confirm Centre Appointment" task
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."createdAt" as order_created_at,
    EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
    o."appointmentTime",
    o."patientName",
    'SHOULD CREATE: CV-R1 Confirm Appointment Task' as task_required,
    o."orderType"
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'CENTRE_VISIT'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
    AND o."deletedAt" IS NULL
ORDER BY
    o."createdAt" DESC
LIMIT 20;

-- ============================================================================
-- CV-R3: DAY OF APPOINTMENT CHECK (T-2 hours before)
-- Trigger: 2 hours before appointment
-- Expected Task: "Verify centre readiness before appointment"
-- ============================================================================

-- 2.2: Orders that SHOULD have "CV-R3: Pre-Appointment Check" task
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as appointment,
    EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
    o."patientName",
    'SHOULD CREATE: CV-R3 Pre-Appointment Check Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'CENTRE_VISIT'
    AND o."appointmentTime" BETWEEN NOW() + INTERVAL '120 minutes' AND NOW() + INTERVAL '150 minutes'
    AND o."orderStatus" NOT IN ('REPORT_DELIVERED', 'COMPLETED', 'CANCELLED')
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- CV-R4: POST-APPOINTMENT CHECK (T+1 hour after)
-- Trigger: 1 hour after appointment time
-- Expected Task: "Verify appointment completion"
-- ============================================================================

-- 2.3: Orders that SHOULD have "CV-R4: Post-Appointment Check" task
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as appointment,
    EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as mins_after_appointment,
    o."patientName",
    'SHOULD CREATE: CV-R4 Post-Appointment Verification Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'CENTRE_VISIT'
    AND o."appointmentTime" BETWEEN NOW() - INTERVAL '90 minutes' AND NOW() - INTERVAL '60 minutes'
    AND o."orderStatus" NOT IN ('REPORT_DELIVERED', 'COMPLETED', 'CANCELLED')
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- PART 3: INJECTION ADMINISTRATION (IA) PROCEDURES
-- ============================================================================

-- ============================================================================
-- IA-R1: MEDIC ASSIGNMENT & VALIDATION (T+30 mins SLA)
-- Trigger: New injection order created
-- Expected Task: "Assign and brief medic"
-- Status Window: ORDER_SCHEDULED (not yet assigned)
-- Age Window: >= 30 mins since creation
-- ============================================================================

-- 3.1: Orders that SHOULD have "IA-R1: Assign Medic" task
-- Injection orders unassigned for 30+ mins
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."createdAt" as order_created_at,
    EXTRACT(MINUTE FROM (NOW() - o."createdAt")) as mins_since_creation,
    o."appointmentTime",
    o."patientName",
    o."metadata"->>'injectionName' as injection_name,
    'SHOULD CREATE: IA-R1 Assign Medic Task' as task_required,
    o."orderType"
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'INJECTION_AT_HOME'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
    AND o."deletedAt" IS NULL
ORDER BY
    o."createdAt" DESC
LIMIT 20;

-- ============================================================================
-- IA-R2: PRE-VISIT CONFIRMATION (60-30 mins before)
-- Trigger: 60-30 mins before appointment
-- Expected Status: MEDIC_ASSIGNED (medic should be assigned and confirmed)
-- Expected Task: "Confirm medic availability before visit"
-- ============================================================================

-- 3.2: Orders that SHOULD have "IA-R2: Pre-Visit Medic Confirmation" task
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as appointment,
    EXTRACT(MINUTE FROM (o."appointmentTime" - NOW())) as mins_until_appointment,
    o."patientName",
    o."metadata"->>'injectionName' as injection_name,
    'SHOULD CREATE: IA-R2 Pre-Visit Confirmation Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'INJECTION_AT_HOME'
    AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '60 minutes'
    AND o."orderStatus" NOT IN ('MEDIC_REACHED', 'INJECTION_ADMINISTERED', 'COMPLETED', 'CANCELLED')
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- IA-R3: MEDIC ARRIVAL & TRACKING
-- Trigger: 30 mins before appointment until medic reached
-- Expected Task: "Track medic arrival and injection administration"
-- Status Window: MEDIC_ASSIGNED (assigned but not yet started/reached)
-- Age Window: If still MEDIC_ASSIGNED after appointment time
-- ============================================================================

-- 3.3: Orders that SHOULD have "IA-R3: Track Medic Arrival" task
-- Medic assigned but hasn't reached by appointment time
SELECT
    o.id as order_id,
    o."orderStatus" as current_status,
    o."appointmentTime" as appointment,
    EXTRACT(MINUTE FROM (NOW() - o."appointmentTime")) as mins_after_appointment,
    o."patientName",
    o."metadata"->>'injectionName' as injection_name,
    'SHOULD CREATE: IA-R3 Medic Arrival Tracking Task' as task_required
FROM
    source_schema."Order" o
WHERE
    o."orderType" = 'INJECTION_AT_HOME'
    AND o."orderStatus" = 'MEDIC_ASSIGNED'
    AND o."appointmentTime" <= NOW()
    AND (NOW() - o."appointmentTime") >= INTERVAL '5 minutes'
    AND o."deletedAt" IS NULL
ORDER BY
    o."appointmentTime" ASC
LIMIT 20;

-- ============================================================================
-- PART 4: CRITICAL ANALYSIS - ORDERS WITH COMPLETED STATUS BUT OPEN TASKS
-- This identifies the "gap" the user mentioned
-- ============================================================================

-- 4.1: Orders marked as REPORT_DELIVERED/COMPLETED with open/non-completed tasks
SELECT
    o.id as order_id,
    o."orderStatus" as order_final_status,
    o."orderType",
    COUNT(t.id) as open_task_count,
    STRING_AGG(t."title", '; ') as task_titles,
    STRING_AGG(t."status"::text, ', ') as task_statuses,
    MAX(t."createdAt") as oldest_open_task_created,
    'ISSUE: Completed order has open tasks' as gap_issue
FROM
    source_schema."Order" o
LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE
    o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
    AND o."deletedAt" IS NULL
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
GROUP BY
    o.id, o."orderStatus", o."orderType"
HAVING
    COUNT(t.id) > 0
ORDER BY
    MAX(t."createdAt") DESC
LIMIT 30;

-- 4.2: Summary statistics
SELECT
    'TOTAL ORDERS' as metric,
    COUNT(*) as count
FROM source_schema."Order"
WHERE "deletedAt" IS NULL
UNION ALL
SELECT 'Completed Orders (REPORT_DELIVERED)', COUNT(*)
FROM source_schema."Order"
WHERE "orderStatus" = 'REPORT_DELIVERED' AND "deletedAt" IS NULL
UNION ALL
SELECT 'Open Tasks', COUNT(*)
FROM taskos.tasks
WHERE "status" NOT IN ('COMPLETED', 'CANCELLED')
UNION ALL
SELECT 'Tasks on Completed Orders', COUNT(*)
FROM taskos.tasks t
LEFT JOIN source_schema."Order" o ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
AND o."deletedAt" IS NULL;
