# 90-Day Roadmap

Phased plan. Each phase has a clear goal and ~3 weeks of work. Items reference the per-feature audit files for full context.

## Phase 1 — Stabilize (Weeks 1-3)

**Goal**: kill the P0 bugs, lock down auth, unblock setup.

### Bugs (1-2 days of focused work)
1. Fix the 12 P0 bugs in [p0-fixes.md](./p0-fixes.md).

### Authorization sweep (3 days)
2. Introduce `scopeStoreIds(user)` helper.
3. Apply consistently to `/api/tasks`, `/api/tasks/[id]`, `/api/tasks/archive`, `/api/stores`, `/api/dashboard`, `/api/team`.
4. Add OPS_HEAD-only checks where missing.
5. Add role enum validation to `/api/team` POST/PATCH.

### Validation sweep (2 days)
6. zod-validate all POST/PATCH bodies (role enum, priority enum, status enum, `triggerCondition`, `metadataCondition`, time format).
7. Whitelist column names in `data-sources/validate` (kills SQL injection).

### Setup ergonomics (2 days)
8. `.env.example` + remove `.env` from git + rotate JWT secret.
9. Pick one of `next.config.{ts,js}`.
10. Convert all standalone `.sql` files in `prisma/migrations/` to proper Prisma migration directories.
11. Fix `prisma/seed.ts` import; remove `OrderType` reference.
12. README with bootstrap commands.

### Closing the closed-loop break (3 days)
13. Add Skills tab to Team drawer (creates skills + assigns to members) — see [feature 03](./features/03-team.md).

### Test scaffolding starter (2 days)
14. Auth/role matrix tests for every API endpoint (would have caught most P0s).
15. `computeRosterStatus` table tests across IST/UTC, midnight rollovers, break windows, exception priority.

**Deliverable**: clean baseline. Production-deployable. No data leaks. Setup-from-scratch works.

---

## Phase 2 — Strengthen (Weeks 4-6)

**Goal**: fix scalability, kill duplication, harden timezones.

### Engine performance (4 days)
1. Pre-load active-task `Set<"ruleId|entityId">` for `isDuplicate` (kills the N+1 — see [feature 04](./features/04-task-creation-assignment.md)).
2. Batch `pickAssignee` — single SQL query with `LATERAL` joins for skills/capabilities + window function for round-robin.
3. Wrap `createTask` in `prisma.$transaction`.
4. Switch polling lock to `pg_try_advisory_lock(1000)` (session-bound, auto-releases).
5. Add `WHERE updated_at > $since` to `fetchAllActiveOrders`; persist checkpoint to `polling_checkpoint`.
6. Add missing indexes: `(taskRuleId, entityId, isArchived)` partial; `(assignedToId, status)`.

### Dead code removal (2 days)
7. Delete `task_rule_source_scopes` table+model.
8. Delete `src/lib/polling/` (1,100 LOC disabled multi-source).
9. Delete `_backup.tsx`/`_v2.tsx` siblings.
10. Drop `team_member_order_types` table.
11. Drop `RoundRobinState.orderType` column; remove the band-aid migration.

### Roster consolidation (3 days)
12. Single canonical call site to `computeRosterStatus`.
13. Delete the three duplicate impls (`analytics/agents/route.ts`, `lib/task-creation/roster-validator.ts`, `dashboard` direct read).
14. Decide on `daily_rosters` vs `weekly_schedules`+`roster_exceptions` (recommendation: drop `daily_rosters`).

### Timezone hardening (3 days)
15. Standardise on `Date.UTC` and `Intl.DateTimeFormat` for IST clock; ESLint rule banning `setHours`/`getDay`/`toTimeString`.
16. Add startup check: `SHOW TIMEZONE` must be `Asia/Kolkata` or fail boot.
17. (Optional) Add SQL view `public.v_orders_utc` returning `TIMESTAMPTZ` so JS layer doesn't need `correctISTTimestamp`.

