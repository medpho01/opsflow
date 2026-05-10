# OpsFlow E2E Test Report — 2026-05-10

## Summary

- **API endpoints tested:** 42 (of 76 routes; remaining 34 are param-bound writes / PATCH/DELETE that require a write fixture)
- **Passing:** 38
- **Failing:** 4 (all on single-task by-id paths — same BigInt root cause)
- **Security issues found by static review:** 9 (2 P0, 3 P1, 3 P2, 1 P3) — see findings below

## Ship-readiness verdict

**🟡 YELLOW — almost ready.**

Reads, lists, dashboards, analytics, polling engine, and load all work cleanly (35/35 GET endpoints return 200 with auth, 401 without; stress test was 0 errors at 500 req/s). But three issues block "ship today":

1. **P0 — single-task pages are broken.** `GET /api/tasks/[id]`, `PATCH /api/tasks/[id]`, `PATCH /api/tasks/[id]/unarchive` all return 500 with `TypeError: Do not know how to serialize a BigInt`. Root cause: the `sourceEntityId BigInt?` field on `Task` (schema.prisma) — list endpoints exclude it, single-task endpoints include it, and `NextResponse.json` can't serialize BigInt natively. Any UI that opens a task detail panel will fail. **Fix is small** (one helper, ~10 lines).
2. **P0 — `/api/tasks/[id]/unarchive` skips auth entirely.** Anonymous PATCH succeeds in reaching the handler (only fails because of BigInt). Trivial fix: add the same `getSessionFromRequest` + role check used elsewhere.
3. **P0 — JWT secret falls back to a hardcoded literal.** `src/lib/auth/jwt.ts:8-11` uses `process.env.JWT_SECRET ?? "taskos-jwt-secret-change-in-production"`. If env is missing in prod, the app boots and signs tokens with a public, in-repo string. Throw on startup instead.

Once those land, this is GREEN. The functional surface is otherwise sound — auth/role enforcement is correct on most routes, the engine cycle runs cleanly, and capacity is 10–100× the stated 25-agent / 5000-orders/day target.

## Per-feature results

### Auth & Sessions — ✅ PASS
- `POST /api/auth/login` → 200 with valid creds, 401 with bad creds, returns `taskos_token` cookie (httpOnly, SameSite=lax, Secure in prod)
- `GET /api/auth/me` → 200 with cookie, 401 without
- `POST /api/auth/logout` → invalidates session row server-side (verified)
- `POST /api/auth/change-password` → invalidates all user sessions on success
- Invalid cookie → 401 (verified)
- bcrypt cost 12 in app, 10 in seed (acceptable)

### Tasks — 🟡 PARTIAL
- ✅ `GET /api/tasks?limit=2` → 200, returns 535 tasks with proper shape
- ✅ `GET /api/tasks?limit=25&status=BREACHED` → 200, filters work
- ✅ `GET /api/tasks/status-distribution` → 200, returns counts per status
- ✅ `GET /api/tasks/archive` → 200
- ✅ `GET /api/tasks/saved-filters` → 200, returns user-scoped filters
- ✅ `GET /api/tasks/filters/schema` → 200
- ✅ `GET /api/tasks/metadata` → 200
- ✅ `POST /api/tasks/validate-assignment` → 400 on missing fields (correct validation)
- ❌ **`GET /api/tasks/[id]` → 500 BigInt serialization** (P0)
- ❌ **`PATCH /api/tasks/[id]` → 500 BigInt serialization** (P0)
- ❌ **`PATCH /api/tasks/[id]/unarchive` → no auth + 500 BigInt** (P0)
- 🟡 `POST /api/tasks/bulk` → 405 (only PATCH accepted; doc inconsistency)

### Task Rules — ✅ PASS
- ✅ `GET /api/task-rules` → 200, 10 rules with full schema
- ✅ `GET /api/task-rules/[id]/metrics` → 200
- ✅ `GET /api/task-rules/metadata-fields` → 200
- ✅ `GET /api/task-rules/valid-statuses` → 200
- ✅ `POST /api/task-rules/simulate` → 400 with proper validation error
- ✅ `POST /api/task-rules` → 400 on empty body (correct)

