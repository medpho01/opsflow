-- OpsFlow Demo — seed orders that exercise every active task rule.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. To start fresh run cleanup.sql.
-- Reserved ID range: 8800001..8800099 across Appointment / Order / PharmaOrder.
-- All demo rows tagged with internalNotes='[DEMO-OPSFLOW]' for safe cleanup.
--
-- Run via:
--   ./tests/demo/run-demo.sh seed
-- or directly:
--   docker compose exec -T app sh -c 'psql "$(echo $DATABASE_URL | sed "s/?schema=[^&]*//")" -f /app/tests/demo/seed-orders.sql'

\set DEMO_USER_ID 27        -- existing labstack user (re-used for all demo orders)
\set DEMO_STORE_ID 3        -- existing store
\set DEMO_LAB_ID 4          -- existing lab

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- LAB ORDERS (public.Order) — 10 rows, 8800001..8800010
-- ────────────────────────────────────────────────────────────────────────

-- Timing conditions to be aware of (from the active rules):
--   • R1 Pre-Visit             — no timing
--   • R2 Confirm New Order     — no timing
--   • R8 Collection Follow-Up  — minutesAfterAppointment ≥ 30 (appt must be ≥30m past)
--   • R9 Sample Delivery Check — minutesSinceStatusUpdated ≥ 30 (status held ≥30m)
--   • R4 Capture ETA, R5 Follow-Up — no timing
-- The seed below picks appointmentTime / statusUpdatedAt to satisfy each
-- rule's timing condition for the rows where it should fire.
INSERT INTO public."Order" (
  id, "orderType", "appointmentTime", "orderStatus",
  "storeId", "labId", "userId", "createdAt", "updatedAt", "statusUpdatedAt",
  "assignedBy", "internalNotes", "phleboName",
  "sentCommunicationCancelled", "sentCommunicationCreated",
  "sentCommunicationOrderScheduled", "sentCommunicationPhleboAssigned",
  "sentCommunicationReportDelivered", "sentCommunicationRescheduled",
  "sentCommunicationKitDispatched",
  "sentFeedbackOrderCompleted", "sentFeedbackSampleCollected"
) VALUES
  -- 8800001: ORDER_SCHEDULED, future appt → fires R1 (Pre-Visit) + R2 (Confirm New Order)
  (8800001, 'HOME_SAMPLE',  NOW() + INTERVAL '4 hours', 'ORDER_SCHEDULED',  3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] R1+R2: ORDER_SCHEDULED', NULL,         false,false,false,false,false,false,false,false,false),
  -- 8800002: PHLEBO_ASSIGNED, appt was 2h ago → fires R1 + R8 (Collection FU passes minutesAfterAppointment≥30)
  (8800002, 'HOME_SAMPLE',  NOW() - INTERVAL '2 hours', 'PHLEBO_ASSIGNED',  3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] R1+R8: appt 2h past',   'Demo Phlebo', false,false,false,false,false,false,false,false,false),
  -- 8800003: SAMPLE_COLLECTED, appt 3h ago + status set 45m ago → fires R8 (Collection FU) + R9 (Sample Delivery)
  (8800003, 'HOME_SAMPLE',  NOW() - INTERVAL '3 hours', 'SAMPLE_COLLECTED', 3, 4, 27, NOW(), NOW(), NOW() - INTERVAL '45 minutes', 'demo', '[DEMO-OPSFLOW] R8+R9: status 45m old', 'Demo Phlebo', false,false,false,false,false,false,false,false,false),
  -- 8800004: SAMPLE_DELIVERED → fires R4 (Capture ETA, no timing)
  (8800004, 'HOME_SAMPLE',  NOW() - INTERVAL '1 day',   'SAMPLE_DELIVERED', 3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] R4',                    'Demo Phlebo', false,false,false,false,false,false,false,false,false),
  -- 8800005: SAMPLE_PROCESSED → fires R5 (Report Follow-Up, no timing)
  (8800005, 'HOME_SAMPLE',  NOW() - INTERVAL '1 day',   'SAMPLE_PROCESSED', 3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] R5',                    'Demo Phlebo', false,false,false,false,false,false,false,false,false),
  -- Negative cases below (should not produce any tasks)
  (8800006, 'HOME_SAMPLE',  NOW() + INTERVAL '1 day',   'REPORT_DELIVERED', 3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] terminal',              'Demo Phlebo', false,false,false,false,false,false,false,false,false),
  (8800007, 'CENTER_VISIT', NOW() + INTERVAL '1 day',   'ORDER_SCHEDULED',  3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] type mismatch',         NULL,         false,false,false,false,false,false,false,false,false),
  (8800008, 'CAMP',         NOW() + INTERVAL '1 day',   'PHLEBO_ASSIGNED',  3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] type mismatch',         'Demo Phlebo',false,false,false,false,false,false,false,false,false),
  (8800009, 'KIT_BASED',    NOW() + INTERVAL '1 day',   'SAMPLE_COLLECTED', 3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] type mismatch',         NULL,         false,false,false,false,false,false,false,false,false),
  (8800010, 'HOME_SAMPLE',  NOW() + INTERVAL '1 day',   'CANCELED',         3, 4, 27, NOW(), NOW(), NOW(),                          'demo', '[DEMO-OPSFLOW] terminal',              NULL,         false,false,false,false,false,false,false,false,false)
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- APPOINTMENTS (public.Appointment) — 10 rows, 8800001..8800010
-- ────────────────────────────────────────────────────────────────────────

