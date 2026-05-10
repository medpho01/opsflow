# Security Audit — OpsFlow / TaskOs (2026-05-10)

Static code review of `src/`, `prisma/`, `docker*`, `.env*`. Live HTTP probes and `npm audit` were not run; findings here come from code review. P0/P1 items have been confirmed live where possible (see E2E_TEST_REPORT.md).

## Summary
9 findings: **2 P0**, **3 P1**, **3 P2**, **1 P3**.

| # | Sev | Title |
|---|-----|-------|
| 1 | P0 | `/api/tasks/[id]/unarchive` is fully unauthenticated |
| 2 | P0 | JWT secret silently falls back to a hardcoded string when `JWT_SECRET` is unset |
| 3 | P1 | `/api/debug/trigger-poller` is unauthenticated and ships in prod builds |
| 4 | P1 | Webhook signature check is bypassable when no `webhookSecret` is configured |
| 5 | P1 | `/api/tasks/bulk` lets a STORE_ADMIN modify tasks across any store |
| 6 | P2 | `/api/alerts` PATCH has no role/scoping — any user can ack all alerts globally |
| 7 | P2 | No login rate-limiting or account lockout |
| 8 | P2 | Prisma pinned to v4.16.2 (EOL) |
| 9 | P3 | `/api/order-types` and `/api/order-statuses` are unauthenticated info disclosure |

## Findings

### P0 — Unauthenticated unarchive endpoint
**File:** `src/app/api/tasks/[id]/unarchive/route.ts:8-37`
**Issue:** The `PATCH` handler never calls `getSessionFromRequest`, has no role check, and goes straight into `unarchiveTask(taskId)`. Any anonymous request restores any archived task by id.
**Risk:** Tampering with archived task state, repopulating queues with old patient/order data; id enumeration via response differences.
**Fix:** Wrap in the same `requireOpsHead(...)` pattern used in `tasks/archive/route.ts:14-23`.

### P0 — JWT secret falls back to a hardcoded string
**File:** `src/lib/auth/jwt.ts:8-11`
```ts
return new TextEncoder().encode(
  process.env.JWT_SECRET ?? "taskos-jwt-secret-change-in-production"
);
```
**Issue:** If `JWT_SECRET` is unset the app boots and signs/verifies with a public, in-repo string. Compounded by:
- `docker-compose.yml:41` defaults to `please-change-me-in-production`
- `.env:4` (live dev) uses `dev-please-change-in-prod`
- `.env.example:4` uses `please-change-me-in-production`

**Risk:** Total auth bypass if env var is missing, default, or leaked.
**Fix:** Throw on startup if `JWT_SECRET` is unset or matches a known-default sentinel; remove the inline fallback. Rotate the current dev secret before any prod handover.

### P1 — Debug poller endpoint is open
**File:** `src/app/api/debug/trigger-poller/route.ts:10-31`
**Issue:** `GET /api/debug/trigger-poller` runs `runPollCycle()` with no auth.
**Risk:** Trivial DoS; surfaces polling pipeline + log output to attackers.
**Fix:** Require OPS_HEAD and gate behind `process.env.NODE_ENV !== "production"`, or delete from prod build.

### P1 — Webhook signature bypass
**Files:** `src/app/api/webhooks/[sourceId]/route.ts:50-70`, `src/lib/polling/handlers/webhook-handler.ts:53-75`
**Issue:**
1. Route only validates signature when `X-Webhook-Signature` header is present (l.61). Omit header → no check.
2. `validateWebhookSignature` returns `true` when `webhookSecret` is unset (l.57-62).
3. `GET /api/webhooks/{sourceId}` confirms whether a `sourceId` exists, helping enumeration.

**Risk:** Anyone on the internet who knows or guesses an active `sourceId` can POST arbitrary JSON and spawn OpsFlow tasks.
**Fix:** Require both header presence and a configured secret; fail closed when either is missing. Length-check buffers before `crypto.timingSafeEqual`.

### P1 — Bulk task action lacks STORE_ADMIN scoping
**File:** `src/app/api/tasks/bulk/route.ts:11-108`
**Issue:** Only `OPS_AGENT` is rejected (l.14). A STORE_ADMIN can pass any task ids and `prisma.task.updateMany({ where: { id: { in: taskIds }}})` applies the action with no `storeId` constraint. Contrast with `tasks/[id]/route.ts:33-43`, which has `canAccessTask`.
**Risk:** STORE_ADMIN privilege escalation: bulk-cancel / bulk-reassign / bulk-block any tasks across the org.
**Fix:** Resolve admin's `storeIds` first, add `storeId: { in: <admin stores> }` to every `updateMany` `where`. Reuse `getAdminStoreIds` from `tasks/[id]/route.ts:19-25`.