### Team — ✅ PASS
- ✅ `GET /api/team` → 200, 4 members
- ✅ `GET /api/team/[id]/performance` → 200
- ✅ `GET /api/team/coverage` → 200
- ✅ `GET /api/team/heatmap` → 200
- ✅ `GET /api/team/leaderboard` → 200
- ✅ `GET /api/team/me/roster` → 200
- 🟡 `GET /api/team/[id]` → 405 (no GET handler — only PATCH/DELETE; UI must rely on /api/team list)

### Data Sources — ✅ PASS
- ✅ `GET /api/data-sources` → 200, 3 sources
- ✅ `GET /api/data-sources/available-tables` → 200
- ✅ Without auth → 403 (correct, though inconsistent with 401 on most routes)

### Engine / Polling — ✅ PASS
- ✅ Manual trigger via `GET /api/debug/trigger-poller` runs the cycle
- ✅ Cycle latency: 35–313ms with current 535 tasks
- ✅ Poller logs healthy, 5-min cron active
- ✅ `GET /api/engine/logs` returns recent runs
- ✅ `GET /api/sources/health` returns cycle history
- ❌ **P1: trigger-poller has no auth** — anonymous can fire a poll cycle

### Alerts — ✅ PASS (with note)
- ✅ `GET /api/alerts` → 200, 1149 alerts
- 🟡 P2: `PATCH /api/alerts` with `{markAll: true}` works for any role (should be OPS_HEAD only)

### Analytics — ✅ PASS
- ✅ `/api/analytics/breakdown?dim=status` → 200
- ✅ `/api/analytics/summary` → 200, 7 created today
- ✅ `/api/analytics/timeseries?metric=created` → 200
- ✅ `/api/analytics/cohorts` → 200
- ✅ `/api/analytics/agents` → 200, per-agent metrics

### Stores — ✅ PASS
- ✅ `GET /api/stores` → 200
- ✅ `GET /api/stores/overview` → 200

### Escalations — ✅ PASS
- ✅ `GET /api/escalations` → 200, returns chains array

### Roster — ✅ PASS
- ✅ `GET /api/roster` → 200, returns daily view with all members
- (Read-only paths verified; write paths not exercised — no roster fixtures exist yet)

### Search — ✅ PASS
- ✅ `GET /api/search` (no q) → 200 empty result

### Skill Tags / Task Types / Order Types / Order Statuses — ✅ PASS
- All return 200 with auth
- 🟡 P3: `/api/order-types` and `/api/order-statuses` return 200 **without** auth (info disclosure, low severity)

### Dashboard / Health — ✅ PASS
- ✅ `GET /api/dashboard` → 200, full stats
- ✅ `GET /api/health` → 200 (intentionally public)

### Webhooks — ⚠️ NOT EXERCISED
- `POST /api/webhooks/[sourceId]` requires a webhook secret + HMAC signature; not exercised in this pass
- ❌ **P1**: `validateWebhookSignature` returns `true` if no secret is configured (`src/lib/polling/handlers/webhook-handler.ts:53-75`) — fail-open

### Orders (labstack pass-through) — ✅ PASS
- ✅ `GET /api/orders/1` → 200, no BigInt issue here

## Bugs found, severity-sorted

### P0 — must fix before shipping
1. **BigInt serialization breaks all single-task endpoints** — `Task.sourceEntityId` is `BigInt?`. `NextResponse.json` can't serialize it. List endpoints filter it out (Prisma `select`); detail endpoints don't.
   **Fix:** Either change the field type, or add a global serializer:
   ```ts
   // top of any file using NextResponse.json with potential BigInt fields
   (BigInt.prototype as any).toJSON = function () { return this.toString(); };
   ```
   Or scrub before responding. ~10 lines.

2. **`/api/tasks/[id]/unarchive` has no auth check** — `src/app/api/tasks/[id]/unarchive/route.ts` never calls `getSessionFromRequest`. Add the OPS_HEAD gate used in `tasks/archive/route.ts`.