INSERT INTO public."Appointment" (
  id, user_id, "appointmentType", "appointmentStatus",
  "appointmentDate", "createdAt", "updatedAt",
  "internalNotes", "isWalkIn", "isExternal"
) VALUES
  (8800001, 27, 'CENTER_VISIT', 'CREATED',     NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R6: CREATED', false, false),
  (8800002, 27, 'CENTER_VISIT', 'PENDING',     NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R6: PENDING', false, false),
  (8800003, 27, 'CENTER_VISIT', 'CONFIRMED',   NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R7+R8: CONFIRMED', false, false),
  (8800004, 27, 'CENTER_VISIT', 'CHECKED_IN',  NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R9: CHECKED_IN', false, false),
  (8800005, 27, 'CENTER_VISIT', 'COMPLETED',   NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] terminal (COMPLETED)', false, false),
  (8800006, 27, 'HOME_VISIT',   'CREATED',     NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R6 fires on HOME_VISIT (any-type)', false, false),
  (8800007, 27, 'ONLINE',       'CONFIRMED',   NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] R7/R8 require CENTER_VISIT', false, false),
  (8800008, 27, 'CENTER_VISIT', 'CANCELED',    NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] terminal (CANCELED)', false, false),
  (8800009, 27, 'CENTER_VISIT', 'DELAYED',     NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] no rule for DELAYED', false, false),
  (8800010, 27, 'CENTER_VISIT', 'RESCHEDULED', NOW() + INTERVAL '1 day', NOW(), NOW(), '[DEMO-OPSFLOW] no rule for RESCHEDULED', false, false)
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- PHARMAORDER (public.PharmaOrder) — 3 rows, 8800001..8800003
-- Source is registered but currently has no active task rules — these rows
-- demonstrate "source ingested, no rule fired".
-- ────────────────────────────────────────────────────────────────────────

INSERT INTO public."PharmaOrder" (
  id, "storeId", "orderType", "orderStatus", "orderDate",
  "entityType", "entityId", "userId",
  quantities, "pharmacyId",
  "internalNotes", "createdAt", "updatedAt", "paymentStatus"
) VALUES
  (8800001, 3, 'HOME_DELIVERY', 'CREATED',   NOW(), 'STORE', 3, 27, '{"items":[]}'::jsonb, 1, '[DEMO-OPSFLOW] PharmaOrder no-rule source', NOW(), NOW(), 'PENDING'),
  (8800002, 3, 'HOME_DELIVERY', 'CONFIRMED', NOW(), 'STORE', 3, 27, '{"items":[]}'::jsonb, 1, '[DEMO-OPSFLOW]',                            NOW(), NOW(), 'COMPLETED'),
  (8800003, 3, 'PICKUP',        'SHIPPED',   NOW(), 'STORE', 3, 27, '{"items":[]}'::jsonb, 1, '[DEMO-OPSFLOW]',                            NOW(), NOW(), 'COMPLETED')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Reset sequences if they got out-of-sync (idempotent)
SELECT setval(pg_get_serial_sequence('public."Order"',       'id'), GREATEST((SELECT MAX(id) FROM public."Order"),       1));
SELECT setval(pg_get_serial_sequence('public."Appointment"', 'id'), GREATEST((SELECT MAX(id) FROM public."Appointment"), 1));
SELECT setval(pg_get_serial_sequence('public."PharmaOrder"', 'id'), GREATEST((SELECT MAX(id) FROM public."PharmaOrder"), 1));

\echo '✅ Demo orders seeded:'
\echo '   - 10 Lab Orders (8800001-8800010)   — expect 8 tasks (legacy poller)'
\echo '   - 10 Appointments (8800001-8800010) — expect 6 tasks (poll-appointments.ts helper)'
\echo '   -  3 PharmaOrders (8800001-8800003) — expect 0 tasks (no active rules)'
\echo '   ──────────────────────────────────────────────────'
\echo '   Total expected: 14 tasks after next poll cycle.'
