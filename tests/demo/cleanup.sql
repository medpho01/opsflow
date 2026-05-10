-- OpsFlow Demo — remove all seeded demo orders and their generated tasks.
--
-- Safe to run repeatedly. Operates only on the reserved 8800001..8800099
-- ID range AND rows tagged '[DEMO-OPSFLOW]' in internalNotes — both checks
-- are required, so a real labstack row that happens to be in that range
-- (shouldn't ever exist) wouldn't be touched.

BEGIN;

-- 1. Delete OpsFlow tasks that reference demo orders. The engine stores
--    entityType in upper-snake-case (e.g., ORDER, APPOINTMENTS) which
--    differs from the data-source sourceId ("Lab Orders") — match all
--    of them by ID range alone, which is safe given the reserved
--    8800001..8800099 range.
DELETE FROM taskos.tasks
WHERE "entityId" BETWEEN 8800001 AND 8800099;

-- 2. Delete the labstack source rows (tagged + ID-bounded).
DELETE FROM public."Order"
WHERE id BETWEEN 8800001 AND 8800099
  AND "internalNotes" LIKE '[DEMO-OPSFLOW]%';

DELETE FROM public."Appointment"
WHERE id BETWEEN 8800001 AND 8800099
  AND "internalNotes" LIKE '[DEMO-OPSFLOW]%';

DELETE FROM public."PharmaOrder"
WHERE id BETWEEN 8800001 AND 8800099
  AND "internalNotes" LIKE '[DEMO-OPSFLOW]%';

COMMIT;

\echo '🧹 Demo orders + tasks cleaned up.'
