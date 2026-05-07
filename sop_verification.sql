-- =============================================================================
-- OpsFlow SOP Verification Queries
-- LabStack SOP → Home Sample Collection + Centre Visit
-- =============================================================================
--
-- HOW TO RUN
--   psql "postgresql://maverick@localhost:5432/labstack" -f sop_verification.sql
--
-- SCHEMAS
--   public.*       → labstack (orders, patients, labs, stores)
--   taskos.*       → OpsFlow (tasks, rules, agents, history)
--
-- ⚠️  CRITICAL STATUS MISMATCH FOUND
--   Rules seed uses:  BOOKED, CONFIRMED, PHLEBO_DISPATCHED
--   Real DB statuses: ORDER_SCHEDULED, PHLEBO_ASSIGNED, SAMPLE_COLLECTED,
--                     SAMPLE_DELIVERED, SAMPLE_PROCESSED, REPORT_DELIVERED,
--                     RESCHEDULED, CANCELED, PATIENT_MISSED
--
--   Rules hsc_r1_confirm_booking and hsc_r2_assign_phlebo trigger on "BOOKED"
--   which does NOT exist → 0 tasks ever created for 114 live orders.
--   See Section 0 for the full impact report.
--
-- =============================================================================


-- =============================================================================
-- SECTION 0: HEALTH DASHBOARD — run this first for a quick overview
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' SECTION 0 · RULE HEALTH DASHBOARD'
\echo '════════════════════════════════════════════════════════════'

SELECT
    tr.name                                                  AS rule_name,
    tr."isActive"                                            AS active,
    tr."triggerCondition" -> 'statusIn'                      AS trigger_statuses,
    tr."slaMinutes"                                          AS sla_min,
    COUNT(t.id)                                              AS tasks_total,
    COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED')        AS completed,
    COUNT(t.id) FILTER (
        WHERE t.status NOT IN ('COMPLETED','CANCELLED'))      AS open,
    COUNT(t.id) FILTER (
        WHERE t."slaBreachedAt" IS NOT NULL)                  AS breached,
    ROUND(
        100.0 * COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED')
            / NULLIF(COUNT(t.id), 0), 1
    )                                                        AS completion_pct,
    -- Flag rules whose trigger statuses don't exist in real data
    CASE
        WHEN tr."triggerCondition" -> 'statusIn' ?| ARRAY[
            'ORDER_SCHEDULED','PHLEBO_ASSIGNED','SAMPLE_COLLECTED',
            'SAMPLE_DELIVERED','SAMPLE_PROCESSED','REPORT_DELIVERED',
            'RESCHEDULED','PATIENT_MISSED'
        ] THEN '✅ statuses valid'
        ELSE '❌ STATUS MISMATCH — rule will never fire'
    END                                                      AS status_check
FROM taskos.task_rules tr
LEFT JOIN taskos.tasks t ON t."taskRuleId" = tr.id
WHERE tr.id != 'MANUAL'
GROUP BY tr.id, tr.name, tr."isActive", tr."triggerCondition", tr."slaMinutes"
ORDER BY tr."orderType", tr.name;


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 1
-- SOP Rule: Every new order MUST be confirmed within 30 minutes
-- Maps to:  hsc_r1_confirm_booking  (trigger: statusIn = ["BOOKED"])
--
-- ⚠️  BROKEN: real status is ORDER_SCHEDULED, not BOOKED.
--    Fix: update triggerCondition statusIn to ["ORDER_SCHEDULED"]
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 1 · 30-MIN CONFIRMATION RULE'
\echo '════════════════════════════════════════════════════════════'

-- 1a. Orders needing confirmation (ORDER_SCHEDULED) — broken down by age
\echo '--- 1a. ORDER_SCHEDULED orders by age bucket ---'
SELECT
    CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60 < 30   THEN '< 30 min (within SLA)'
        WHEN EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60 < 60   THEN '30-60 min (SLA breached)'
        WHEN EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60 < 120  THEN '1-2 hours'
        WHEN EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60 < 1440 THEN '2-24 hours'
        ELSE '> 1 day (CRITICAL)'
    END                                  AS age_bucket,
    COUNT(*)                             AS order_count,
    COUNT(t.id)                          AS tasks_triggered,
    COUNT(*) - COUNT(t.id)               AS tasks_missing