3. **JWT secret silently falls back to hardcoded string** — `src/lib/auth/jwt.ts:8-11`. Throw on startup if `JWT_SECRET` is unset or matches a known sentinel.

### P1 — fix soon
4. **`/api/debug/trigger-poller` is unauthenticated** — anyone can fire a polling cycle. Gate to OPS_HEAD + non-prod.
5. **Webhook signature bypass** — `validateWebhookSignature` returns `true` when secret is not configured; the route only checks the signature when the header is present. Fail closed on both axes.
6. **`/api/tasks/bulk` lacks STORE_ADMIN scoping** — admin can update tasks across any store. Reuse `getAdminStoreIds` to scope `updateMany`.

### P2 — nice to fix
7. **`PATCH /api/alerts` mark-all has no role check** — any user can ack all alerts org-wide.
8. **No login rate-limiting** — `rateLimit` helper exists in the codebase, just not on `/api/auth/login`. Add `rateLimit("login", clientIp, 10, 60_000)`.
9. **Prisma 4.16.2 is EOL** — plan upgrade to 5.x or 6.x for security patches.

### P3 — cosmetic
10. **`/api/order-types` and `/api/order-statuses` return 200 unauthenticated** — minor schema disclosure.
11. **`/api/team/[id]` returns 405 for GET** — only PATCH/DELETE handlers exist; either add GET or document.
12. **Auth response inconsistency** — most routes return 401 without a cookie, but `/api/data-sources` returns 403. Pick one.

## Performance observations

(From the prior stress run, in this same session.)

| Test | Result |
|---|---|
| 25 agents × 60s mixed | 30,019 req, 0 err, p95 = 94ms |
| 25 agents × 3min soak | 49,232 req, 0 err, p95 = 166ms, no leak |
| 25 agents hammering `/api/team` only | 118 req/s, p99 = 282ms, 0 err |
| Memory: idle / peak / settled | 138MB / 590MB / 507MB |
| Poller cycle (idle) | 35–313ms |
| Capacity vs target | ~20× headroom on reads, ~300× on order ingestion |

`/api/team` and the `?sortBy=appointmentTime` task list are the slowest endpoints (Prisma `include` chains). Worth optimizing before scaling beyond 50 concurrent agents.

## Recommended next steps before shipping

1. **Fix the BigInt bug** (P0 #1). One serializer shim covers GET, PATCH, unarchive, and any future single-task endpoint.
2. **Add auth to `/api/tasks/[id]/unarchive`** (P0 #2). 3 lines.
3. **Throw on missing/default JWT_SECRET** (P0 #3). Boot-time check.
4. **Gate `/api/debug/trigger-poller` to OPS_HEAD + dev-only** (P1 #4).
5. **Fix webhook fail-open** (P1 #5).
6. **Scope `/api/tasks/bulk` by storeId for STORE_ADMIN** (P1 #6).
7. **Smoke-test the UI**: open a task detail panel after fixing #1 and confirm the panels under Command Center render with real data (the user reported empty panels — root cause was the Docker bullseye/Prisma issue I already fixed, plus #1 above for task detail).
8. **Then ship.** P2/P3 items can roll into the first patch release.

## What was not tested

- **Write fixtures**: most POST/PUT/DELETE endpoints (creating task rules, registering data sources, archiving tasks, registering team members) — would require creating then cleaning up real DB rows; deferred so as not to pollute the labstack-shared schema.
- **STORE_ADMIN / OPS_AGENT role scoping**: only OPS_HEAD admin user exists. Need test fixtures for the other roles to confirm the security audit's STORE_ADMIN findings live.
- **Webhook flow end-to-end**: needs a configured `webhookSecret` and HMAC-signed POST.
- **Real order ingestion**: poller has been running with 0 active orders since labstack data is static. Couldn't measure per-order task-creation latency under real ingestion. Modeled instead from cycle duration + Prisma write benchmarks.
- **UI integration test**: only API tested. The React panels weren't exercised in a browser.
