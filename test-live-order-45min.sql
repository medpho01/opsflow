-- ============================================================================
-- LIVE TEST: HOME SAMPLE ORDER - 45 MINUTE TIMELINE
-- ============================================================================
-- This script creates a single order with appointment in 45 minutes
-- allowing you to watch task creation in real-time
--
-- USE THIS TO TEST: Task creation as time progresses
-- ============================================================================

-- Step 1: Create the test order
-- Appointment is 45 minutes from NOW()
-- Status: ORDER_SCHEDULED (new order, not yet confirmed)
INSERT INTO public."Order" (
  id, "orderType", "orderStatus", "appointmentTime", "statusUpdatedAt",
  "createdAt", "userId", "storeId", "labId"
)
VALUES (
  3000000,
  'HOME_SAMPLE',
  'ORDER_SCHEDULED',
  NOW() + INTERVAL '45 minutes',
  NOW(),
  NOW(),
  12603,
  6,
  2
)
ON CONFLICT DO NOTHING;

-- Verify the order was created
SELECT
  id,
  "orderType",
  "orderStatus",
  "appointmentTime",
  "createdAt",
  EXTRACT(EPOCH FROM ("appointmentTime" - NOW()))/60::int as minutes_until_appt
FROM public."Order"
WHERE id = 3000000;
