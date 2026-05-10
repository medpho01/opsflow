# OpsFlow Demo & Rule Smoke Test

Reusable scaffolding to seed synthetic orders into labstack source tables, trigger the OpsFlow engine, and assert which tasks the rules created. Use it for:

- **Live demos** — show the team end-to-end: source row → rule fires → task assigned → SLA countdown
- **Regression testing** — catch rule changes that break the existing matrix
- **Onboarding** — new engineers can read this directory to understand the rule engine

## Files
| File | Purpose |
|---|---|
| `run-demo.sh` | Orchestrator: `seed`, `poll`, `verify`, `cleanup`, `status`, `demo` |
| `seed-orders.sql` | Idempotent inserts into `public."Order"`, `public."Appointment"`, `public."PharmaOrder"` |
| `cleanup.sql` | Removes demo rows AND tasks generated from them |
| `verify.ts` | Compares actual tasks to expectations, prints pass/fail |
| `EXPECTED_TASKS.md` | Human-readable expectation table |

## Prerequisites
- The OpsFlow Docker stack is up (`docker compose up -d` from repo root)
- The labstack DB is reachable from inside the container (verify with `./run-demo.sh status`)

## Quickstart — one-shot demo
```bash
./tests/demo/run-demo.sh demo
```
Runs `cleanup → seed → poll → verify` and prints a colored pass/fail table. Total runtime: ~5 seconds.

## Step-by-step (for live presenting)
```bash
# 1. Show baseline (no demo rows yet)
./tests/demo/run-demo.sh status

# 2. Insert 23 synthetic source rows
./tests/demo/run-demo.sh seed

# 3. Show in the UI: open http://localhost:3000/head/data-sources — the
#    poll-health card will show new rows fetched. Then trigger the engine:
./tests/demo/run-demo.sh poll

# 4. Show in the UI: http://localhost:3000/head/tasks — 13 new tasks appear.
#    Click into any task to show the detail drawer with patient + order context.

# 5. Verify programmatically
./tests/demo/run-demo.sh verify

# 6. Reset for the next demo
./tests/demo/run-demo.sh cleanup
```

## Reserved ID range
All demo rows use IDs **8800001..8800099** across `Appointment`, `Order`, and `PharmaOrder`. Cleanup is double-scoped (ID range + `internalNotes LIKE '[DEMO-OPSFLOW]%'`) to make accidental damage to real labstack data impossible.

## What the seed covers
**23 source rows → 13 expected tasks**, exercising:

- Every active rule (R1–R9 fire at least once across the 13 tasks)
- Multi-rule matches (e.g., `PHLEBO_ASSIGNED` fires both R1 and R2)
- Type-mismatch negatives (CAMP / KIT_BASED / ONLINE rows produce no tasks)
- Status-mismatch negatives (DELAYED / RESCHEDULED produce no tasks)
- Terminal-status negatives (COMPLETED / REPORT_DELIVERED / CANCELED skipped)
- Any-type rules (R6 fires on `HOME_VISIT` too because `allowedTypes=[]`)
- A source with no active rules (PharmaOrder rows are ingested but no tasks)

See [EXPECTED_TASKS.md](./EXPECTED_TASKS.md) for the full table.

## Adapting to new rules
When you add a new rule:

1. Add a row to the matrix in `EXPECTED_TASKS.md`.
2. Add the corresponding `INSERT` to `seed-orders.sql` (use a new ID in the 8800001..8800099 range).
3. Add a new line to `EXPECTATIONS` in `verify.ts`.
4. Run `./run-demo.sh demo` and confirm 0 fails.

## Re-running mid-demo
Both `seed-orders.sql` and the engine itself are idempotent:

- `seed-orders.sql` uses `ON CONFLICT (id) DO NOTHING` — re-running is safe
- The engine de-duplicates by `(taskRuleId, entityId)` unique constraint — re-polling does not create duplicate tasks

To start over from a known empty baseline, run `./run-demo.sh cleanup` first.

## Troubleshooting
**`./run-demo.sh poll` returns `success: true` but `verify` shows 0 tasks** — the poller may have run before you seeded. Check `docker compose logs app | grep Poller` for cycle timing. Re-running `poll` after seeding always works.

**Tasks aren't created for a row that should match** — confirm the rule is active in `/head/rules` and the row's status is one of the rule's `triggerCondition.statusIn`. The engine logs each cycle's "0 active orders fetched" / "N tasks created" — check `docker compose logs app --tail 30`.

**`psql: error: connection refused`** — the labstack DB stopped. Verify with `docker compose ps` and `pg_isready -h host.docker.internal -p 5432`.

**`unique violation` on seed** — an old demo row is wedged. Run `./run-demo.sh cleanup` and retry.
