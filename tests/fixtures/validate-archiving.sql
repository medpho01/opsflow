-- ============================================================================
-- OpsFlow Order-Driven Testing - Validate Archiving
-- ============================================================================
-- Run this AFTER archiving has been triggered.
-- Validates that tasks are archived correctly based on appointment date.
-- ============================================================================

-- ============================================================================
-- SECTION 1: Archive Status Summary
-- ============================================================================
SELECT
  'Total Test Tasks' as metric,
  COUNT(*) as count,
  COUNT(*) FILTER (WHERE "isArchived" = false) as active,
  COUNT(*) FILTER (WHERE "isArchived" = true) as archived
FROM taskos.tasks
WHERE "entityId" >= 1000000;

-- ============================================================================
-- SECTION 2: Archive Status by Order
-- ============================================================================
SELECT
  t."entityId" as order_id,
  o."orderType",
  o."appointmentTime" as appointment_time,
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
  COUNT(*) as total_tasks,
  COUNT(*) FILTER (WHERE t."isArchived" = false) as active_tasks,
  COUNT(*) FILTER (WHERE t."isArchived" = true) as archived_tasks,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10 THEN '✓ SHOULD ARCHIVE'
    ELSE '✗ SHOULD STAY ACTIVE'
  END as expected_status,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10
      AND COUNT(*) FILTER (WHERE t."isArchived" = true) = COUNT(*)
    THEN '✓ CORRECT'
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") < 10
      AND COUNT(*) FILTER (WHERE t."isArchived" = false) = COUNT(*)
    THEN '✓ CORRECT'
    ELSE '✗ MISMATCH'
  END as validation_result
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
GROUP BY t."entityId", o."orderType", o."appointmentTime"
ORDER BY t."entityId";

-- ============================================================================
-- SECTION 3: Archive Eligibility vs Reality
-- ============================================================================
SELECT
  t."entityId" as order_id,
  o."appointmentTime",
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
  o."orderType",
  COUNT(*) as task_count,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10 THEN 'ELIGIBLE'
    ELSE 'NOT_ELIGIBLE'
  END as archive_eligibility,
  CASE
    WHEN COUNT(*) FILTER (WHERE t."isArchived" = true) = COUNT(*) THEN 'ALL_ARCHIVED'
    WHEN COUNT(*) FILTER (WHERE t."isArchived" = false) = COUNT(*) THEN 'ALL_ACTIVE'
    ELSE 'MIXED'
  END as actual_status,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10
      AND COUNT(*) FILTER (WHERE t."isArchived" = true) = COUNT(*)
    THEN '✓ PASS'
    WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") < 10
      AND COUNT(*) FILTER (WHERE t."isArchived" = false) = COUNT(*)
    THEN '✓ PASS'
    ELSE '✗ FAIL'
  END as test_result
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
GROUP BY t."entityId", o."appointmentTime", o."orderType"
ORDER BY t."entityId";

-- ============================================================================
-- SECTION 4: Archive View Verification
-- ============================================================================
-- Check if archived tasks are visible in the archive view
SELECT
  'Archived Tasks Count' as check,
  COUNT(*) as count
FROM taskos.tasks
WHERE "entityId" >= 1000000 AND "isArchived" = true
UNION ALL
SELECT
  'Active Tasks Count',
  COUNT(*)
FROM taskos.tasks
WHERE "entityId" >= 1000000 AND "isArchived" = false;

-- ============================================================================
-- SECTION 5: Days Since Appointment Calculation
-- ============================================================================
-- Validate that daysSinceAppointment would be calculated correctly
SELECT
  t."entityId" as order_id,
  o."appointmentTime",
  EXTRACT(DAY FROM NOW() - (t.metadata->>'appointmentTime')::timestamp) as days_since_appointment_calc,
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_since_appointment_order,
  t."isArchived",
  CASE
    WHEN EXTRACT(DAY FROM NOW() - (t.metadata->>'appointmentTime')::timestamp) >= 10 THEN 'Should be archived'
    ELSE 'Should be active'
  END as expectation
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
ORDER BY t."entityId", t.id;

-- ============================================================================
-- SECTION 6: Failed Archive Check
-- ============================================================================
-- Show which orders should have been archived but weren't
SELECT
  t."entityId" as order_id,
  o."orderType",
  o."appointmentTime",
  EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
  COUNT(*) as task_count,
  COUNT(*) FILTER (WHERE t."isArchived" = false) as still_active,
  'ERROR: Should have been archived' as issue
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
  AND EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10
  AND t."isArchived" = false
GROUP BY t."entityId", o."orderType", o."appointmentTime"
UNION ALL
-- Show which orders are archived but shouldn't be
SELECT
  t."entityId",
  o."orderType",
  o."appointmentTime",
  EXTRACT(DAY FROM NOW() - o."appointmentTime"),
  COUNT(*),
  COUNT(*) FILTER (WHERE t."isArchived" = true),
  'ERROR: Should have stayed active'
FROM taskos.tasks t
LEFT JOIN public."Order" o ON o.id = t."entityId"
WHERE t."entityId" >= 1000000
  AND EXTRACT(DAY FROM NOW() - o."appointmentTime") < 10
  AND t."isArchived" = true
GROUP BY t."entityId", o."orderType", o."appointmentTime";

-- ============================================================================
-- SECTION 7: Final Test Report
-- ============================================================================
WITH test_results AS (
  SELECT
    t."entityId",
    o."orderType",
    EXTRACT(DAY FROM NOW() - o."appointmentTime") as days_old,
    CASE
      WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10 THEN 'ELIGIBLE'
      ELSE 'NOT_ELIGIBLE'
    END as eligibility,
    CASE
      WHEN COUNT(*) FILTER (WHERE t."isArchived" = true) = COUNT(*) THEN 'ARCHIVED'
      ELSE 'ACTIVE'
    END as actual_status,
    CASE
      WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") >= 10
        AND COUNT(*) FILTER (WHERE t."isArchived" = true) = COUNT(*)
      THEN true
      WHEN EXTRACT(DAY FROM NOW() - o."appointmentTime") < 10
        AND COUNT(*) FILTER (WHERE t."isArchived" = false) = COUNT(*)
      THEN true
      ELSE false
    END as passed
  FROM taskos.tasks t
  LEFT JOIN public."Order" o ON o.id = t."entityId"
  WHERE t."entityId" >= 1000000
  GROUP BY t."entityId", o."orderType"
)
SELECT
  SUM(CASE WHEN passed THEN 1 ELSE 0 END)::text || '/' || COUNT(*)::text as test_pass_rate,
  COUNT(*) FILTER (WHERE passed = true) as passed_tests,
  COUNT(*) FILTER (WHERE passed = false) as failed_tests,
  CASE
    WHEN COUNT(*) FILTER (WHERE passed = false) = 0 THEN '✓ ALL TESTS PASSED'
    ELSE '✗ SOME TESTS FAILED'
  END as overall_result
FROM test_results;
