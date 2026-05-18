-- OpsFlow Demo — remove all seeded labstack demo orders.
--
-- This file ONLY touches public.* on the labstack DB. Tasks generated
-- from these orders live in the taskos schema (possibly on a different
-- DB) — those are deleted by tests/demo/cleanup-tasks.sql, run against
-- the taskos DB.
--
-- Safe to run repeatedly. Operates only on the reserved 8800001..8800099
-- ID range AND rows tagged '[DEMO-OPSFLOW]' in internalNotes — both checks
-- are required, so a real labstack row that happens to be in that range
-- (shouldn't ever exist) wouldn't be touched.

BEGIN;

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

\echo '🧹 Labstack demo orders removed.'