FROM public."Order" o
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r1_confirm_booking'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
GROUP BY 1
ORDER BY MIN(EXTRACT(EPOCH FROM (NOW() - o."createdAt")));

-- 1b. Individual unattended orders > 30 min with no task at all
\echo '--- 1b. Unattended orders > 30 min (no task created for any rule) ---'
SELECT
    o.id                                                              AS order_id,
    u.name                                                            AS patient,
    o."orderStatus",
    o."appointmentTime"                                               AS appointment,
    o."createdAt"                                                     AS order_created,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60)::int      AS age_minutes,
    s."storeName"                                                     AS store
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND o."createdAt" < NOW() - INTERVAL '30 minutes'
  AND NOT EXISTS (
      SELECT 1 FROM taskos.tasks t
      WHERE t."entityId" = o.id AND t."entityType" = 'ORDER'
  )
ORDER BY o."createdAt" ASC;

-- 1c. Orders where a confirmation task WAS created — how long did it take?
\echo '--- 1c. Confirmation tasks created — trigger delay analysis ---'
SELECT
    o.id                                                                    AS order_id,
    u.name                                                                  AS patient,
    o."createdAt"                                                           AS order_created,
    t."createdAt"                                                           AS task_created,
    ROUND(EXTRACT(EPOCH FROM (t."createdAt" - o."createdAt")) / 60)::int    AS trigger_delay_min,
    t.status                                                                AS task_status,
    CASE WHEN t."slaBreachedAt" IS NOT NULL THEN 'BREACHED' ELSE 'OK' END   AS sla_health,
    au.name                                                                 AS assigned_to
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
                    AND t."taskRuleId" = 'hsc_r1_confirm_booking'
LEFT JOIN taskos.users au ON au.id = t."assignedToId"
ORDER BY trigger_delay_min DESC
LIMIT 50;


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 2
-- SOP Rule: All tomorrow's appointments must be CONFIRMED by end of shift (T-1)
-- Maps to:  No dedicated T-1 rule exists yet.
--           Closest: hsc_r1_confirm_booking but it only triggers on ORDER_SCHEDULED.
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 2 · T-1 DAY BEFORE CLOSURE CHECK'
\echo '════════════════════════════════════════════════════════════'

-- 2a. Tomorrow's HSC orders that are NOT yet confirmed (ORDER_SCHEDULED)
\echo '--- 2a. Tomorrow orders not confirmed (must be fixed before EOD today) ---'
SELECT
    o.id                                    AS order_id,
    u.name                                  AS patient,
    o."orderStatus",
    o."appointmentTime"                     AS appointment_tomorrow,
    o."createdAt"                           AS order_created,
    s."storeName"                           AS store,
    t.id                                    AS opsflow_task_id,
    t.status                                AS task_status
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r1_confirm_booking'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND o."appointmentTime" >= CURRENT_DATE + INTERVAL '1 day'
  AND o."appointmentTime" <  CURRENT_DATE + INTERVAL '2 days'
ORDER BY o."appointmentTime";

-- 2b. BROADER: All upcoming appointments (next 2 days) by status
\echo '--- 2b. Upcoming HSC appointments (next 48h) — status breakdown ---'
SELECT
    o."orderStatus",
    DATE(o."appointmentTime")               AS appointment_date,
    COUNT(*)                                AS order_count,
    COUNT(t.id)                             AS tasks_created,
    COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED') AS tasks_done
FROM public."Order" o
LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
  AND o."orderStatus" NOT IN ('CANCELED', 'PATIENT_MISSED')
