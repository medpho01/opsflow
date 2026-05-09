# Appendix — Scalability Roadmap

## Current hot-path complexity

| Hot path | Current | At 10K orders | At 100K orders | At 1M orders |
|---|---|---|---|---|
| `fetchAllActiveOrders` | full join, no `since` filter | OK but heavy | denormalised join over 100K rows every 5 min — prohibitive | impossible in single Node process |
| `evaluateAndCreateTasks` | nested loop O(orders × rules) with isDuplicate per pair | ~30-80K queries/cycle | 100K+ queries; cycle exceeds 60s lock; **lock stops protecting** | impossible |
| `pickAssignee` | 5 sequential awaits per task | 5N queries per cycle | bottleneck | impossible |
| `createTask` | 4 sequential awaits, no transaction | partial state on failure | guaranteed partial state | — |

## At 10K orders

**Bottleneck**: N+1 `isDuplicate` queries (~30K queries/cycle).

**Fixes** (Phase 2 of roadmap):
1. Pre-load active task keys as `Set<"ruleId|entityId">` once per cycle. In-memory check.
2. `fetchAllActiveOrders` join is OK at 10K but every 5 min becomes 12 full joins/hour — start adding indices.

## At 100K orders

**Bottlenecks**:
- Full join in `fetchAllActiveOrders` becomes prohibitive.
- `pickAssignee` per-task at create rate becomes a write bottleneck.
- Polling cycle exceeds 60s lock.

**Fixes**:
1. Incremental polling with `WHERE updatedAt > $since` checkpoint persisted to a `polling_checkpoint` table.
2. Batched assignment — load all candidates once per cycle; assign in memory; bulk insert tasks.
3. Switch polling lock to `pg_try_advisory_lock(1000)` (session-bound, auto-releases).
4. Connection pool exhaustion likely; add `pgbouncer` or `connection_limit` tuning.

## At 1M orders

**Bottleneck**: cron-in-Next.js no longer viable in a single Node process.

**Fixes**:
1. Extract poller into a worker (BullMQ/Inngest/Sidekick) deployed independently from the web tier.
2. Per-source workers; rule evaluation pushed into PostgreSQL via SQL view + `INSERT … SELECT` trigger pattern.
3. Replace `prisma.task.create` per-task with `prisma.task.createMany` batched per cycle.
4. Polling sharded by `dataSource`; each shard with its own advisory lock.
5. Read replica for analytics + dashboard; primary for poller writes.

## Queue/worker recommendation

Given the disabled multi-source path, the natural step is **BullMQ + Redis** running 3 worker classes:

```
poll-source ──→ evaluate-rule ──→ assign-task
   │                │                 │
   │                │                 └─ creates task; emits task.created event
   │                └─ emits per-rule fire metrics
   └─ emits per-source poll metrics
```

Splitting the cycle this way also gives natural backpressure points and per-stage observability.

## Feedback / decisions

> Notes below.

-

