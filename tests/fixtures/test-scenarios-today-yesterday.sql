-- ============================================================================
-- OpsFlow Comprehensive Testing - TODAY & YESTERDAY Orders
-- ============================================================================
-- This document contains test scenarios for validating the complete
-- HOME SAMPLE and INJECTION workflows with real-world timing.
--
-- ORDERS ARE CREATED WITH:
-- - TODAY appointments (to test current/live tasks)
-- - YESTERDAY appointments (to test late-stage tasks)
--
-- Test Order IDs: 2000000-2000015 (easy to identify)
--
-- DO NOT EXECUTE ALL AT ONCE - Read scenarios and execute selectively
-- ============================================================================

-- ============================================================================
-- SECTION 0: SETUP & PREREQUISITES
-- ============================================================================

-- Check task rules are active (should be done before running tests)
-- SELECT COUNT(*) FROM taskos.task_rules WHERE "isActive" = true;
-- Expected: 15 rules

-- Check required task types exist
-- SELECT id, name FROM taskos.task_types WHERE name LIKE 'HSC_%' OR name LIKE 'INJ_%';

-- Get test user and store
-- SELECT id FROM public."User" LIMIT 1;  -- Note the user ID
-- SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1;  -- Note the store ID
-- SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1;  -- Note the lab ID

-- ============================================================================
-- SECTION 1: HOME SAMPLE - TODAY APPOINTMENT (Test HSC Rules)
-- ============================================================================
-- Scenario: NEW order created TODAY
-- Expected flow as day progresses:
-- T+0min: Confirm Booking (30 min SLA)
-- T+30min: Assign Phlebotomist (if appointment later today)
-- T-30min: Phlebo Dispatch Check (30 min before appt)
-- T+15min post-appt: Confirm Sample Collected
-- T+30min post-collected: Sample Handover to Lab
-- T+4h post-collected: Report Delivery Follow-up
--
-- Create with: TODAY at 2:00 PM (14:00)

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
SELECT
  2000000,
  'HOME_SAMPLE',
  'ORDER_SCHEDULED',
  CURRENT_DATE + INTERVAL '14 hours',  -- Today at 2:00 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW(),
  NOW(),
  NOW(),
  'TEST_SETUP',
  '',
  '',
  'TEST 2000000: HOME SAMPLE - TODAY at 2 PM',
  '[SCENARIO] New order created - should trigger Confirm Booking (30 min SLA)'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000000);

-- ============================================================================
-- SECTION 2: HOME SAMPLE - YESTERDAY APPOINTMENT (Test Late-Stage Tasks)
-- ============================================================================
-- Scenario: Order from YESTERDAY at 2:00 PM with various statuses
-- This allows testing time-elapsed tasks like stale order follow-up
-- Create with different status progressions:
--
-- 2000001: Created yesterday, still ORDER_SCHEDULED (should trigger stale follow-up)
-- 2000002: Created yesterday, PHLEBO_ASSIGNED (testing pre-dispatch)
-- 2000003: Created yesterday, PHLEBO_DISPATCHED (testing collection tasks)
-- 2000004: Created yesterday, SAMPLE_COLLECTED (testing handover tasks)

-- Order 2000001: Yesterday appointment, ORDER_SCHEDULED status
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
SELECT
  2000001,
  'HOME_SAMPLE',
  'ORDER_SCHEDULED',
  CURRENT_DATE - INTERVAL '10 hours',  -- Yesterday at 2 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '24 hours',
  'TEST_SETUP',
  '',
  '',
  'TEST 2000001: HOME SAMPLE - YESTERDAY at 2 PM, ORDER_SCHEDULED',
  '[SCENARIO] Stale order - should trigger Stale Order Follow-up after 120 min'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000001);

-- Order 2000002: Yesterday appointment, PHLEBO_ASSIGNED status
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
SELECT
  2000002,
  'HOME_SAMPLE',
  'PHLEBO_ASSIGNED',
  CURRENT_DATE - INTERVAL '10 hours',  -- Yesterday at 2 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '20 hours',
  NOW() - INTERVAL '20 hours',
  'TEST_SETUP',
  'Test Phlebotomist 1',
  '9999900001',
  'TEST 2000002: HOME SAMPLE - YESTERDAY at 2 PM, PHLEBO_ASSIGNED',
  '[SCENARIO] Phlebo assigned but not dispatched - Testing pre-dispatch tasks'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000002);

-- Order 2000003: Yesterday appointment, PHLEBO_DISPATCHED status
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
SELECT
  2000003,
  'HOME_SAMPLE',
  'PHLEBO_DISPATCHED',
  CURRENT_DATE - INTERVAL '10 hours',  -- Yesterday at 2 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '16 hours',
  NOW() - INTERVAL '16 hours',
  'TEST_SETUP',
  'Test Phlebotomist 2',
  '9999900002',
  'TEST 2000003: HOME SAMPLE - YESTERDAY at 2 PM, PHLEBO_DISPATCHED',
  '[SCENARIO] Phlebo dispatched - Testing collection and patient missed tasks'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000003);

