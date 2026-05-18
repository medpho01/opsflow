-- OpsFlow Demo — remove tasks generated from demo orders.
--
-- This file is run against the TASKOS DB (DATABASE_URL). The companion
-- cleanup.sql operates against the LABSTACK source DB.
-- Entity IDs are tracked in the reserved 8800001..8800099 range; tasks
-- engine creates with those entityIds are demo-derived.

BEGIN;

DELETE FROM taskos.tasks
WHERE "entityId" BETWEEN 8800001 AND 8800099;

COMMIT;

\echo '🧹 Demo tasks (taskos) removed.'