GROUP BY o."orderStatus", DATE(o."appointmentTime")
ORDER BY appointment_date, o."orderStatus";


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 3
-- SOP Rule: 30-20 min before appointment → status must be Phlebo Started
-- Maps to:  hsc_r3_phlebo_dispatch (trigger: PHLEBO_ASSIGNED, 30 min before appt)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 3 · PRE-VISIT TRACKING (30-20 MIN WINDOW)'
\echo '════════════════════════════════════════════════════════════'

-- 3a. Orders in the pre-visit window right now (appt within next 30 min)
\echo '--- 3a. Orders in pre-visit window NOW (appt within 30 min) ---'
SELECT
    o.id                                                                 AS order_id,
    u.name                                                               AS patient,
    o."orderStatus",
    o."appointmentTime",
    ROUND(EXTRACT(EPOCH FROM (o."appointmentTime" - NOW())) / 60)::int   AS mins_to_appt,
    s."storeName"                                                        AS store,
    t.id                                                                 AS task_id,
    t.status                                                             AS task_status,
    au.name                                                              AS assigned_agent
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r3_phlebo_dispatch'
LEFT JOIN taskos.users au ON au.id = t."assignedToId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
  AND o."orderStatus" NOT IN ('CANCELED', 'SAMPLE_COLLECTED', 'SAMPLE_DELIVERED',
                               'SAMPLE_PROCESSED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
ORDER BY o."appointmentTime";

-- 3b. Orders where phlebo dispatch task was triggered — status at trigger time
\echo '--- 3b. Phlebo dispatch tasks — how far before appointment was it created? ---'
SELECT
    o.id                                                                          AS order_id,
    u.name                                                                        AS patient,
    o."appointmentTime",
    t."createdAt"                                                                 AS task_triggered,
    ROUND(EXTRACT(EPOCH FROM (o."appointmentTime" - t."createdAt")) / 60)::int    AS mins_before_appt,
    t.status                                                                      AS task_status,
    CASE WHEN t."slaBreachedAt" IS NOT NULL THEN 'BREACHED' ELSE 'OK' END         AS sla_health
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
                    AND t."taskRuleId" = 'hsc_r3_phlebo_dispatch'
ORDER BY t."createdAt" DESC
LIMIT 30;

-- 3c. Orders whose appointment passed but phlebo was NEVER assigned (gap)
\echo '--- 3c. Appointments past — phlebo never assigned (ORDER_SCHEDULED at appt time) ---'
SELECT
    o.id                                                                        AS order_id,
    u.name                                                                      AS patient,
    o."orderStatus",
    o."appointmentTime",
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."appointmentTime")) / 60)::int          AS mins_past_appt,
    s."storeName"                                                               AS store
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."appointmentTime" < NOW()
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND o."appointmentTime" > NOW() - INTERVAL '24 hours'   -- last 24h only
ORDER BY o."appointmentTime" DESC;


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 4
-- SOP Rule: No order idle after phlebo starts. If PHLEBO_ASSIGNED + 60 min → track
-- Maps to:  hsc_r4_confirm_collected (>15 min post-appt, PHLEBO_ASSIGNED)
--           hsc_r6_patient_missed    (>45 min post-appt, PHLEBO_ASSIGNED)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 4 · COLLECTION TRACKING'
\echo '════════════════════════════════════════════════════════════'

-- 4a. PHLEBO_ASSIGNED orders: how long post-appointment? Task created?
\echo '--- 4a. PHLEBO_ASSIGNED orders — post-appointment tracking ---'
SELECT
    o.id                                                                        AS order_id,
    u.name                                                                      AS patient,
    o."orderStatus",
    o."appointmentTime",
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."appointmentTime")) / 60)::int          AS mins_past_appt,
    confirm_t.id                                                                AS confirm_task_id,
    confirm_t.status                                                            AS confirm_task_status,
    missed_t.id                                                                 AS patient_missed_task_id,
    missed_t.status                                                             AS patient_missed_status,
    CASE
        WHEN confirm_t.id IS NULL AND
             EXTRACT(EPOCH FROM (NOW() - o."appointmentTime")) / 60 > 15
             THEN '⚠️ Confirm task MISSING (>15 min past appt)'
        WHEN missed_t.id IS NULL AND
             EXTRACT(EPOCH FROM (NOW() - o."appointmentTime")) / 60 > 45
             THEN '⚠️ Patient-missed task MISSING (>45 min past appt)'
        ELSE '✅ Tasks on track'
    END                                                                         AS alert
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks confirm_t
       ON confirm_t."entityId" = o.id
      AND confirm_t."entityType" = 'ORDER'
      AND confirm_t."taskRuleId" = 'hsc_r4_confirm_collected'
