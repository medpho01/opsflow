# P0 Fixes — The 12 issues to fix before anything else

These are ordered roughly by impact-to-effort. Every one has a known reproducer and a localized fix. **Total estimated effort: 1-2 days of focused work**.

| # | What's wrong | File:line | Why it's P0 | Suggested fix |
|---|---|---|---|---|
| 1 | **Command Center shows whole team as OFF.** Dashboard reads legacy `dailyRosters` which no one writes anymore (replaced by `weekly_schedules`+`roster_exceptions` in `lib/roster/availability.ts`) | `src/app/api/dashboard/route.ts:102, 185` | Already-shipped regression after the recent roster refactor. Affects every load of `/head`. | Replace the `team[].rosterStatus` derivation with `computeRosterStatus(weeklySchedules[0], rosterExceptions[0], now)` |
| 2 | **STORE_ADMIN can read tasks for any store** — `where.storeId = { in: ids }` is overwritten by `?storeId=...` query param two lines later | `src/app/api/tasks/route.ts:233 → 243` | Cross-tenant data leak; trivial to exploit | Compose, don't overwrite: `if (storeId) where.storeId = ids.includes(parseInt(storeId)) ? parseInt(storeId) : -1` |
| 3 | **`/api/tasks/archive` has NO authentication** — public endpoint exposes archived tasks and triggers archive job | `src/app/api/tasks/archive/route.ts:9, 30` | Open data leak + DoS vector | Wrap both handlers with `getSessionFromRequest` + OPS_HEAD check |
| 4 | **STORE_ADMIN can edit any task** — PATCH `/tasks/[id]` only blocks OPS_AGENT-not-own; STORE_ADMIN unchecked | `src/app/api/tasks/[id]/route.ts:60-62` | Cross-store write | Same scoping rule as GET, applied to PATCH |
| 5 | **DELETE team-member wipes completion audit history** — nulls `assignedToId` on every task the user ever owned, including COMPLETED | `src/app/api/team/[id]/route.ts:100-103` | Permanent data loss | Filter to non-terminal status before nulling, or set a `previousAssigneeId` archive column |
| 6 | **Metadata conditions silently never match.** `fetchAllActiveOrders` doesn't `SELECT metadata` despite `RawOrder.metadata` typing — every rule using `metadataConditions` evaluates `undefined` and quietly fails | `src/lib/engine/labstack.ts:73-99` and `taskCreator.ts:148-163` | Class of rules entirely broken; failure invisible | Add `o."metadata"` to the SELECT |
| 7 | **SQL injection in validate endpoint** — `Prisma.raw` interpolates user-supplied `primaryKeyField`/`typeFieldName`/`statusFieldName` directly into the IN-clause | `src/app/api/data-sources/validate/route.ts:55-58` | Privileged but injection is injection | Whitelist column names (regex `^[a-zA-Z_][a-zA-Z0-9_]*$`) before interpolation |
| 8 | **`now.setHours(0,0,0,0)` mutates the shared `now`** before subsequent queries reference it | `src/app/api/dashboard/route.ts:68` | Subtle off-by-one for `breachedToday`/`completedToday`; landmine for the next edit | Use `new Date(new Date().setHours(0,0,0,0))` or pull a `startOfTodayLocal()` helper |
| 9 | **`computeRosterStatus` uses `now.toTimeString().slice(0,5)`** — local Node TZ. With server in UTC and schedules in IST, every comparison is shifted 5:30h | `src/lib/roster/availability.ts:57` | Currently masked because the dev server runs in IST; breaks the moment it's containerised | `Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit'}).format(now)` |
| 10 | **Round-robin starvation when candidate set changes.** If `state.lastAssignedMemberId` is no longer in the current candidate list, `currentIndex = -1` → always picks index 0 | `src/lib/engine/taskCreator.ts:260-262` | Permanent imbalance after any roster change | When `currentIndex === -1`, use a deterministic-but-non-zero pick (e.g. hash modulo, or persisted counter) |
| 11 | **Triple roster mechanism causes display ≠ assignment.** `dailyRosters` table is dead but still queried by Dashboard; `weeklySchedules`+`rosterExceptions` is what `pickAssignee` uses; `analytics/agents/route.ts:32-89` re-implements roster *with bugs* (references nonexistent `breakStartTime`/`breakEndTime` columns) | `src/app/api/analytics/agents/route.ts:84-87`; `src/lib/task-creation/roster-validator.ts:73`; `dashboard/route.ts:185` | "Why does Analytics say Arjun was active when Command Center shows him OFF and the engine didn't assign him?" | Delete duplicate impls; everyone calls `lib/roster/availability.ts:computeRosterStatus` |
| 12 | **POST /team accepts arbitrary `role` string**, including promoting users to OPS_HEAD with no validation | `src/app/api/team/route.ts:165-169` | Privilege escalation | `if (!Object.values(UserRole).includes(role)) return 400` |

## Feedback / decisions

> Add notes below for any P0 you want to defer, redirect, or expand on. Anything left unmarked here will be picked up in roadmap **Phase 1 — Stabilize**.

-

