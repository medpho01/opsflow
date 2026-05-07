#!/bin/bash

# Task Creation Gap Validation Script
# Queries public schema (LabStack Orders) and taskos schema (Tasks) to identify gaps

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

echo "================================================================================================"
echo "TASK CREATION VALIDATION - COMPREHENSIVE GAP ANALYSIS"
echo "Database: $DB_NAME | Host: $DB_HOST"
echo "================================================================================================"

# Define psql command with proper formatting
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -t -A -F '|'"

# ============================================================================
# PART 1: ORDER STATUS DISTRIBUTION
# ============================================================================

echo ""
echo "📈 PART 1: ORDER STATUS DISTRIBUTION (current state)"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    COALESCE("orderStatus", 'Unknown') as status,
    COUNT(*) as count,
    COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM
    public."Order"
GROUP BY
    "orderStatus"
ORDER BY
    count DESC;
EOF

# ============================================================================
# PART 2: CRITICAL GAP - COMPLETED ORDERS WITH OPEN TASKS
# ============================================================================

echo ""
echo "🚨 PART 2: CRITICAL GAP - Completed orders with open tasks"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as completed_orders_with_open_tasks,
    COALESCE(SUM(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END), 0) as total_open_tasks
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderStatus" IN ('REPORT_DELIVERED')
    AND t.id IS NOT NULL;
EOF

echo ""
echo "Sample of completed orders with open tasks (top 10):"
$PSQL << EOF
SELECT
    o.id,
    o."orderType",
    o."orderStatus",
    COUNT(t.id) as open_task_count,
    STRING_AGG(DISTINCT t."title", '; ') as task_titles,
    MAX(t."createdAt") as oldest_task_created_at
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderStatus" IN ('REPORT_DELIVERED')
    AND t.id IS NOT NULL
GROUP BY
    o.id, o."orderType", o."orderStatus"
ORDER BY
    o.id DESC
LIMIT 10;
EOF

# ============================================================================
# PART 3: HOME SAMPLE COLLECTION (HSC) RULES ANALYSIS
# ============================================================================

echo ""
echo "📋 PART 3: HOME SAMPLE COLLECTION (HSC) RULES ANALYSIS"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

# HSC-R1: 30-minute confirmation (ORDER_SCHEDULED, 30+ mins old)
echo ""
echo "Rule HSC-R1: 30-Minute Confirmation"
echo "Criteria: ORDER_SCHEDULED status, created 30+ mins ago"
$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as total_qualifying,
    COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN o.id END) as with_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) as without_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) * 100.0 / COUNT(DISTINCT o.id) as gap_percentage
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."title" ILIKE '%confirm%booking%'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes';
EOF

# HSC-R2: Pre-visit tracking (PHLEBO_ASSIGNED, within 30 mins of appointment)
echo ""
echo "Rule HSC-R3: Pre-Visit Phlebo Check (30 mins before appointment)"
echo "Criteria: PHLEBO_ASSIGNED, within 30 mins of appointment time"
$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as total_qualifying,
    COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN o.id END) as with_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) as without_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) * 100.0 / COUNT(DISTINCT o.id) as gap_percentage
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."title" ILIKE '%phlebo%dispatch%'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND o."appointmentTime" BETWEEN NOW() - INTERVAL '5 minutes' AND NOW() + INTERVAL '30 minutes';
EOF

# HSC-R4: Collection tracking (PHLEBO_ASSIGNED, 60+ mins old)
echo ""
echo "Rule HSC-R4: Collection Tracking (60+ mins after phlebo assigned)"
echo "Criteria: PHLEBO_ASSIGNED, status unchanged for 60+ mins"
$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as total_qualifying,
    COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN o.id END) as with_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) as without_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) * 100.0 / COUNT(DISTINCT o.id) as gap_percentage
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."title" ILIKE '%collection%'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '60 minutes';
EOF

# HSC-R5: Sample movement tracking (SAMPLE_COLLECTED, 2+ hours old)
echo ""
echo "Rule HSC-R5: Sample Movement (2+ hours after collection)"
echo "Criteria: SAMPLE_COLLECTED, status unchanged for 2+ hours"
$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as total_qualifying,
    COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN o.id END) as with_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) as without_task,
    COUNT(DISTINCT CASE WHEN t.id IS NULL THEN o.id END) * 100.0 / COUNT(DISTINCT o.id) as gap_percentage
FROM
    public."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."title" ILIKE '%sample%handover%'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderType" = 'HOME_SAMPLE'
    AND o."orderStatus" = 'SAMPLE_COLLECTED'
    AND (NOW() - o."statusUpdatedAt") >= INTERVAL '2 hours';
EOF

# ============================================================================
# PART 4: TASK RULES STATUS
# ============================================================================

echo ""
echo "🔧 PART 4: ACTIVE TASK RULES"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    "id" as rule_id,
    "name" as rule_name,
    CASE WHEN "isActive" = true THEN 'ACTIVE' ELSE 'INACTIVE' END as status,
    "triggerCondition"->>'statusIn' as trigger_statuses
FROM taskos.task_rules
ORDER BY "isActive" DESC, "name";
EOF

# ============================================================================
# PART 5: TASK STATISTICS
# ============================================================================

echo ""
echo "📊 PART 5: OVERALL TASK STATISTICS"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    'Total Orders' as metric,
    COUNT(*) as count
FROM public."Order"
UNION ALL
SELECT 'Orders in ORDER_SCHEDULED', COUNT(*)
FROM public."Order"
WHERE "orderStatus" = 'ORDER_SCHEDULED'
UNION ALL
SELECT 'Orders in PHLEBO_ASSIGNED', COUNT(*)
FROM public."Order"
WHERE "orderStatus" = 'PHLEBO_ASSIGNED'
UNION ALL
SELECT 'Orders in SAMPLE_COLLECTED', COUNT(*)
FROM public."Order"
WHERE "orderStatus" = 'SAMPLE_COLLECTED'
UNION ALL
SELECT 'Orders REPORT_DELIVERED', COUNT(*)
FROM public."Order"
WHERE "orderStatus" = 'REPORT_DELIVERED'
UNION ALL
SELECT 'Total Tasks', COUNT(*)
FROM taskos.tasks
UNION ALL
SELECT 'Open Tasks', COUNT(*)
FROM taskos.tasks
WHERE "status" NOT IN ('COMPLETED', 'CANCELLED')
UNION ALL
SELECT 'Tasks on REPORT_DELIVERED Orders', COUNT(DISTINCT t.id)
FROM taskos.tasks t
LEFT JOIN public."Order" o ON t."entityId" = o.id AND t."entityType" = 'ORDER'
WHERE o."orderStatus" = 'REPORT_DELIVERED'
  AND t."status" NOT IN ('COMPLETED', 'CANCELLED');
EOF

# ============================================================================
# PART 6: POLLER DIAGNOSTICS
# ============================================================================

echo ""
echo "⚙️  PART 6: POLLER DIAGNOSTICS (Last 20 cycles)"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    "cycleStartedAt",
    "activeOrderCount",
    "taskRuleCount",
    "status",
    ROUND(EXTRACT(EPOCH FROM ("cycleFinishedAt" - "cycleStartedAt")) * 1000)::int as duration_ms
FROM taskos.polling_logs
ORDER BY "cycleStartedAt" DESC
LIMIT 20;
EOF

echo ""
echo "================================================================================================"
echo "✅ Validation Complete"
echo "================================================================================================"