LEFT JOIN taskos.tasks missed_t
       ON missed_t."entityId" = o.id
      AND missed_t."entityType" = 'ORDER'
      AND missed_t."taskRuleId" = 'hsc_r6_patient_missed'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'PHLEBO_ASSIGNED'
ORDER BY o."appointmentTime";

-- 4b. Stale orders: PHLEBO_ASSIGNED with no status update for >60 min
\echo '--- 4b. Stale PHLEBO_ASSIGNED — status unchanged > 60 min ---'
SELECT
    o.id                                                                              AS order_id,
    u.name                                                                            AS patient,
    o."appointmentTime",
    o."statusUpdatedAt",
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int                AS mins_since_status_update,
    stale_t.id                                                                        AS stale_task_id,
    stale_t.status                                                                    AS stale_task_status,
    au.name                                                                           AS assigned_agent
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks stale_t
       ON stale_t."entityId" = o.id
      AND stale_t."entityType" = 'ORDER'
      AND stale_t."taskRuleId" = 'hsc_r7_stale_order'
LEFT JOIN taskos.users au ON au.id = stale_t."assignedToId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'PHLEBO_ASSIGNED'
  AND o."statusUpdatedAt" < NOW() - INTERVAL '60 minutes'
ORDER BY o."statusUpdatedAt";

-- 4c. Summary: confirm-collected tasks — completion & SLA performance
\echo '--- 4c. Confirm Sample Collected tasks — performance summary ---'
SELECT
    t.status,
    COUNT(*)                                                                   AS count,
    ROUND(AVG(
        EXTRACT(EPOCH FROM (COALESCE(t."completedAt", NOW()) - t."createdAt")) / 60
    ))::int                                                                    AS avg_resolution_min,
    COUNT(*) FILTER (WHERE t."slaBreachedAt" IS NOT NULL)                      AS sla_breached
FROM taskos.tasks t
WHERE t."taskRuleId" = 'hsc_r4_confirm_collected'
GROUP BY t.status;


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 5
-- SOP Rule: Sample must move to lab within 2 hours of collection
-- Maps to:  hsc_r5_sample_handover (SAMPLE_COLLECTED + 30 min status unchanged)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 5 · SAMPLE MOVEMENT TRACKING (2-HOUR RULE)'
\echo '════════════════════════════════════════════════════════════'

-- 5a. SAMPLE_COLLECTED orders — how long since collection? Task created?
\echo '--- 5a. SAMPLE_COLLECTED orders — time since collection + task status ---'
SELECT
    o.id                                                                          AS order_id,
    u.name                                                                        AS patient,
    o."statusUpdatedAt"                                                           AS sample_collected_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int            AS mins_since_collected,
    t.id                                                                          AS handover_task_id,
    t.status                                                                      AS handover_task_status,
    CASE WHEN t."slaBreachedAt" IS NOT NULL THEN 'BREACHED' ELSE
         WHEN t.id IS NULL THEN 'NO TASK'
         ELSE 'OK' END                                                            AS sla_health,
    CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60 > 120
             AND t.status NOT IN ('COMPLETED') THEN '🔴 CRITICAL: >2h, sample stuck'
        WHEN EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60 > 60
             THEN '🟡 WARNING: >1h since collection'
        ELSE '🟢 Within window'
    END                                                                           AS alert,
    au.name                                                                       AS assigned_agent
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r5_sample_handover'
LEFT JOIN taskos.users au ON au.id = t."assignedToId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'SAMPLE_COLLECTED'
ORDER BY o."statusUpdatedAt";