### P2 — `/api/alerts` PATCH is global
**File:** `src/app/api/alerts/route.ts:31-51`
**Issue:** Any authenticated user (incl. OPS_AGENT) can call `PATCH /api/alerts` with `{markAll: true}` and acknowledge every PENDING alert org-wide.
**Risk:** Low-priv user can hide active SLA-breach alerts from Ops Heads.
**Fix:** Require OPS_HEAD for `markAll`; otherwise scope updates to alerts that match the caller's `storeId` / `assignedToId`.

### P2 — No login rate-limiting
**File:** `src/app/api/auth/login/route.ts` (no `rateLimit` import)
**Issue:** Login has no per-IP/per-account throttling and no account lockout. The codebase already has a `rateLimit` helper at `src/lib/observability/rate-limit.ts` used on password resets.
**Risk:** Online brute force / credential stuffing. Made worse by the `changeme123` default admin password baked into `prisma/seed.ts:143` and `docker/seed-admin.ts:19`.
**Fix:** `rateLimit("login", clientIpOrEmail, 10, 60_000)` returning 429. DB-backed failure counter for per-account lockout.

### P2 — Outdated Prisma in production deps
**File:** `package.json:28,40` (`prisma`, `@prisma/client` `^4.16.2`)
**Issue:** Prisma 4 reached EOL in 2023; current is 6.x. No further security patches.
**Fix:** Plan upgrade to Prisma 5/6 and rerun `npm audit`.

### P3 — Public enum endpoints
**Files:** `src/app/api/order-types/route.ts:10`, `src/app/api/order-statuses/route.ts:10`
**Issue:** Both routes respond unauthenticated, returning the labstack `OrderType` / `OrderStatus` enum lists.
**Fix:** Add `getSessionFromRequest`; require any authenticated user.

## What looks correct

- **Password hashing:** bcryptjs cost 12 (`src/lib/auth/password.ts:5`), constant-time compare. Seed uses cost 10 (acceptable).
- **JWT verification:** `jose` HS256 with explicit expiry (`src/lib/auth/jwt.ts:14-20`) AND a server-side `Session` row check (`src/lib/auth/session.ts:16-27, 53-64`). Logout deletes the session row. Password change invalidates all sessions for the user.
- **Cookies:** `httpOnly`, `sameSite: lax`, `secure` in production, scoped path, `maxAge` matches token TTL. No state-changing GET endpoints found.
- **`$queryRawUnsafe` callers:** every site using user input either parameterises (`api/orders/[id]/route.ts:39-64`, `api/stores/route.ts:51-59`) or whitelists with strict regex. `lib/polling/handlers/database-source-handler.ts` does interpolate operator-controlled `queryTemplate`, but writes are gated to OPS_HEAD.
- **Task RBAC:** `api/tasks/[id]/route.ts:33-43` centralises `canAccessTask` and uses it on GET + PATCH. Listing route correctly intersects admin-store scope with user-supplied `storeId` filter.
- **Team / roster / escalations / data-sources / dashboard / skill-tags:** all OPS_HEAD-gated where expected.
- **Sensitive data in responses:** no route returns `passwordHash`. Only references are read-for-verify in login/change-password.
- **`.env`:** in `.gitignore:2`; `.env.example` ships placeholder values.
- **Dependencies installed:** `next@15.5.15` (post CVE-2025-29927 patch), `axios@1.16.0`, `jose@6.2.3`, `jsonwebtoken@9.0.3`, `bcryptjs@3.0.3` — current.

## Out of scope / not verified
- Live HTTP testing for negative-auth probes
- `npm audit --omit=dev` for Prisma 4 transitive CVEs
- Dockerfile / image hardening, TLS termination, reverse proxy
- CSRF (SameSite=lax + JSON body is acceptable; no anti-CSRF token)
- OPS_HEAD insider risk (compromised head can set `dataSource.queryTemplate` to arbitrary SQL run via `$queryRawUnsafe`)
- Logs / PII full DLP sweep