-- Order 2000004: Yesterday appointment, SAMPLE_COLLECTED status
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
SELECT
  2000004,
  'HOME_SAMPLE',
  'SAMPLE_COLLECTED',
  CURRENT_DATE - INTERVAL '10 hours',  -- Yesterday at 2 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '12 hours',
  NOW() - INTERVAL '8 hours',
  'TEST_SETUP',
  'Test Phlebotomist 3',
  '9999900003',
  'TEST 2000004: HOME SAMPLE - YESTERDAY at 2 PM, SAMPLE_COLLECTED',
  '[SCENARIO] Sample collected - Testing handover and report follow-up tasks'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000004);

-- Order 2000005: Yesterday appointment, SAMPLE_RECEIVED status (post-handover)
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
SELECT
  2000005,
  'HOME_SAMPLE',
  'SAMPLE_RECEIVED',
  CURRENT_DATE - INTERVAL '10 hours',  -- Yesterday at 2 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '10 hours',
  NOW() - INTERVAL '6 hours',
  'TEST_SETUP',
  'Test Phlebotomist 4',
  '9999900004',
  'TEST 2000005: HOME SAMPLE - YESTERDAY at 2 PM, SAMPLE_RECEIVED',
  '[SCENARIO] Sample received by lab - Testing report follow-up tasks'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000005);

-- ============================================================================
-- SECTION 3: HOME SAMPLE - EARLY MORNING TODAY (Test Early Window)
-- ============================================================================
-- Scenario: Order with TODAY early morning appointment (8:00 AM)
-- Tests pre-visit window and early dispatch scenarios

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
SELECT
  2000006,
  'HOME_SAMPLE',
  'PHLEBO_ASSIGNED',
  CURRENT_DATE + INTERVAL '8 hours',  -- Today at 8:00 AM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '2 hours',
  NOW() - INTERVAL '1 hour',
  NOW() - INTERVAL '1 hour',
  'TEST_SETUP',
  'Test Phlebotomist 5',
  '9999900005',
  'TEST 2000006: HOME SAMPLE - TODAY at 8 AM, PHLEBO_ASSIGNED',
  '[SCENARIO] Early morning appointment - Testing 30min pre-visit dispatch check'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000006);

-- ============================================================================
-- SECTION 4: INJECTION - TODAY APPOINTMENT (Test Injection Rules)
-- ============================================================================
-- Scenario: New INJECTION order created TODAY at 3:00 PM
-- Expected flow:
-- T+0: Assign Medic (immediate)
-- T-60min: Pre-visit Confirmation (60 min before)
-- T+post: Post-Admin Monitoring (after injection)

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
SELECT
  2000010,
  'INJECTION',
  'PHLEBO_ASSIGNED',
  CURRENT_DATE + INTERVAL '15 hours',  -- Today at 3:00 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW(),
  NOW(),
  NOW(),
  'TEST_SETUP',
  'Test Medic 1',
  '9999901001',
  'TEST 2000010: INJECTION - TODAY at 3 PM',
  '[SCENARIO] New injection order - should trigger Assign Medic immediately'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000010);

-- ============================================================================
-- SECTION 5: INJECTION - YESTERDAY APPOINTMENT (Test Late-Stage Injection)
-- ============================================================================
-- Scenario: INJECTION from yesterday with various statuses

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
SELECT
  2000011,
  'INJECTION',
  'PHLEBO_ASSIGNED',
  CURRENT_DATE - INTERVAL '9 hours',  -- Yesterday at 3 PM
  (SELECT id FROM public."Store" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."Lab" WHERE id IS NOT NULL LIMIT 1),
  (SELECT id FROM public."User" LIMIT 1),
  NOW() - INTERVAL '24 hours',
  NOW() - INTERVAL '20 hours',
  NOW() - INTERVAL '20 hours',
  'TEST_SETUP',
  'Test Medic 2',
  '9999901002',
  'TEST 2000011: INJECTION - YESTERDAY at 3 PM, PHLEBO_ASSIGNED',
  '[SCENARIO] Yesterday injection - Testing pre-visit and post-admin tasks'
WHERE NOT EXISTS (SELECT 1 FROM public."Order" WHERE id = 2000011);

-- ============================================================================
-- VERIFICATION: Show created test orders
-- ============================================================================

SELECT
  id,
  "orderType",
  "orderStatus",
  "appointmentTime",
  TO_CHAR("appointmentTime", 'YYYY-MM-DD HH24:MI') as appt_display,
  CURRENT_DATE = "appointmentTime"::date as is_today,
  CURRENT_DATE - 1 = "appointmentTime"::date as is_yesterday,
  notes
FROM public."Order"
WHERE id >= 2000000
ORDER BY id;

-- ============================================================================
-- SUMMARY & TESTING GUIDE
-- ============================================================================

