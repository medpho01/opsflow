#!/bin/bash

# Task Validation Runner - Execute corrected SQL and display results
# Usage: bash run_validation.sh

set -a
source .env
set +a

DB_HOST="${DATABASE_URL##*@}"
DB_HOST="${DB_HOST%%/*}"
DB_PORT="${DB_HOST##*:}"
DB_HOST="${DB_HOST%:*}"
DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
DB_USER="maverick"

PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME"

echo "╔════════════════════════════════════════════════════════════════════════════════╗"
echo "║           TASK CREATION VALIDATION - Corrected SQL Results                     ║"
echo "║            Database: $DB_NAME | User: $DB_USER                                   ║"
echo "╚════════════════════════════════════════════════════════════════════════════════╝"

# ============================================================================
# PART 1: Active Task Rules
# ============================================================================

echo ""
echo "┌─ PART 1: Active Task Rules and Trigger Conditions ────────────────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

$PSQL << 'EOF'
SELECT
    r.id as rule_id,
    r.name as rule_name,
    r."orderType",
    r."triggerCondition"->>'statusIn' as trigger_statuses,
    r."triggerCondition"->>'minutesSinceCreated' as mins_since_created,
    r."triggerCondition"->>'minutesSinceStatusUpdated' as mins_since_status_updated,
    r."triggerCondition"->>'minutesBeforeAppointment' as mins_before_appt,
    r."triggerCondition"->>'minutesAfterAppointment' as mins_after_appt
FROM taskos.task_rules r
WHERE r."isActive" = true
ORDER BY r."orderType", r.name;
EOF

# ============================================================================
# PART 2: Rule-by-Rule Gap Analysis
# ============================================================================

echo ""
echo "┌─ PART 2: Gap Analysis - Orders Qualifying vs Tasks Created ───────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

