-- One-shot backfill: tag the 521 tasks already auto-retired by the engine
-- (before the metadata flag was introduced) so the UI can show them under
-- "Auto-closed by engine" instead of "Completed by team".
--
-- Detection rule: a task is engine-retired iff it has a CANCELLED-status
-- history entry whose changedById is NULL and whose note starts with
-- "Auto-closed by engine". The retirer sets exactly that signature.
--
-- Run once on the prod DB:
--   docker compose exec db psql -U <user> -d <dbname> -f /path/to/this.sql
-- Or pipe via prisma raw exec.
--
-- Idempotent: running twice is a no-op (jsonb_set just re-writes the same
-- value).

UPDATE taskos."tasks" t
   SET metadata = jsonb_set(
     COALESCE(t.metadata, '{}'::jsonb),
     '{autoRetiredByEngine}',
     'true'::jsonb
   )
  FROM taskos."task_history" h
 WHERE h."taskId" = t.id
   AND h.status = 'CANCELLED'
   AND h."changedById" IS NULL
   AND h.note LIKE 'Auto-closed by engine%'
   AND (t.metadata->>'autoRetiredByEngine') IS DISTINCT FROM 'true';
