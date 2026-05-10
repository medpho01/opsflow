# 1. Data Sources

> **What it is**: OPS_HEAD registers an external Postgres table as a polling source — picks table, type/status fields, polling interval. The `available-tables`, `table-columns`, `column-enums` APIs auto-discover the schema so the head doesn't write SQL.
>
> **Primary user**: OPS_HEAD
>
> **Verdict**: 🟡 PM · 🟢 Architect · 🟡 QA

## Strengths

- Smart guided picker; auto-generated query template (`SELECT * FROM "T" WHERE updated_at > $1 LIMIT $2`).
- Per-source live status card (last poll, success/fail, tasks-created counter).
- Test-before-save with auto-dismissing 5s banner.
- Toggle to deactivate a source without deleting (preserves history).

## Product gaps (PM)

| Priority | Gap |
|---|---|
| **P0** | **Webhook ingestion missing.** `pollingType` enum exists in schema but UI/POST hard-code `"DATABASE"`. Any source that emits events waits up to N minutes for the next polling cycle. |
| **P1** | **No "preview last 10 rows"** affordance. Head registers a source and has to wait for the next poll to know if they pointed at the right table. |
| **P1** | **No source templates / catalog.** Every registration is from-scratch; no "Pick LabStack — Home Sample" pre-fill. |
| **P1** | **No field-mapping UI.** Title templates rely on metadata fields that may or may not exist — failures render `{{patientName}}` literally with no warning. |
| P2 | No "clone source" for dev/prod or A/B configs. |
| P2 | No source-health alerts ("source has not polled successfully in 30 min"). |
| P2 | No quiet-hours / weekday-only schedule — interval is global. |

## Architecture findings

- **`task_rule_source_scopes` table is dead.** Made dead by 2026-05-09 refactor (`prisma/migrations/20260509_refactor_datasource_rules.sql`). Both relations (`TaskRule.sourceScopes`, `DataSource.ruleScopes`) still wired; table has 0 rows; nothing writes to it. **Drop the table and the relation.**
- **`pollingIntervalMinutes` duplicated** on `DataSource` and `TaskRule`. Legacy poller actually reads `POLLING_INTERVAL_MS` from env and ignores both DB columns. Disabled multi-source scheduler used the DataSource column. **Pick one canonical owner.**
- **`src/lib/polling/` (1,100 LOC) is disabled** in `instrumentation.ts:19-30` because it duplicated work and tripled DB load. Still type-checks and ships in the bundle. **Delete or feature-flag.**

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P0** | **SQL injection** in validate endpoint via `Prisma.raw` interpolation of unquoted column names | `src/app/api/data-sources/validate/route.ts:55-58` |
| 🔴 **P1** | `pollingType` body field silently ignored — hard-coded `"DATABASE"` on insert | `src/app/api/data-sources/route.ts:148` |
| 🟡 P2 | `backfillEnabled \|\| false` and `backfillDays \|\| 7` coerce zero, which is a legitimate value | `src/app/api/data-sources/route.ts:149-150` |
| 🟡 P2 | GET endpoint doesn't return `syncEndpoint` while PUT writes it — round-trip drops the field | `src/app/api/data-sources/[id]/route.ts:109` |
| 🟡 P2 | No regex/format validation on `sourceId`, `tableReference`, column names | POST handler |
| 🟡 P2 | No min/max on `pollingIntervalMinutes` — `0` allowed via the `\|\|` default fallback | POST handler |
| 🟡 P2 | `queryTemplate` stored verbatim — never validated to start with SELECT, never EXPLAIN'd | POST handler |
| 🟡 P2 | All errors return generic `FETCH_ERROR`/`CREATION_ERROR` with no correlation id | All routes |
| 🟡 P2 | Validate endpoint returns 200 on `ok: false` AND on actual errors — caller can't distinguish | `validate/route.ts:95-103` |

## Future PM roadmap (ranked)

1. **Webhook receiver mode** — `/api/webhooks/<sourceId>` URL per source. Move from polling to event-driven where possible. Strategic.
2. **Sample-data preview button** — "Show last 10 rows" on the source card.
3. **Field-mapping UI** — explicit map from source columns to canonical task metadata keys (patientName, phone, appointmentTime, storeId).
4. **Source-template library** — pick from "LabStack — Home Sample", "LabStack — Centre Visit", "LabStack — Injection" and the form pre-fills.
5. **Polling schedule with windows** — "only poll 7am–11pm IST", weekday rules.
6. **Source-health alerts** — auto alert if no successful poll in X min, no rows returned in Y hours, error rate > Z%.
7. **Source-level quotas** — cap tasks-created-per-poll to prevent runaway rule misfires.
8. **Connection re-use** — point two sources at views or filtered subsets without writing SQL.

## Feedback / decisions

> Add notes below — what to prioritize, what to defer, what's wrong, what to add.

-