-- 5b. Samples stuck > 2 hours with no completed handover task (SOP violation)
\echo '--- 5b. SOP VIOLATIONS: Sample stuck > 2 hours ---'
SELECT
    o.id                                                                         AS order_id,
    u.name                                                                       AS patient,
    o."statusUpdatedAt"                                                          AS sample_collected_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int           AS mins_since_collected,
    s."storeName"                                                                AS store,
    t.status                                                                     AS task_status
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r5_sample_handover'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'SAMPLE_COLLECTED'
  AND o."statusUpdatedAt" < NOW() - INTERVAL '2 hours'
  AND (t.id IS NULL OR t.status != 'COMPLETED')
ORDER BY o."statusUpdatedAt";


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 6
-- SOP Rule: After Sample Delivered — capture ETA, monitor reports, follow up
-- Maps to:  hsc_r8_report_followup (SAMPLE_COLLECTED/RECEIVED + 4h status unchanged)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 6 · REPORT TRACKING'
\echo '════════════════════════════════════════════════════════════'

-- 6a. SAMPLE_DELIVERED / SAMPLE_PROCESSED orders awaiting report
\echo '--- 6a. Orders awaiting reports — time since delivery ---'
SELECT
    o.id                                                                         AS order_id,
    u.name                                                                       AS patient,
    o."orderStatus",
    o."statusUpdatedAt"                                                          AS status_since,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int           AS mins_in_status,
    t.id                                                                         AS report_task_id,
    t.status                                                                     AS report_task_status,
    CASE WHEN t."slaBreachedAt" IS NOT NULL THEN 'BREACHED' ELSE
         CASE WHEN t.id IS NULL THEN 'NO TASK YET' ELSE 'OK' END
    END                                                                          AS sla_health,
    au.name                                                                      AS assigned_agent
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks t
       ON t."entityId" = o.id
      AND t."entityType" = 'ORDER'
      AND t."taskRuleId" = 'hsc_r8_report_followup'
LEFT JOIN taskos.users au ON au.id = t."assignedToId"
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" IN ('SAMPLE_DELIVERED', 'SAMPLE_PROCESSED')
ORDER BY o."statusUpdatedAt";

-- 6b. Report follow-up task performance
\echo '--- 6b. Report follow-up tasks — status distribution ---'
SELECT
    t.status,
    COUNT(*)                                                        AS count,
    COUNT(*) FILTER (WHERE t."slaBreachedAt" IS NOT NULL)          AS breached,
    ROUND(AVG(
        EXTRACT(EPOCH FROM (COALESCE(t."completedAt", NOW()) - t."createdAt")) / 60
    ))::int                                                         AS avg_minutes_open
FROM taskos.tasks t
WHERE t."taskRuleId" = 'hsc_r8_report_followup'
GROUP BY t.status;


-- =============================================================================
-- HOME SAMPLE COLLECTION — SECTION 8 (STALE ORDER MONITORING)
-- SOP Rule: Escalate if order is stuck in same status for too long
-- Maps to:  hsc_r7_stale_order (any key status, unchanged > 120 min)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' HSC SECTION 8 · STALE ORDER / ESCALATION TRACKING'
\echo '════════════════════════════════════════════════════════════'

-- 8a. All active orders stale > 2 hours — with or without a stale task
\echo '--- 8a. Active orders with no status change > 2 hours ---'
SELECT
    o.id                                                                        AS order_id,
    u.name                                                                      AS patient,
    o."orderStatus",
    o."statusUpdatedAt",
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int          AS mins_stale,
    stale_t.id                                                                  AS stale_task_id,
    stale_t.status                                                              AS stale_task_status,
    CASE
        WHEN stale_t.id IS NULL THEN '❌ No stale task triggered'
        WHEN stale_t.status = 'COMPLETED' THEN '✅ Resolved'
        ELSE '🟡 Task open, pending resolution'
    END                                                                         AS status
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks stale_t
       ON stale_t."entityId" = o.id
      AND stale_t."entityType" = 'ORDER'
      AND stale_t."taskRuleId" = 'hsc_r7_stale_order'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" NOT IN ('CANCELED', 'REPORT_DELIVERED', 'PATIENT_MISSED')
  AND o."statusUpdatedAt" < NOW() - INTERVAL '2 hours'
