-- ============================================================================
-- OpsFlow Order-Driven Testing - Create Test Orders
-- ============================================================================
-- This script creates test orders in the labstack public schema
-- that will trigger task creation when the poller runs.
--
-- Orders created:
-- - HOME_INJECTION (25, 20, 2 days ago, 10 days ago)
-- - HOME_SAMPLE (22 days ago, 5 days ago)
--
-- Test IDs: 1000000-1000010 (easy to identify)
-- ============================================================================

-- Get a test user ID (using existing user)
WITH test_user AS (
  SELECT id FROM public."User" LIMIT 1
),
test_store AS (
  SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1
),
test_lab AS (
  SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1
)

INSERT INTO public."Order" (
  id,
  "orderType",
  "orderStatus",
  "appointmentTime",
  "storeId",
  "labId",
  "userId",
  "createdAt",
  "updatedAt",
  "statusUpdatedAt",
  "assignedBy",
  "phleboName",
  "phleboNumber",
  notes,
  "internalNotes"
)
VALUES
  -- ============================================================================
  -- SCENARIO 1: Old Home Injection (25 days ago) - Should create 3 tasks
  -- ============================================================================
  (
    1000000,
    'INJECTION',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '25 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '25 days',
    NOW() - INTERVAL '25 days',
    NOW() - INTERVAL '25 days',
    'TEST_SETUP',
    'Test Medic A',
    '9999999001',
    'Test Order A - Old Injection (25 days)',
    'Created for testing task creation and archiving'
  ),

  -- ============================================================================
  -- SCENARIO 2: Old Home Injection (20 days ago) - Should create 3 tasks
  -- ============================================================================
  (
    1000001,
    'INJECTION',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '20 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '20 days',
    'TEST_SETUP',
    'Test Medic B',
    '9999999002',
    'Test Order B - Old Injection (20 days)',
    'Created for testing task creation and archiving'
  ),

  -- ============================================================================
  -- SCENARIO 3: Recent Home Injection (2 days ago) - Should create 3 active tasks
  -- ============================================================================
  (
    1000002,
    'INJECTION',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '2 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '2 days',
    'TEST_SETUP',
    'Test Medic C',
    '9999999003',
    'Test Order C - Recent Injection (2 days)',
    'Created for testing - should NOT archive'
  ),

  -- ============================================================================
  -- SCENARIO 4: Boundary Case - Exactly 10 days old - Should archive
  -- ============================================================================
  (
    1000003,
    'INJECTION',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '10 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '10 days',
    NOW() - INTERVAL '10 days',
    'TEST_SETUP',
    'Test Medic D',
    '9999999004',
    'Test Order D - Boundary (10 days)',
    'Created for testing exact threshold'
  ),

  -- ============================================================================
  -- SCENARIO 5: Old Home Sample (22 days ago) - Should create 3 tasks
  -- ============================================================================
  (
    1000004,
    'HOME_SAMPLE',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '22 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '22 days',
    NOW() - INTERVAL '22 days',
    NOW() - INTERVAL '22 days',
    'TEST_SETUP',
    'Test Phlebotomist A',
    '9999999005',
    'Test Order E - Old Sample (22 days)',
    'Created for testing task creation and archiving'
  ),

  -- ============================================================================
  -- SCENARIO 6: Recent Home Sample (5 days ago) - Should create 3 active tasks
  -- ============================================================================
  (
    1000005,
    'HOME_SAMPLE',
    'PHLEBO_ASSIGNED',
    NOW() - INTERVAL '5 days',
    (SELECT id FROM test_store),
    (SELECT id FROM test_lab),
    (SELECT id FROM test_user),
    NOW() - INTERVAL '5 days',
    NOW() - INTERVAL '5 days',
    NOW() - INTERVAL '5 days',
    'TEST_SETUP',
    'Test Phlebotomist B',
    '9999999006',
    'Test Order F - Recent Sample (5 days)',
    'Created for testing - should NOT archive'
  );

-- ============================================================================
-- VERIFICATION: Show created test orders
-- ============================================================================
SELECT
  id,
  "orderType",
  "orderStatus",
  "appointmentTime",
  EXTRACT(DAY FROM NOW() - "appointmentTime") as days_old,
  "createdAt",
  notes
FROM public."Order"
WHERE id >= 1000000
ORDER BY id;

-- ============================================================================
-- ARCHIVE ELIGIBILITY CHECK (10+ days old)
-- ============================================================================
SELECT
  id,
  "orderType",
  EXTRACT(DAY FROM NOW() - "appointmentTime") as days_old,
  CASE
    WHEN EXTRACT(DAY FROM NOW() - "appointmentTime") >= 10 THEN '✓ SHOULD ARCHIVE'
    ELSE '✗ KEEP ACTIVE'
  END as expected_status
FROM public."Order"
WHERE id >= 1000000
ORDER BY id;
