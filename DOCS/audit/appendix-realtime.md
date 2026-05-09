# Appendix — Real-time Architecture Proposal

## Current state

- **Server**: `node-cron` poller every 5–15 min.
- **Client**: `setInterval(60_000)` in three places (`HeadCommandCenter`, `StoreBoard`, plus `AllTasksBoard` polls less aggressively).
- **No socket/SSE infrastructure exists.** No `socket.io`, `pusher`, `ably` in `package.json`.

## Recommendation: Native SSE + PostgreSQL `LISTEN/NOTIFY`

### Why this approach

- **Zero new infra** — Postgres is already the bus.
- Next.js App Router supports SSE responses (a route returning `ReadableStream` with `text/event-stream`).
- Single-region deployment, single client per browser tab — no need for a fanout service like Pusher/Ably.
- Internal ops tool — Pusher/Ably cost is unjustified.

### Where broadcast hooks attach

1. **Task created**: `taskCreator.createTask` (after the `task.update` to ASSIGNED). Emit `task.created` with `{taskId, storeId, assigneeId, priority}`.
2. **Status changed**: `tasks/[id]/route.ts` PATCH at the `prisma.task.update` site. Emit `task.status_changed`.
3. **SLA breach**: `slaWatcher.ts:30-33` after BREACHED update. Emit `task.breached`.
4. **Manual reassign**: `tasks/[id]/route.ts` PATCH. Emit `task.reassigned`.

### Mechanism

Each emit is:
```typescript
await prisma.$executeRaw`SELECT pg_notify('taskos', ${JSON.stringify(payload)})`;
```

A single SSE route `/api/events` subscribes once per process via:
```typescript
const client = new pg.Client(DATABASE_URL);
await client.query('LISTEN taskos');
client.on('notification', (msg) => broadcast(msg.payload));
```

…and pipes payloads to all connected clients (filtered by user role/store).

### Migration path (per-feature, low-risk)

1. **Add `/api/events` SSE endpoint** subscribed to `LISTEN taskos`. Server-side only.
2. **Add `pg_notify` calls** at the four hooks above.
3. **In React, replace `setInterval`** with an `EventSource` subscription that calls the existing `fetchTasks()` only when a relevant event arrives. Keep a 5-min belt-and-suspenders fallback `setInterval`.
4. Steps 2-3 can ship per-feature; the SSE backbone is shared.

### Risk

- SSE through a load balancer needs `proxy_buffering off` (nginx) or HTTP/2 (other LBs). Not an issue for single-host deploy; flag if moving to multi-region.
- Postgres LISTEN/NOTIFY has a payload size limit (8 KB by default). Keep payloads small; clients re-fetch the actual data via existing API.
- A single Node process holds the LISTEN connection — multi-instance deploys need each instance to subscribe independently. Fine for the recommended single-host deploy.

## Alternative considered: Pusher / Ably

- ~$50-100/month at TaskOs scale.
- Battle-tested fan-out and connection management.
- **Rejected** because: extra infra cost, extra failure mode, internal-tool scale doesn't need it.

## Alternative considered: WebSockets (socket.io)

- Bidirectional (we don't need that — only server → client).
- Requires sticky sessions for multi-instance.
- Slightly more complex than SSE for our use case.
- **Rejected** because: SSE is simpler and the right tool for one-way push.

## Feedback / decisions

> Notes below.

-

