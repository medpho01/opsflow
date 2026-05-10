-- Drop unused tables identified by db-cleanup audit on 2026-05-10
-- Backup at /tmp/taskos-schema-backup.sql before this migration
--
-- Classification rationale:
--   - shift_templates      → table created in 20260425053755_init_taskos_schema
--                            but no Prisma model maps to it (orphan). Zero rows.
--                            FK from daily_rosters.shiftId — zero rows have a non-null
--                            shiftId, so the FK is dropped harmlessly.
--   - team_member_order_types → table was migrated FROM in
--                            20260509_refactor_datasource_rules.sql into
--                            team_member_capabilities. Zero rows, no Prisma model,
--                            no code references. Leftover from incomplete migration.
--
-- Tables KEPT despite zero rows or zero Prisma-client refs:
--   - polling_locks, engine_checkpoints — used via $queryRaw in lib/engine/poller.ts
--   - escalation_chains, escalation_levels, skill_tags, task_checklist_items,
--     task_rule_skills, task_rule_source_scopes, team_member_skills,
--     data_source_polling_logs, round_robin_states — feature is wired up;
--     just no rows yet.

-- Drop FK from daily_rosters before dropping shift_templates (the FK column
-- already allows NULL, but the constraint must go first).
ALTER TABLE taskos.daily_rosters DROP CONSTRAINT IF EXISTS daily_roster_shiftId_fkey;
ALTER TABLE taskos.daily_rosters DROP COLUMN IF EXISTS "shiftId";

DROP TABLE IF EXISTS taskos.shift_templates CASCADE;
DROP TABLE IF EXISTS taskos.team_member_order_types CASCADE;
