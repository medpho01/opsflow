-- ============================================================================
-- TEST INJECTION ORDERS - Task Rules Validation
-- ============================================================================
-- Database: PostgreSQL
-- Schema: taskos
-- Purpose: Create and update test orders to trigger Injection service rules
-- ============================================================================

-- ============================================================================
-- 1. CREATE TEST ORDERS
-- ============================================================================

-- TEST ORDER #1: For "Assign Medic - Home Injection" Rule
-- Trigger: ORDER_SCHEDULED status
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-001',
  'INJECTION',
  'ORDER_SCHEDULED',
  1,
  'Test Patient 001 - Assign Medic',
  '2026-05-03T14:00:00+05:30',
  '2026-05-02T06:45:00+05:30',
  '2026-05-02T06:45:00+05:30',
  'LABSTACK-INJ-001',
  '{"serviceType": "INJECTION", "location": "HOME", "ageGroup": "ADULT"}'::jsonb
);

-- TEST ORDER #2: For "Pre-visit Confirmation" Rule
-- Trigger: PHLEBO_ASSIGNED status + appointment within 60 minutes
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-002',
  'INJECTION',
  'PHLEBO_ASSIGNED',
  2,
  'Test Patient 002 - Pre-visit Confirm',
  '2026-05-02T07:30:00+05:30',  -- 45 minutes from now (within 60 min window)
  '2026-05-02T06:30:00+05:30',
  '2026-05-02T06:45:00+05:30',
  'LABSTACK-INJ-002',
  '{"serviceType": "INJECTION", "location": "HOME", "phleboAssigned": true}'::jsonb
);

-- TEST ORDER #3: For "Post-Admin Monitoring" Rule
-- Trigger: SAMPLE_COLLECTED status + 30+ minutes since status update
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-003',
  'INJECTION',
  'SAMPLE_COLLECTED',
  3,
  'Test Patient 003 - Post-Admin Monitor',
  '2026-05-02T07:00:00+05:30',
  '2026-05-02T05:30:00+05:30',
  '2026-05-02T06:00:00+05:30',  -- 45 minutes ago (> 30 min threshold)
  'LABSTACK-INJ-003',
  '{"serviceType": "INJECTION", "location": "HOME", "injectionAdministered": true}'::jsonb
);

-- ============================================================================
-- 2. UPDATE ORDERS TO TEST DIFFERENT TRIGGER CONDITIONS
-- ============================================================================

-- UPDATE ORDER #1: Move to PHLEBO_ASSIGNED to trigger Pre-visit Confirmation
UPDATE "Order"
SET
  status = 'PHLEBO_ASSIGNED',
  "statusUpdatedAt" = '2026-05-02T06:50:00+05:30',
  "updatedAt" = NOW()
WHERE id = 'test-inj-order-001';

-- UPDATE ORDER #2: Move to SAMPLE_COLLECTED for Post-Admin Monitoring
UPDATE "Order"
SET
  status = 'SAMPLE_COLLECTED',
  "statusUpdatedAt" = '2026-05-02T06:00:00+05:30',  -- 45+ min ago
  "updatedAt" = NOW()
WHERE id = 'test-inj-order-002';

-- UPDATE ORDER #3: Move to next status (SAMPLE_DELIVERED)
UPDATE "Order"
SET
  status = 'SAMPLE_DELIVERED',
  "statusUpdatedAt" = NOW(),
  "updatedAt" = NOW()
WHERE id = 'test-inj-order-003';

-- ============================================================================
-- 3. VERIFY TEST ORDERS WERE CREATED
-- ============================================================================

-- Check created test orders
SELECT
  id,
  "orderType",
  status,
  "patientName",
  "appointmentTime",
  "statusUpdatedAt",
  metadata
FROM "Order"
WHERE id LIKE 'test-inj-order-%'
ORDER BY "createdAt" DESC;

-- ============================================================================
-- 4. CHECK IF TASKS WERE CREATED FOR TEST ORDERS
-- ============================================================================

-- Find tasks created for Injection orders
SELECT
  t.id,
  t.title,
  t."taskTypeId",
  t."orderId",
  t."createdAt",
  tt.label as "taskTypeLabel"
FROM "Task" t
LEFT JOIN "TaskType" tt ON t."taskTypeId" = tt.id
WHERE t."orderId" LIKE 'test-inj-order-%'
ORDER BY t."createdAt" DESC;

-- ============================================================================
-- 5. CLEANUP - DELETE TEST DATA (OPTIONAL)
-- ============================================================================

-- DELETE test orders (be careful!)
-- DELETE FROM "Order" WHERE id LIKE 'test-inj-order-%';

-- DELETE tasks created by test orders
-- DELETE FROM "Task" WHERE "orderId" LIKE 'test-inj-order-%';

