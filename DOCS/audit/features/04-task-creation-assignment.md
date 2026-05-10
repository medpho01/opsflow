# 4. Task Creation + Assignment (the engine)

> **What it is**: Background poller fetches active orders, evaluates each against active rules, dedupes, creates tasks with checklist + SLA + auto-assigns via `pickAssignee` (skill + roster + capability + least-loaded with round-robin tiebreaker).
>
> **Primary user**: System (no UI) — surfaced through the Engine page and the polling logs.
>
> **Verdict**: 🟡 PM · 🔴 Architect · 🔴 QA — this is where scale risk and silent failures live

## Strengths

- Roster-aware (`isAvailableNow` enforces schedule + exception priority).
- Future-cap: skips orders with appointments >3 days out (queue-noise control).
- Past-cap: skips orders >10 days old.
- Rich metadata-condition language (`exists`, `contains`, `>=` with `offsetMinutes`).
- Dedupe baked in (`requiresNoPreviousTaskOfType`).
- Assignment audit trail emitted (visible in `AssignmentAuditTrail` component).
- IST timezone handling explicit (`correctISTTimestamp`) — fragile but currently correct.

## Product gaps (PM)

| Priority | Gap |
|---|---|
| **P0** | **Assignment strategy dropdown is non-functional except "least_loaded".** "Round_robin", "store_affinity", "skill_based" all silently degrade to least-loaded. |
| **P1** | **No backfill / replay tool.** New rules don't fire on historical orders. |
| **P1** | **No "manual override reason" capture** when a head reassigns. |
| P2 | No cap on tasks-created-per-poll — a status flip on 1,000 stuck orders fires 1,000 tasks at once. |
| P2 | No "do not assign before X time" gate — task created at 3am routes to whoever's on-call. |
| P2 | Title-template substitution failures silent. |

## Architecture findings — this is where scale risk lives

### Hot-path complexity

| Hot path | Current | At 10K orders | At 100K orders |
|---|---|---|---|
| `fetchAllActiveOrders` | full join, no `since` filter | OK but heavy | denormalised join over 100K rows every 5 min — prohibitive |
| `evaluateAndCreateTasks` | nested loop O(orders × rules) with isDuplicate per pair | ~30-80K queries/cycle | 100K+ queries; cycle exceeds 60s lock; **lock stops protecting** |
| `pickAssignee` | 5 sequential awaits per task | 5N queries per cycle | bottleneck |
| `createTask` | 4 sequential awaits, no transaction | partial state on failure | guaranteed partial state |
| `archiveObsoleteTasks` | duplicates the work of `archiveOldTasks` (taskArchiver.ts) | wasteful | ditto |

### Specific architectural weaknesses

- **`fetchAllActiveOrders` has no `WHERE updated_at > $since` filter** (`labstack.ts:73-99`). Every poll re-fetches the entire active-order universe via a denormalised join with User+Lab+Store. No `LIMIT`, no incremental cursor. **Top scalability risk.**
- **`isDuplicate` is called per-rule per-order inside the hot loop** (`taskCreator.ts:558`). At N=5K orders × M=8 rules with 50% trigger pass rate = 20K queries per cycle. **Classic N+1.**
- **Polling lock TTL is 60s.** If a cycle exceeds 60s (very plausible at scale), the lock expires and a second cycle starts in parallel. Both can race on `task.create` (no per-order unique constraint enforces dedupe within a single cycle).
- **`createTask` does 4 awaits sequentially with no `$transaction` wrapping.** If `taskHistory.create` fails after `task.create`, you get an assigned task with no history.
- **Missing index** on `(taskRuleId, entityId, isArchived)` for the `isDuplicate` query (the unique on `(taskRuleId, entityId)` covers the equality but not the partial `isArchived: false` predicate).
- **Missing index** on `(assignedToId, status)` for agent-load aggregation.

### Timezone (the famous IST scar)

- `correctISTTimestamp` (`taskCreator.ts:29-36`) subtracts 5.5h. **Works only because labstack stores naive timestamps in IST and JS interprets them as UTC.** If labstack ever switches to TIMESTAMPTZ, every comparison breaks silently — no test would catch it; ages would be off by 5.5h.
- `pickAssignee` lines 293-299 uses `Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())` — converts *local* y/m/d to a UTC midnight. Comment says "server runs in IST." If you Dockerise, the day boundary slides.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P0** | **`fetchAllActiveOrders` does NOT select `metadata` column** despite `RawOrder.metadata` typing. Every metadataCondition evaluates `undefined` → all such rules silently never fire. | `src/lib/engine/labstack.ts:73-99` and `taskCreator.ts:148-163` |
| 🔴 **P1** | **`appointmentTime = null` orders → `correctISTTimestamp(null)` → 1970 epoch → all such orders are "very old" and skipped.** Some order types may legitimately not have an appointment time. | `taskCreator.ts:501-505` |
| 🔴 **P1** | **Round-robin starvation** when `lastAssignedMemberId` is no longer in the candidate set → `currentIndex = -1` → always picks index 0. | `taskCreator.ts:260-262` |
| 🔴 **P1** | **`pickAssignee` returns null and `createTask` quietly creates an unassigned task** — no alert is fired despite "Unassigned" being a top-level dashboard metric. The catch block returns null silently. | `taskCreator.ts:407-410, 444` |
| 🔴 P1 | **`appendOrderNote` writes to labstack from inside the request handler with no retry**, errors only logged (silent failure). | `tasks/[id]/route.ts:91-97` |
| 🟡 | **`titleTemplate.replace` runs only one replacement per token** (no `/g` flag) — repeated `{{orderId}}` only replaces the first. | `taskCreator.ts:566-571` |
| 🟡 | Concurrent poll cycles + 60s lock TTL = race — both cycles can `task.create` for the same order before the dedupe check sees the other's row. | — |
| 🟡 | Duplicate-task check by `entityId` only, not `entityType` — future non-Order entities with same numeric id would conflict. | `taskCreator.ts:215-225` |
| 🟡 | `correctISTTimestamp` is fragile — assumes naive labstack. If DB changes, breaks silently. | `taskCreator.ts:29-36` |
| 🟡 | Trigger evaluation is permissive on shape (`!cond \|\| typeof !== 'object'` only). Pre-existing rows from migration with wrong shape never trigger. | `taskCreator.ts:530-536` |
| 🟡 | `slaMinutes * 60_000` no overflow check. | `taskCreator.ts:564` |

## Observability gaps

- `pickAssignee` catch block returns null with `console.error` only — no metrics, no alert, no DB log.
- Tasks created with `assignedToId = null` indistinguishable from "intentionally unassigned manual task" in dashboard.
- `evaluateAndCreateTasks` returns counts but doesn't emit per-rule metrics — can't tell which rule fired.
- Round-robin state never logged; failures (e.g., legacy NOT NULL columns) reach catch → silent.

## Future PM roadmap (ranked)

1. **Engine dry-run / replay** — "run engine against today's orders without creating tasks; show me what would happen".
2. **Implement the assignment strategies** users see in the dropdown (round_robin, store_affinity, skill_based).
3. **Per-rule fire log** — "fired 12 today, skipped 4 (dedupe), 0 (timing not met)".
4. **Throttle / batching** — max-tasks-per-poll, max-tasks-per-rule-per-hour.
5. **Hot-reload rules** — currently rule changes need next poll cycle.
6. **Backfill tool** — apply this rule to all orders from the last 7 days.
7. **Assignment preview** — when creating a task manually, show the candidate ranking.

## Feedback / decisions

> Add notes below.

-

