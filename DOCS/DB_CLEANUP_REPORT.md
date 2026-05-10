# Database Schema Cleanup — 2026-05-10

## Tables before: 33
## Tables after: 30 (dropped 3)

## Dropped (with rationale)

- **`checklist_templates`** — model `ChecklistTemplate` declared in schema.prisma but zero `prisma.checklistTemplate.*` calls anywhere in `src/`. Zero rows. The `TaskType.checklistItems` relation was declared but never traversed. Dropped along with the model.
- **`shift_templates`** — table created in `20260425053755_init_taskos_schema` but no Prisma model maps to it. Zero rows. FK from `daily_rosters.shiftId` was harmless (zero rows had a non-null `shiftId`).
- **`team_member_order_types`** — was the source table in `20260509_refactor_datasource_rules.sql` (migrated INTO `team_member_capabilities`). Zero rows, no Prisma model, no code references. Leftover from incomplete migration.

## KEEP_BUT_DOCUMENT (kept despite zero rows / zero Prisma-client refs)

- `polling_locks`, `engine_checkpoints` — used via `$queryRaw` in `src/lib/engine/poller.ts`
- `escalation_chains`, `escalation_levels` — escalations feature wired up; just no chains created yet
- `skill_tags`, `task_checklist_items`, `task_rule_skills`, `task_rule_source_scopes`, `team_member_skills`, `data_source_polling_logs`, `round_robin_states` — feature is implemented and code references exist; just no rows yet

## Kept count: 30

## Verification

| | |
|---|---|
| Backup | `/tmp/taskos-schema-backup.sql` (12.8KB, structural dump) |
| Migration | `prisma/migrations/20260510_drop_unused_tables/migration.sql` |
| Prisma client regenerated | ✓ |
| schema.prisma updated | ✓ (removed `model ChecklistTemplate` + `checklistItems` relation on TaskType) |
| Endpoint smoke test | 11/11 returned 200 (`/api/tasks`, `/team`, `/data-sources`, `/task-rules`, `/alerts`, `/sources/health`, `/stores`, `/skill-tags`, `/task-types`, `/escalations`, `/roster`) |

## Rollback

If anything regresses, restore from backup:
```bash
docker cp /tmp/taskos-schema-backup.sql taskos-app-1:/tmp/restore.sql
docker compose exec -T app sh -c 'CLEAN_URL=$(echo "$DATABASE_URL" | sed "s/?schema=[^&]*//g"); psql "$CLEAN_URL" -f /tmp/restore.sql'
```