/*

CREATED TEST ORDERS:

HOME SAMPLE ORDERS:
──────────────────
2000000: TODAY at 2:00 PM, ORDER_SCHEDULED
         → Should trigger: Confirm Booking (30 min SLA)
         → Then: Assign Phlebotomist
         → Then: Phlebo Dispatch (30 min before)
         → Then: Confirm Collected (after appt)

2000001: YESTERDAY at 2:00 PM, ORDER_SCHEDULED
         → Should trigger: Stale Order Follow-up (120+ min same status)
         → Testing missed tasks from yesterday

2000002: YESTERDAY at 2:00 PM, PHLEBO_ASSIGNED
         → Should trigger: Phlebo Dispatch tasks
         → Testing mid-flow from yesterday

2000003: YESTERDAY at 2:00 PM, PHLEBO_DISPATCHED
         → Should trigger: Confirm Collected, Patient Missed (45+ min)
         → Testing post-dispatch scenario

2000004: YESTERDAY at 2:00 PM, SAMPLE_COLLECTED
         → Should trigger: Sample Handover (30+ min), Report Follow-up (240+ min)
         → Testing post-collection scenario

2000005: YESTERDAY at 2:00 PM, SAMPLE_RECEIVED
         → Should trigger: Report Follow-up
         → Testing final stages

2000006: TODAY at 8:00 AM, PHLEBO_ASSIGNED
         → Should trigger: Phlebo Dispatch Check (30 min before)
         → Testing early morning appointment

INJECTION ORDERS:
─────────────────
2000010: TODAY at 3:00 PM, PHLEBO_ASSIGNED
         → Should trigger: Assign Medic (immediate)
         → Then: Pre-visit Confirmation (60 min before)
         → Then: Post-Admin Monitoring (after)

2000011: YESTERDAY at 3:00 PM, PHLEBO_ASSIGNED
         → Should trigger: Pre-visit (if still eligible), Post-Admin
         → Testing injection from yesterday


HOW TO TEST:
────────────

STEP 1: Create orders (copy specific INSERT blocks you want to test)
STEP 2: Wait for poller cycle (5 min) or trigger manually
STEP 3: Validate tasks were created:
        psql < tests/fixtures/validate-tasks-created.sql
STEP 4: Update order statuses to simulate progression:
        UPDATE public."Order" SET "orderStatus" = 'PHLEBO_ASSIGNED' WHERE id = 2000000;
STEP 5: Wait for next poller cycle
STEP 6: Check new tasks created based on status change
STEP 7: Validate complete flow with:
        psql < tests/fixtures/validate-tasks-created.sql


SCENARIO PROGRESSIONS:
──────────────────────

SCENARIO A: Full HSC Today Flow (Recommended for first test)
─────────────────────────────────────────────────────────
1. Create order 2000000 (ORDER_SCHEDULED, TODAY 2 PM)
   → Poller creates: Confirm Booking, Assign Phlebo
2. Update: PHLEBO_ASSIGNED
   → Poller creates: Phlebo Dispatch Check
3. Update: PHLEBO_DISPATCHED
   → Poller creates: Confirm Collected, Patient Missed (time-based)
4. Update: SAMPLE_COLLECTED
   → Poller creates: Sample Handover, Report Follow-up
5. Update: SAMPLE_RECEIVED
   → Poller finalizes: Report Follow-up

SCENARIO B: Stale Order Follow-up Test
────────────────────────────────────────
1. Create order 2000001 (ORDER_SCHEDULED, YESTERDAY 2 PM)
2. Wait 120+ minutes in simulation
   → Poller creates: Stale Order Follow-up
3. Demonstrates how old unupdated orders trigger escalation

SCENARIO C: Injection Today Flow
──────────────────────────────────
1. Create order 2000010 (INJECTION, TODAY 3 PM)
   → Poller creates: Assign Medic
2. After creation, update when medic assigned:
   UPDATE public."Order" SET "orderStatus" = 'MEDIC_ASSIGNED' WHERE id = 2000010;
   → Poller creates: Pre-visit Confirmation (60 min before)
3. After injection administered:
   → Poller creates: Post-Admin Monitoring


TESTING QUICK COMMANDS:
────────────────────────

# Copy and paste specific INSERT blocks from sections above
# Execute only the orders you want to test

# View created test orders:
SELECT id, "orderType", "orderStatus", "appointmentTime"
FROM public."Order" WHERE id >= 2000000 ORDER BY id;

# Check tasks created from test orders:
SELECT COUNT(*), "orderType" FROM taskos.tasks
WHERE "entityId" >= 2000000 GROUP BY "orderType";

# Update order status (to progress the scenario):
UPDATE public."Order" SET "orderStatus" = 'PHLEBO_ASSIGNED' WHERE id = 2000000;

# Check polling logs:
SELECT * FROM taskos."PollingLog" ORDER BY "startedAt" DESC LIMIT 3;

# Full validation:
psql < tests/fixtures/validate-tasks-created.sql

*/