### Test coverage expansion (3 days)
18. Engine + rule evaluation property tests.
19. Integration test: full poll cycle with known fixtures.

**Deliverable**: 10x scale headroom. Single source of truth for roster. Timezone-correct under any deploy.

---

## Phase 3 — Extend (Weeks 7-10)

**Goal**: unlock the high-leverage product features.

### The agent execution console (5 days) — biggest single product investment
1. SOP per TaskType (rich text body on `task_types` table; rendered in TaskDetailPanel).
2. "Why this task?" panel — rule + matched trigger condition + order field values.
3. Customer 360 sidebar (past 5 orders for this patient, last 3 outcomes, complaint flags).
4. Clickable phone (`tel:` + `wa.me/<phone>?text=<template>`).
5. Order timeline visual (BOOKED → CONFIRMED → … with timestamps).
6. Structured outcome capture at completion (feeds analytics).
7. Snooze ("ping me in 15 min").
8. See [feature 05](./features/05-all-tasks.md) for full list.

### Rule authoring (4 days)
9. **Rule simulator** — "run this rule against the last 100 orders, show me which would fire". Highest authoring-time leverage.
10. **Clone rule** button.
11. **Rule template library** ("Confirm new booking", "Stale follow-up", per source-type).
12. Metadata-field autocomplete from sample orders.

### Onboarding artifacts (3 days)
13. First-login welcome modal per role.
14. "Setup Progress" widget on Command Center.
15. Inline tooltips on every empty state.
16. Driver.js guided tour, re-runnable from Help menu.
17. Sample-data toggle ("Populate demo orders for 24h").

### Filter & navigation (2 days)
18. Saved filter views on All Tasks ("My SLA risks", "Unassigned > 30 min").
19. Drill-in on every Command Center KPI tile.

### Team (2 days)
20. CSV bulk import.
21. Team weekly heatmap.

**Deliverable**: agent productivity multiplier. Rule authoring 5x faster. New install live in 15 minutes.

---

## Phase 4 — Polish & realtime (Weeks 11-13)

**Goal**: near-realtime UX, observability, scale prep.

### Realtime (4 days)
1. **SSE + Postgres LISTEN/NOTIFY** — see [appendix-realtime.md](./appendix-realtime.md).
2. Replace 60s polling on Command Center, Store Overview, All Tasks.

### Source health & engine observability (3 days)
3. Source health card + alerting on stale polls.
4. Per-rule fire log ("fired 12 today, skipped 4 dedupe, 0 timing").
5. **Engine dry-run / replay tool** — apply rules against historical orders without creating tasks.
6. Per-rule metrics dashboard.

### Analytics depth (3 days)
7. Source-level analytics (the missing dimension).
8. Rule-level analytics (false-positive rate from cancelled tasks).
9. Store-level trend (not just current state).
10. CSV / chart export.

### Engine completeness (3 days)
11. Implement the assignment strategies users see in the dropdown (round_robin, store_affinity, skill_based).
12. Throttle / batching (max-tasks-per-poll, max-tasks-per-rule-per-hour).
13. **Webhook ingestion mode** for event-driven sources.

**Deliverable**: production-grade ops platform.

---

## Roadmap dependency graph

```
P1 Stabilize ──→ P2 Strengthen ──→ P3 Extend ──→ P4 Polish
   (P0 bugs,         (engine perf,     (agent UX,       (realtime,
    auth, setup,      timezones,        rule simulator,  webhooks,
    seed, skills)     dead code)        onboarding)      analytics)
```

Each phase is roughly 3 weeks (~15 person-days). No phase strictly blocks the next, but the dependency arrows above are the recommended order — Phase 2 fixes are easier with a clean Phase 1 baseline; Phase 3 is more meaningful when scale isn't a concern; Phase 4 needs the agent UX in place to be worth shipping.

## Feedback / decisions

> Re-prioritize phases or specific items below.

-

