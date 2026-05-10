# Appendix — Test Coverage Plan

## Existing automated tests

- `src/lib/polling/__tests__/integration.test.ts` — single integration test (polling).
- `tests/fixtures/*.sql` — manual SQL fixtures, not automated.
- Numerous `validate-*.sh` shell scripts and `validate-task-creation.ts` — manual smoke harnesses, not running in CI.

## Coverage gaps

Effectively zero on:
- All API routes (data-sources, tasks, task-rules, team, dashboard, analytics).
- `evaluateAndCreateTasks` rule evaluation matrix.
- `pickAssignee` round-robin and roster filtering.
- `computeRosterStatus` time/timezone edge cases.
- `correctISTTimestamp` correctness.
- All UI components.
- Authorization matrix (role × endpoint).

## Recommended priority order

### Tier 1 — would have caught most P0s (Week 1)

1. **Auth/role matrix tests for every API endpoint.** One per endpoint × role; assert 403 where expected.
   - Would catch: P0 #2 (storeId override), P0 #3 (archive unauth), P0 #4 (PATCH unscoped), P0 #12 (role escalation), P1 GET /team open, P1 dashboard open.

### Tier 2 — engine correctness (Week 2)

2. **`pickAssignee` unit tests** with fixture-driven candidate sets covering: empty, all-OFF, round-robin rotation, missing capability, null storeId, team_member with no schedule.
3. **`computeRosterStatus` table tests** across IST/UTC, midnight rollovers, break windows, exception priority.

### Tier 3 — rule evaluation (Week 3)

4. **Rule-evaluation property tests**: feed synthetic orders × rules and assert idempotence (no duplicates), TZ-correctness, metadata-condition matching.
5. **Integration test: full poll cycle** with known fixtures, assert correct task counts, correct assignees, correct dedupe.

### Tier 4 — validation & edge cases (Week 4)

6. **Body schema validation tests** (zod recommended): role/priority/status enum coverage.
7. **Date-boundary tests**: any "today" calculation should test the 00:00–05:30 IST window explicitly.
8. **Archive `daysSinceAppointment` correctness** beyond 31 days.

## Test infrastructure choices

- **Test runner**: `vitest` (already in modern Next.js setups) over Jest — faster, native ESM, TS support.
- **DB**: Spin up a Postgres testcontainer per test file; one schema per worker.
- **HTTP testing**: `supertest` against the Next.js handlers directly (no port allocation).
- **Time mocking**: `vi.useFakeTimers()` plus a `setSystemTime(...)` helper that respects IST.

## Feedback / decisions

> Notes below.

-

