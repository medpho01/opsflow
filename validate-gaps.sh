#!/bin/bash

# Task Creation Gap Validation Script
# Queries both source_schema (LabStack Orders) and taskos (Tasks) to identify gaps

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
echo "TASK CREATION VALIDATION - GAP ANALYSIS"
echo "Database: $DB_NAME | Host: $DB_HOST | Port: $DB_PORT"
echo "================================================================================================"

# Define psql command with proper formatting
PSQL="psql -h $DB_HOST -U $DB_USER -d $DB_NAME -t -A -F '|'"

# ============================================================================
# PART 1: HOME SAMPLE COLLECTION (HSC) - Rule Compliance Check
# ============================================================================

echo ""
echo "📋 PART 1: HOME SAMPLE COLLECTION (HSC) - Orders requiring tasks"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

# HSC-R1: 30-minute confirmation
echo ""
echo "1.1 HSC-R1: 30-Minute Confirmation (ORDER_SCHEDULED, 30+ mins old)"
$PSQL << EOF
SELECT
    COUNT(*) as orders_needing_task,
    'HSC-R1' as rule
FROM source_schema."Order" o
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
    AND o."deletedAt" IS NULL;
EOF

# Count of orders vs actual tasks for HSC-R1
echo ""
echo "Compare: Orders needing HSC-R1 task vs existing tasks for this rule"
$PSQL << EOF
SELECT
    COALESCE(COUNT(DISTINCT o.id), 0) as orders_qualifying,
    COALESCE(COUNT(DISTINCT t.id), 0) as tasks_created,
    COALESCE(COUNT(DISTINCT o.id), 0) - COALESCE(COUNT(DISTINCT t.id), 0) as gap
FROM
    source_schema."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."title" ILIKE '%confirm%booking%'
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'ORDER_SCHEDULED'
    AND (NOW() - o."createdAt") >= INTERVAL '30 minutes'
    AND o."deletedAt" IS NULL;
EOF

# HSC-R4: Collection tracking (60+ mins since phlebo assigned)
echo ""
echo "1.4 HSC-R4: Collection Tracking (PHLEBO_ASSIGNED, 60+ mins old)"
$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as orders_needing_task,
    'HSC-R4' as rule
FROM
    source_schema."Order" o
    LEFT JOIN source_schema."OrderHistory" oh ON o.id = oh."orderId" AND oh."status" = 'PHLEBO_ASSIGNED'
WHERE
    o."orderType" = 'HOME_SAMPLE_COLLECTION'
    AND o."orderStatus" = 'PHLEBO_ASSIGNED'
    AND oh."createdAt" IS NOT NULL
    AND (NOW() - oh."createdAt") >= INTERVAL '60 minutes'
    AND o."deletedAt" IS NULL;
EOF

# ============================================================================
# PART 2: CRITICAL GAP - COMPLETED ORDERS WITH OPEN TASKS
# ============================================================================

echo ""
echo "📊 PART 2: CRITICAL GAP ANALYSIS - Completed orders still have open tasks"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    COUNT(DISTINCT o.id) as completed_orders_with_open_tasks,
    SUM(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END) as total_open_tasks,
    STRING_AGG(DISTINCT o."orderType", ', ') as order_types
FROM
    source_schema."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
    AND o."deletedAt" IS NULL
    AND t.id IS NOT NULL;
EOF

# Show sample completed orders with open tasks
echo ""
echo "Sample completed orders with open tasks (showing top 10):"
$PSQL << EOF
SELECT
    o.id,
    o."orderType",
    o."orderStatus",
    COUNT(t.id) as open_task_count,
    STRING_AGG(t."title", '; ') as task_titles
FROM
    source_schema."Order" o
    LEFT JOIN taskos.tasks t ON t."entityId" = o.id
        AND t."entityType" = 'ORDER'
        AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
WHERE
    o."orderStatus" IN ('REPORT_DELIVERED', 'COMPLETED')
    AND o."deletedAt" IS NULL
    AND t.id IS NOT NULL
GROUP BY
    o.id, o."orderType", o."orderStatus"
ORDER BY
    o.id DESC
LIMIT 10;
EOF

# ============================================================================
# PART 3: ORDER STATUS DISTRIBUTION
# ============================================================================

echo ""
echo "📈 PART 3: ORDER STATUS DISTRIBUTION"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    COALESCE(o."orderStatus", 'Unknown') as status,
    COUNT(*) as count
FROM
    source_schema."Order" o
WHERE
    o."deletedAt" IS NULL
GROUP BY
    o."orderStatus"
ORDER BY
    count DESC;
EOF

# ============================================================================
# PART 4: TASK STATISTICS
# ============================================================================

echo ""
echo "📋 PART 4: TASK STATISTICS"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    'Total Orders' as metric,
    COUNT(*) as count
FROM source_schema."Order"
WHERE "deletedAt" IS NULL
UNION ALL
SELECT 'Total Tasks', COUNT(*)
FROM taskos.tasks
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
EOF

# ============================================================================
# PART 5: ACTIVE TASK RULES VERIFICATION
# ============================================================================

echo ""
echo "🔧 PART 5: ACTIVE TASK RULES"
echo "────────────────────────────────────────────────────────────────────────────────────────────"

$PSQL << EOF
SELECT
    id,
    name,
    "triggerCondition"->>'statusIn' as trigger_statuses,
    "isActive"
FROM taskos.task_rules
WHERE "isActive" = true
ORDER BY name;
EOF

echo ""
echo "================================================================================================"
echo "✅ Validation Complete"
echo "================================================================================================"