ORDER BY o."statusUpdatedAt";

-- 8b. Stale task age distribution
\echo '--- 8b. Stale order tasks — open duration ---'
SELECT
    CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - t."createdAt")) / 60 < 60   THEN '< 1h open'
        WHEN EXTRACT(EPOCH FROM (NOW() - t."createdAt")) / 60 < 240  THEN '1-4h open'
        WHEN EXTRACT(EPOCH FROM (NOW() - t."createdAt")) / 60 < 1440 THEN '4-24h open'
        ELSE '> 1 day open (CRITICAL)'
    END                                                        AS age_bucket,
    t.status,
    COUNT(*)                                                   AS count
FROM taskos.tasks t
WHERE t."taskRuleId" = 'hsc_r7_stale_order'
GROUP BY 1, 2
ORDER BY MIN(EXTRACT(EPOCH FROM (NOW() - t."createdAt")));


-- =============================================================================
-- CENTRE VISIT — SECTION 1
-- SOP Rule: Same 30-min confirmation as HSC
-- Note: No CENTER_VISIT rules seeded yet in task_rules
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' CENTRE VISIT SECTION 1 · 30-MIN CONFIRMATION'
\echo '════════════════════════════════════════════════════════════'

-- Check if any CV rules exist
\echo '--- CV rules currently configured ---'
SELECT id, name, "isActive", "triggerCondition"
FROM taskos.task_rules
WHERE "orderType" = 'CENTER_VISIT'
  AND id != 'MANUAL';

-- Unattended CV orders > 30 min
\echo '--- CV orders > 30 min with no task ---'
SELECT
    o.id                                                                       AS order_id,
    u.name                                                                     AS patient,
    o."orderStatus",
    o."appointmentTime"                                                        AS appointment,
    o."createdAt"                                                              AS order_created,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."createdAt")) / 60)::int               AS age_minutes
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
WHERE o."orderType" = 'CENTER_VISIT'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND o."createdAt" < NOW() - INTERVAL '30 minutes'
  AND NOT EXISTS (
      SELECT 1 FROM taskos.tasks t
      WHERE t."entityId" = o.id AND t."entityType" = 'ORDER'
  )
ORDER BY o."createdAt";


-- =============================================================================
-- CENTRE VISIT — SECTION 2: T-1 Confirmation
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' CENTRE VISIT SECTION 2 · T-1 CONFIRMATION (TOMORROW)'
\echo '════════════════════════════════════════════════════════════'

\echo '--- CV orders for tomorrow not confirmed ---'
SELECT
    o.id                             AS order_id,
    u.name                           AS patient,
    o."orderStatus",
    o."appointmentTime"              AS appt_tomorrow,
    s."storeName"                    AS centre
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
WHERE o."orderType" = 'CENTER_VISIT'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND o."appointmentTime" >= CURRENT_DATE + INTERVAL '1 day'
  AND o."appointmentTime" <  CURRENT_DATE + INTERVAL '2 days'
ORDER BY o."appointmentTime";


-- =============================================================================
-- CENTRE VISIT — SECTION 3: Day of Appointment (T-2 hours)
-- SOP Rule: Call centre 2 hours before, confirm slot + payment
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' CENTRE VISIT SECTION 3 · DAY OF APPT — T-2 HOUR CHECK'
\echo '════════════════════════════════════════════════════════════'

\echo '--- CV orders with appointment in next 2 hours ---'
SELECT
    o.id                                                                        AS order_id,
    u.name                                                                      AS patient,
    o."orderStatus",
    o."appointmentTime",
    ROUND(EXTRACT(EPOCH FROM (o."appointmentTime" - NOW())) / 60)::int          AS mins_to_appt,
    s."storeName"                                                               AS centre,
    o."isPostpaid"                                                              AS is_postpaid,
    COUNT(t.id)                                                                 AS tasks_created
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderType" = 'CENTER_VISIT'
  AND o."appointmentTime" BETWEEN NOW() AND NOW() + INTERVAL '2 hours'
  AND o."orderStatus" NOT IN ('CANCELED', 'PATIENT_MISSED', 'REPORT_DELIVERED')
