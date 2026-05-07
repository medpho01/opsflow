-- ============================================================================
-- OpsFlow Order-Driven Testing - Validate Task Creation
-- ============================================================================
-- Run this AFTER the poller has processed the test orders.
-- Validates that correct tasks were created from test orders.
-- ============================================================================

-- ============================================================================
-- SECTION 1: Summary Statistics
-- ============================================================================
SELECT
  'Test Orders Created' as metric,
  COUNT(*) as count
FROM public."Order"
WHERE id >= 1000000
UNION ALL
SELECT
  'Tasks Created from Test Orders' as metric,
  COUNT(*) as count
FROM taskos.tasks t
WHERE t."entityId" >= 1000000
UNION ALL
SELECT
  'Task Rules Matched' as metric,
  COUNT(DISTINCT t."taskRuleId") as count
FROM taskos.tasks t
WHERE t."entityId" >= 1000000;

-- ============================================================================
-- SECTION 2: Tasks by Order and Type
-- ============================================================================
SELECT
  t."entityId" as order_id,
  o."orderType" as order_type,
  o."appointmentTime" as appointment,
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
  COUNT(*) as task_count,
  STRING_AGG(DISTINCT tr.name, ' | ') as task_rules_matched
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" >= 1000000
GROUP BY t."entityId", o."orderType", o."appointmentTime"
ORDER BY t."entityId";

-- ============================================================================
-- SECTION 3: Detailed Task List
-- ============================================================================
SELECT
  t.id as task_id,
  t."entityId" as order_id,
  o."orderType" as order_type,
  t."taskRuleId" as rule_id,
  tr.name as rule_name,
  tt.label as task_type,
  t.title,
  t.status,
  t.priority,
  t."slaDeadline",
  t."createdAt",
  t."isArchived"
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
LEFT JOIN taskos.task_types tt ON tt.id = t."taskTypeId"
WHERE t."entityId" >= 1000000
ORDER BY t."entityId", t.id;

-- ============================================================================
-- SECTION 4: Validation - Expected vs Actual Task Rules
-- ============================================================================
WITH expected_tasks AS (
  -- HOME_INJECTION should create 3 tasks
  SELECT 1000000 as order_id, 3 as expected_count, 'INJECTION' as order_type
  UNION ALL
  SELECT 1000001, 3, 'INJECTION'
  UNION ALL
  SELECT 1000002, 3, 'INJECTION'
  UNION ALL
  SELECT 1000003, 3, 'INJECTION'
  UNION ALL
  -- HOME_SAMPLE should create different tasks
  SELECT 1000004, 1, 'HOME_SAMPLE'  -- Other services might have different rules
  UNION ALL
  SELECT 1000005, 1, 'HOME_SAMPLE'
),
actual_tasks AS (
  SELECT
    t."entityId" as order_id,
    COUNT(*) as actual_count
  FROM taskos.tasks t
  WHERE t."entityId" >= 1000000
  GROUP BY t."entityId"
)
SELECT
  COALESCE(e.order_id, a.order_id) as order_id,
  e.order_type,
  COALESCE(e.expected_count, 0) as expected_task_count,
  COALESCE(a.actual_count, 0) as actual_task_count,
  CASE
    WHEN COALESCE(e.expected_count, 0) = COALESCE(a.actual_count, 0) THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as validation_status
FROM expected_tasks e
FULL OUTER JOIN actual_tasks a ON e.order_id = a.order_id
ORDER BY COALESCE(e.order_id, a.order_id);

-- ============================================================================
-- SECTION 5: Polling Log History
-- ============================================================================
SELECT
  id,
  "startedAt",
  "finishedAt",
  "durationMs",
  "ordersFound",
  "tasksCreated",
  status,
  "errorMessage"
FROM taskos."PollingLog"
ORDER BY "startedAt" DESC
LIMIT 10;

-- ============================================================================
-- SECTION 6: Task Rule Matching Verification
-- ============================================================================
SELECT
  tr.id,
  tr.name,
  tr."orderType",
  tr."slaMinutes",
  tr.priority,
  COUNT(t.id) as tasks_created,
  COUNT(DISTINCT t."entityId") as unique_orders_matched
FROM taskos.task_rules tr
LEFT JOIN taskos.tasks t ON t."taskRuleId" = tr.id AND t."entityId" >= 1000000
WHERE tr.name LIKE '%Injection%' OR tr.name LIKE '%Other%'
GROUP BY tr.id, tr.name, tr."orderType", tr."slaMinutes", tr.priority
ORDER BY tr."orderType", tr.name;

-- ============================================================================
-- SECTION 7: Archive Readiness Check
-- ============================================================================
SELECT
  'Test Orders Status' as check_type,
  t."entityId" as order_id,
  o."appointmentTime" as appointment_time,
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
  COUNT(*) as task_count,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10 THEN '✓ Ready for Archive'
    ELSE '⏳ Too Recent'
  END as archive_status,
  COUNT(*) FILTER (WHERE t."isArchived" = true) as archived_count
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
GROUP BY t."entityId", o."appointmentTime"
ORDER BY t."entityId";
