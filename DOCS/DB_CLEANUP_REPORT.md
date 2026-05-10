# Database Schema Cleanup — 2026-05-10

## Tables before: 33
## Tables after: 31 (dropped 2)

## Dropped (with rationale)

- **`shift_templates`** — table created in `20260425053755_init_taskos_schema` but no Prisma model maps to it. Zero rows. FK from `daily_rosters.shiftId` was harmless (zero rows had a non-null `shiftId`).
- **`team_member_order_types`** — was the source table in `20260509_refactor_datasource_rules.sql` (migrated INTO `team_member_capabilities`). Zero rows, no Prisma model, no code references. Leftover from incomplete migration.

## Originally proposed but RESTORED
- **`checklist_templates`** — initial audit flagged it as unused based on `grep "prisma.checklistTemplate."`, but it's referenced via Prisma `include: { checklistItems: ... }` in `src/app/api/tasks/route.ts` and `src/app/api/tasks/[id]/route.ts`, plus rendered by `TaskDetailPanel.tsx`. Restored after the initial drop broke the poller (`Unknown field checklistItems for include statement on model TaskType`). Lesson: include-relation use isn't caught by simple model-name grep.

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