GROUP BY o.id, u.name, s."storeName"
ORDER BY o."appointmentTime";


-- =============================================================================
-- CENTRE VISIT — SECTION 4: Post Appointment (T+1 hour)
-- SOP Rule: Call centre or patient 1 hour after appointment
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' CENTRE VISIT SECTION 4 · POST-APPT T+1 HOUR CHECK'
\echo '════════════════════════════════════════════════════════════'

\echo '--- CV orders past appointment with no completion (past 1-6h window) ---'
SELECT
    o.id                                                                         AS order_id,
    u.name                                                                       AS patient,
    o."orderStatus",
    o."appointmentTime",
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."appointmentTime")) / 60)::int           AS mins_past_appt,
    s."storeName"                                                                AS centre,
    COUNT(t.id)                                                                  AS tasks_created,
    COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED')                           AS tasks_completed
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderType" = 'CENTER_VISIT'
  AND o."appointmentTime" BETWEEN NOW() - INTERVAL '6 hours' AND NOW() - INTERVAL '1 hour'
  AND o."orderStatus" NOT IN ('REPORT_DELIVERED', 'CANCELED')
GROUP BY o.id, u.name, s."storeName"
HAVING COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED') = 0
ORDER BY o."appointmentTime";


-- =============================================================================
-- CENTRE VISIT — SECTION 5: Report Tracking (same as HSC Section 6)
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' CENTRE VISIT SECTION 5 · REPORT TRACKING'
\echo '════════════════════════════════════════════════════════════'

\echo '--- CV orders in SAMPLE_PROCESSED awaiting reports ---'
SELECT
    o.id                                                                        AS order_id,
    u.name                                                                      AS patient,
    o."orderStatus",
    o."statusUpdatedAt"                                                         AS status_since,
    ROUND(EXTRACT(EPOCH FROM (NOW() - o."statusUpdatedAt")) / 60)::int          AS mins_in_status,
    s."storeName"                                                               AS centre
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN public."Store" s ON s.id = o."storeId"
WHERE o."orderType" = 'CENTER_VISIT'
  AND o."orderStatus" IN ('SAMPLE_DELIVERED', 'SAMPLE_PROCESSED')
ORDER BY o."statusUpdatedAt";


-- =============================================================================
-- CROSS-CUTTING: COMPLETE ORDER LIFECYCLE AUDIT
-- One row per order — every OpsFlow touchpoint across all rules
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' LIFECYCLE AUDIT · Full order × rule coverage matrix'
\echo '════════════════════════════════════════════════════════════'

\echo '--- HSC: Order lifecycle — all rules per order (last 48h) ---'
SELECT
    o.id                                                                AS order_id,
    u.name                                                              AS patient,
    o."orderStatus"                                                     AS current_status,
    o."appointmentTime"                                                 AS appointment,
    -- Rule 1: Confirm Booking
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r1_confirm_booking'
        THEN t.status END)                                              AS s1_confirm,
    -- Rule 2: Assign Phlebo
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r2_assign_phlebo'
        THEN t.status END)                                              AS s2_assign_phlebo,
    -- Rule 3: Phlebo Dispatch Check
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r3_phlebo_dispatch'
        THEN t.status END)                                              AS s3_dispatch_check,
    -- Rule 4: Confirm Collected
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r4_confirm_collected'
        THEN t.status END)                                              AS s4_confirm_collected,
    -- Rule 5: Sample Handover
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r5_sample_handover'
        THEN t.status END)                                              AS s5_sample_handover,
    -- Rule 6: Patient Missed
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r6_patient_missed'
        THEN t.status END)                                              AS s6_patient_missed,
    -- Rule 7: Stale Order
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r7_stale_order'
        THEN t.status END)                                              AS s7_stale,
    -- Rule 8: Report Follow-up
    MAX(CASE WHEN t."taskRuleId" = 'hsc_r8_report_followup'
        THEN t.status END)                                              AS s8_report,
    COUNT(t.id)                                                         AS total_tasks,
    COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED')                  AS completed_tasks,
    COUNT(t.id) FILTER (WHERE t."slaBreachedAt" IS NOT NULL)           AS breached_tasks
