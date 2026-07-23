-- Unify analytics config into the single source definition.
--
-- Before this, the Source Load panel read its per-source contract from a
-- hardcoded code registry (lib/analytics/sourceRegistry.ts), separate from
-- the data_sources table that drives polling — so registering a source in
-- the UI did NOT make it appear in analytics (the confusion of 23 Jul).
-- One nullable JSON column carries the analytics-only bits; table / status
-- / dimension are derived from existing columns.

ALTER TABLE taskos.data_sources
  ADD COLUMN IF NOT EXISTS "analyticsConfig" JSONB;

-- Backfill the four existing sources with the values the code registry
-- held (verified against the live replica schema + status vocabularies,
-- 22 Jul). Matched by tableReference so it's robust to whatever sourceId
-- each was registered under. Only sets rows that don't already have a
-- config, so re-running is safe.

UPDATE taskos.data_sources SET "analyticsConfig" = jsonb_build_object(
  'eventTimeField', 'appointmentTime',
  'createdField',   'createdAt',
  'eventTimeLabel', 'appointment time',
  'lookaheadDays',  7,
  'statusFulfilled', jsonb_build_array('REPORT_DELIVERED'),
  'statusFailed',    jsonb_build_array('CANCELED', 'PATIENT_MISSED')
) WHERE "tableReference" LIKE '%"Order"%' AND "analyticsConfig" IS NULL;

UPDATE taskos.data_sources SET "analyticsConfig" = jsonb_build_object(
  'eventTimeField', 'createdAt',
  'createdField',   'createdAt',
  'eventTimeLabel', 'creation time',
  'lookaheadDays',  0,
  'statusFulfilled', jsonb_build_array('Ordered', 'RESOLVED', 'CLOSED', 'COMPLETED', 'FULFILLED', 'DONE'),
  'statusFailed',    jsonb_build_array('REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED')
) WHERE "tableReference" LIKE '%"Request"%' AND "analyticsConfig" IS NULL;

UPDATE taskos.data_sources SET "analyticsConfig" = jsonb_build_object(
  'eventTimeField', 'appointmentTime',
  'createdField',   'createdAt',
  'eventTimeLabel', 'appointment time',
  'lookaheadDays',  7,
  'statusFulfilled', jsonb_build_array('COMPLETED', 'FULFILLED', 'DONE', 'REPORT_DELIVERED'),
  'statusFailed',    jsonb_build_array('CANCELLED', 'CANCELED', 'NO_SHOW', 'PATIENT_MISSED', 'EXPIRED')
) WHERE "tableReference" LIKE '%"Appointment"%' AND "analyticsConfig" IS NULL;

UPDATE taskos.data_sources SET "analyticsConfig" = jsonb_build_object(
  'eventTimeField', 'orderDate',
  'createdField',   'createdAt',
  'eventTimeLabel', 'order date',
  'lookaheadDays',  7,
  'statusFulfilled', jsonb_build_array('FULL_DELIVERED', 'PARTIAL_DELIVERED'),
  'statusFailed',    jsonb_build_array('CANCELLED', 'CANCELED', 'REJECTED', 'RETURNED')
) WHERE "tableReference" LIKE '%"PharmaOrder"%' AND "analyticsConfig" IS NULL;