echo ""
echo "HSC-R1: Confirm Booking (ORDER_SCHEDULED, 30+ mins since created)"
$PSQL -c "
SELECT
    'HSC-R1' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r1_confirm_booking'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" = 'ORDER_SCHEDULED'
    AND (NOW() - o.\"createdAt\") >= INTERVAL '30 minutes';
"

echo ""
echo "HSC-R2: Assign Phlebo (ORDER_SCHEDULED or PHLEBO_ASSIGNED)"
$PSQL -c "
SELECT
    'HSC-R2' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r2_assign_phlebo'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" IN ('ORDER_SCHEDULED', 'PHLEBO_ASSIGNED');
"

echo ""
echo "HSC-R3: Phlebo Dispatch Check (PHLEBO_ASSIGNED, within 30 mins of appointment)"
$PSQL -c "
SELECT
    'HSC-R3' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r3_phlebo_dispatch'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" = 'PHLEBO_ASSIGNED'
    AND o.\"appointmentTime\" BETWEEN NOW() AND NOW() + INTERVAL '30 minutes';
"

echo ""
echo "HSC-R4: Confirm Sample Collected (PHLEBO_ASSIGNED/DISPATCHED, 15+ mins after appt)"
$PSQL -c "
SELECT
    'HSC-R4' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r4_confirm_collected'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND o.\"appointmentTime\" <= NOW()
    AND (NOW() - o.\"appointmentTime\") >= INTERVAL '15 minutes';
"

echo ""
echo "HSC-R5: Sample Handover to Lab (SAMPLE_COLLECTED, 30+ mins since status update)"
$PSQL -c "
SELECT
    'HSC-R5' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r5_sample_handover'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" = 'SAMPLE_COLLECTED'
    AND (NOW() - o.\"statusUpdatedAt\") >= INTERVAL '30 minutes';
"

echo ""
echo "HSC-R6: Patient Not Available Follow-up (45+ mins after appointment)"
$PSQL -c "
SELECT
    'HSC-R6' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r6_patient_missed'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND o.\"appointmentTime\" <= NOW()
    AND (NOW() - o.\"appointmentTime\") >= INTERVAL '45 minutes';
"

echo ""
echo "HSC-R7: Stale Order Follow-up (120+ mins in same status)"
$PSQL -c "
SELECT
    'HSC-R7' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r7_stale_order'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" IN ('PHLEBO_ASSIGNED', 'PHLEBO_DISPATCHED')
    AND (NOW() - o.\"statusUpdatedAt\") >= INTERVAL '120 minutes';
"

echo ""
echo "HSC-R8: Report Delivery Follow-up (240+ mins since collection)"
$PSQL -c "
SELECT
    'HSC-R8' as rule,
    COUNT(*) as qualifying_orders,
    COUNT(CASE WHEN t.id IS NOT NULL THEN 1 END) as with_tasks,
    COUNT(CASE WHEN t.id IS NULL THEN 1 END) as gap,
    ROUND(COUNT(CASE WHEN t.id IS NULL THEN 1 END) * 100.0 / COUNT(*), 1) as gap_percentage
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"taskRuleId\" = 'hsc_r8_report_followup'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o.\"orderType\" = 'HOME_SAMPLE'
    AND o.\"orderStatus\" IN ('SAMPLE_COLLECTED', 'SAMPLE_PROCESSED')
    AND (NOW() - o.\"statusUpdatedAt\") >= INTERVAL '240 minutes';
"

# ============================================================================
# PART 3: Completed Orders with Open Tasks
# ============================================================================

echo ""
echo "┌─ PART 3: Completed Orders with Open Tasks (User Concern) ─────────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

$PSQL -c "
SELECT
    o.id as order_id,
    o.\"orderType\",
    o.\"orderStatus\",
    COUNT(t.id) as open_task_count,
    STRING_AGG(DISTINCT t.\"title\", '; ') as task_titles,
    STRING_AGG(DISTINCT t.\"taskRuleId\", ', ') as rule_ids,
    MAX(t.\"createdAt\") as oldest_task_created
FROM public.\"Order\" o
LEFT JOIN taskos.tasks t ON
    t.\"entityId\" = o.id
    AND t.\"entityType\" = 'ORDER'
    AND t.\"status\" NOT IN ('COMPLETED', 'CANCELLED')
WHERE o.\"orderStatus\" = 'REPORT_DELIVERED'
GROUP BY o.id, o.\"orderType\", o.\"orderStatus\"
HAVING COUNT(t.id) > 0
ORDER BY MAX(t.\"createdAt\") DESC
LIMIT 20;
"

# ============================================================================
# PART 4: Order Status Distribution
# ============================================================================

echo ""
echo "┌─ PART 4: Order Status Distribution ───────────────────────────────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

$PSQL -c "
SELECT
    \"orderType\",
    \"orderStatus\",
    COUNT(*) as order_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY \"orderType\"), 1) as percentage_of_type
FROM public.\"Order\"
GROUP BY \"orderType\", \"orderStatus\"
ORDER BY \"orderType\", order_count DESC;
"

# ============================================================================
# PART 5: Task Statistics by Rule
# ============================================================================

echo ""
echo "┌─ PART 5: Task Statistics by Rule ─────────────────────────────────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

$PSQL -c "
SELECT
    \"taskRuleId\" as rule_id,
    COUNT(*) as total_tasks,
    COUNT(CASE WHEN \"status\" = 'CREATED' THEN 1 END) as created,
    COUNT(CASE WHEN \"status\" = 'ASSIGNED' THEN 1 END) as assigned,
    COUNT(CASE WHEN \"status\" = 'IN_PROGRESS' THEN 1 END) as in_progress,
    COUNT(CASE WHEN \"status\" = 'COMPLETED' THEN 1 END) as completed,
    COUNT(CASE WHEN \"status\" = 'CANCELLED' THEN 1 END) as cancelled,
    COUNT(CASE WHEN \"status\" NOT IN ('COMPLETED', 'CANCELLED') THEN 1 END) as open_tasks
FROM taskos.tasks
GROUP BY \"taskRuleId\"
ORDER BY open_tasks DESC;
"

# ============================================================================
# PART 6: Poller Health
# ============================================================================

echo ""
echo "┌─ PART 6: Poller Health Check (Last 20 cycles) ────────────────────────────────┐"
echo "└──────────────────────────────────────────────────────────────────────────────────┘"

$PSQL -c "
SELECT
    \"startedAt\",
    \"ordersFound\",
    \"tasksCreated\",
    \"status\",
    COALESCE(\"durationMs\", 0) as duration_ms,
    CASE WHEN \"errorMessage\" IS NOT NULL THEN 'ERROR: ' || SUBSTR(\"errorMessage\", 1, 60) ELSE 'OK' END as status_detail
FROM taskos.polling_logs
ORDER BY \"startedAt\" DESC
LIMIT 20;
"

echo ""
echo "╔════════════════════════════════════════════════════════════════════════════════╗"
echo "║                    Validation Complete ✓                                       ║"
echo "╚════════════════════════════════════════════════════════════════════════════════╝"