FROM public."Order" o
JOIN public."User" u ON u.id = o."userId"
LEFT JOIN taskos.tasks t ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."createdAt" > NOW() - INTERVAL '48 hours'
  AND o."orderStatus" NOT IN ('CANCELED')
GROUP BY o.id, u.name
ORDER BY o."appointmentTime" DESC NULLS LAST;


-- =============================================================================
-- ⚠️  CRITICAL ACTION ITEMS — STATUS MISMATCH SUMMARY
-- =============================================================================

\echo ''
\echo '════════════════════════════════════════════════════════════'
\echo ' ⚠️  CRITICAL: RULE STATUS MISMATCHES TO FIX'
\echo '════════════════════════════════════════════════════════════'

\echo '--- Rules using statuses that do NOT exist in the real Order table ---'
SELECT
    tr.id                                           AS rule_id,
    tr.name                                         AS rule_name,
    tr."triggerCondition" -> 'statusIn'             AS trigger_statuses,
    'Real statuses: ORDER_SCHEDULED, PHLEBO_ASSIGNED,'
    || ' SAMPLE_COLLECTED, SAMPLE_DELIVERED,'
    || ' SAMPLE_PROCESSED, REPORT_DELIVERED'        AS valid_statuses,
    COUNT(t.id)                                     AS tasks_ever_created,
    -- Count orders currently stuck (matching rule's orderType)
    (SELECT COUNT(*) FROM public."Order" o2
     WHERE o2."orderType"::text = tr."orderType"::text
       AND o2."orderStatus" = 'ORDER_SCHEDULED') AS orders_needing_confirmation
FROM taskos.task_rules tr
LEFT JOIN taskos.tasks t ON t."taskRuleId" = tr.id
WHERE tr.id IN ('hsc_r1_confirm_booking', 'hsc_r2_assign_phlebo')
GROUP BY tr.id, tr.name, tr."triggerCondition";

\echo ''
\echo '--- Fix script (UPDATE these rules in OpsFlow UI or via SQL) ---'
\echo '--- Rule hsc_r1_confirm_booking: change BOOKED → ORDER_SCHEDULED ---'
\echo '--- Rule hsc_r2_assign_phlebo:   change BOOKED,CONFIRMED → ORDER_SCHEDULED,PHLEBO_ASSIGNED ---'
\echo '--- Rule hsc_r7_stale_order:     add ORDER_SCHEDULED to statusIn ---'

-- Preview what would trigger if statuses were corrected:
\echo '--- Orders that WOULD trigger hsc_r1_confirm_booking (if status fixed) ---'
SELECT
    COUNT(*)                                                            AS eligible_orders,
    COUNT(*) FILTER (WHERE o."createdAt" > NOW() - INTERVAL '30 min') AS within_sla,
    COUNT(*) FILTER (WHERE o."createdAt" < NOW() - INTERVAL '30 min'
                      AND o."createdAt" > NOW() - INTERVAL '24 hours') AS breached_today,
    COUNT(*) FILTER (WHERE o."createdAt" < NOW() - INTERVAL '24 hours') AS older_than_1_day
FROM public."Order" o
WHERE o."orderType" = 'HOME_SAMPLE'
  AND o."orderStatus" = 'ORDER_SCHEDULED'
  AND NOT EXISTS (
      SELECT 1 FROM taskos.tasks t
      WHERE t."entityId" = o.id AND t."entityType" = 'ORDER'
        AND t."taskRuleId" = 'hsc_r1_confirm_booking'
  );