-- ============================================================================
-- 6. ADVANCED TEST SCENARIOS
-- ============================================================================

-- SCENARIO A: Create order with future appointment (should not trigger immediately)
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-future',
  'INJECTION',
  'ORDER_SCHEDULED',
  4,
  'Test Patient - Future Appt',
  '2026-05-05T14:00:00+05:30',  -- 3 days away
  '2026-05-02T06:45:00+05:30',
  '2026-05-02T06:45:00+05:30',
  'LABSTACK-INJ-FUTURE',
  '{"serviceType": "INJECTION", "location": "HOME"}'::jsonb
);

-- SCENARIO B: Create order with past appointment (should trigger immediately)
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-past',
  'INJECTION',
  'ORDER_SCHEDULED',
  5,
  'Test Patient - Past Appt',
  '2026-05-02T06:00:00+05:30',  -- 45 minutes ago
  '2026-05-02T05:00:00+05:30',
  '2026-05-02T05:00:00+05:30',
  'LABSTACK-INJ-PAST',
  '{"serviceType": "INJECTION", "location": "HOME"}'::jsonb
);

-- SCENARIO C: Rapid status transitions to test multiple rule triggers
INSERT INTO "Order" (
  id,
  "orderType",
  status,
  "patientId",
  "patientName",
  "appointmentTime",
  "createdAt",
  "statusUpdatedAt",
  "labstackOrderId",
  metadata
) VALUES (
  'test-inj-order-cascade',
  'INJECTION',
  'ORDER_SCHEDULED',
  6,
  'Test Patient - Cascade',
  '2026-05-02T07:15:00+05:30',
  '2026-05-02T06:45:00+05:30',
  '2026-05-02T06:45:00+05:30',
  'LABSTACK-INJ-CASCADE',
  '{"serviceType": "INJECTION", "location": "HOME"}'::jsonb
);

-- Later, update to PHLEBO_ASSIGNED
-- UPDATE "Order" SET status = 'PHLEBO_ASSIGNED', "statusUpdatedAt" = NOW() WHERE id = 'test-inj-order-cascade';

-- Then update to SAMPLE_COLLECTED (wait 30+ min before this update)
-- UPDATE "Order" SET status = 'SAMPLE_COLLECTED', "statusUpdatedAt" = NOW() WHERE id = 'test-inj-order-cascade';

-- ============================================================================
-- 7. QUERY TO MONITOR RULE EXECUTION
-- ============================================================================

-- Check which rules were evaluated for test orders
SELECT
  o.id as "orderId",
  o.status,
  o."patientName",
  COUNT(t.id) as "tasksCreated",
  STRING_AGG(DISTINCT tt.label, ', ') as "taskTypes"
FROM "Order" o
LEFT JOIN "Task" t ON o.id = t."orderId"
LEFT JOIN "TaskType" tt ON t."taskTypeId" = tt.id
WHERE o.id LIKE 'test-inj-order-%'
GROUP BY o.id, o.status, o."patientName"
ORDER BY o."createdAt" DESC;

-- ============================================================================
-- NOTES FOR TESTING
-- ============================================================================
/*

RULE TRIGGER ANALYSIS:

1. "Assign Medic - Home Injection" (ID: 3aa2c6ae...)
   - Requires: status = ORDER_SCHEDULED
   - Expected Action: Task created immediately
   - Test Order: test-inj-order-001
   - Verify: Check tasks table for "INJ_ASSIGN_MEDIC" task type

2. "Pre-visit Confirmation" (ID: 114d3918...)
   - Requires: status = ORDER_SCHEDULED or PHLEBO_ASSIGNED + appointment within 60 min
   - Expected Action: Task created when appointment is ≤60 min away
   - Test Order: test-inj-order-002 (appointed in 45 min)
   - Verify: Check for "INJ_PRE_VISIT_CONFIRM" task type

3. "Post-Admin Monitoring" (ID: 29e54572...)
   - Requires: status = SAMPLE_COLLECTED + statusUpdatedAt ≤ 30 minutes ago
   - Expected Action: Task created after 30 minutes in current status
   - Test Order: test-inj-order-003 (status updated 45 min ago)
   - Verify: Check for "INJ_POST_ADMIN_MONITOR" task type

EXECUTION STEPS:

1. Run INSERT statements to create test orders
2. Wait for the next poller cycle (usually every 5 minutes)
3. Check the tasks table for created tasks
4. Run UPDATE statements to transition orders through statuses
5. Verify that appropriate tasks are created for each status transition

IMPORTANT TIMESTAMPS:
- Use '+05:30' timezone offset for IST (India Standard Time)
- Ensure statusUpdatedAt is set correctly for timing-based triggers
- For 30-minute rule: statusUpdatedAt must be ≥ 30 minutes in the past

*/
