# Implementation Status

Living snapshot of where each audited feature stands. Updated as work ships. Pair with the per-feature audits in [features/](./features/) and the phased plan in [10-roadmap.md](./10-roadmap.md).

**Legend** — feature-level status:
- 🟢 healthy: audit verdict largely resolved, only P2/polish items left
- 🟡 partial: some audit items shipped, P0/P1 still outstanding
- 🔴 untouched: audit verdict still stands, no work shipped

Audit verdicts (PM · Architect · QA) are copied from each feature file — they reflect the May 9 snapshot, not today's state.

---

## Feature status table

| # | Feature | Audit verdict (May 9) | Status | What's shipped | Top remaining pain |
|---|---|---|---|---|---|
| 01 | [Data Sources](./features/01-data-sources.md) | 🟡 · 🟢 · 🟡 | 🟢 | SQL-injection P0 closed (whitelist validators in `data-sources/validate`); `pollingType` accepts `DATABASE` / `WEBHOOK` / `API`; field validators (`isValidSqlIdentifier`, `isValidTableReference`) | `src/lib/polling/` (1.1k LOC) is disabled but not deleted — purge during a cleanup pass; preview-last-10-rows + source-templates polish |
| 02 | [Task Rules](./features/02-task-rules.md) | 🟡 · 🟡 · 🟡 | 🟢 | **W1+W2** bug fixes & arch cleanup, **W3** UX friction, **W4.1** Clone rule, **W4.2** assignment strategies wired up, **W4.3** metadata-condition autocomplete, **W5.1** per-rule metrics panel, **W5.2** Rule simulator. Title-template `[missing: key]` warnings shipped (W1.5 from engine work). | Rule versioning, reorderable rules — both P2 |
| 03 | [Team](./features/03-team.md) | 🔴 · 🔴 · 🔴 | 🟢 | **W1** 10 QA bugs (closes P0 #12 role escalation, P0 #5 audit-history wipe via `previousAssigneeId` in metadata), **W2+W3** store-first lens + team capacity summary, **W4** per-agent leaderboard, **W5** weekly heatmap with coverage warnings, Coverage-by-hour panel | Skills assignment still happens via Sources/capability mapping rather than a dedicated drawer tab — confirm with you whether that's the intended final shape; `dailyRoster` writes still exist in `team/me/roster` + `roster/route.ts` (cleanup whenever the deprecation lands) |
| 04 | [Task Creation + Engine](./features/04-task-creation-assignment.md) | 🟡 · 🔴 · 🔴 | 🟢 | **W1** 7 QA bugs, **W2** engine perf (5 items), **W3** archive duplicate removed, **W4** per-rule fire log on `PollingLog.metadata`, **W5** IST→UTC at SQL boundary + TIMESTAMPTZ on engine-owned cols. Labstack made strictly read-only (`appendOrderNote` + DB-handler sync removed). | Backfill / replay tool; manual-override reason capture; tasks-per-poll cap |
| 05 | [All Tasks (head + agent)](./features/05-all-tasks.md) | 🟢 head · 🔴 agent | 🟡 | Head board solid (saved-views aside). Drawer fixes: `Failed to fetch` + BigInt 500 fixed; drawer now shows tasks of any entityType bound to the same numeric id, ORDER first | **Agent execution console** — biggest single product gap in the audit. SOPs per task type, "why this task?" panel, customer 360, structured outcome capture, snooze, `tel:`/`wa.me` quick actions. Saved filter views on the head board |
| 06 | [Store Overview](./features/06-store-overview.md) | 🟡 · 🟡 · 🔴 | 🔴 | Store-selector dropdown clipping fix only | Inherits **P0 #2** cross-store leak from `/api/tasks` (`where.storeId` overwritten by query param at `tasks/route.ts:243`); store-admin write actions; dedicated count endpoint (4 fetches per refresh today); accurate "Unassigned" count (currently capped at first 50 tasks) |
| 07 | [Analytics](./features/07-analytics.md) | 🔴 · 🔴 · 🟡 | 🔴 | — | Source-level + rule-level analytics (the missing dimensions); SLA trend over time; CSV export; **third re-implementation of `computeRosterStatus`** in `analytics/agents/route.ts` references nonexistent columns — silently a no-op |
| 08 | [Command Center](./features/08-command-center.md) | 🟡 · 🔴 · 🔴 | 🔴 | Per-source chip count fix; AlertBell rendering crash fix | **P0 #1 still live** — Team Status shows whole team OFF because dashboard reads dead `dailyRosters` (`src/app/api/dashboard/route.ts:185`); KPI drill-in; sources-health tile; alerts severity sort + ack-all |

---

## P0 fixes scoreboard

From [p0-fixes.md](./p0-fixes.md). **4 of 12 done.**

| # | Bug | File | Status |
|---|---|---|---|
| 1 | Command Center shows whole team OFF (reads dead `dailyRosters`) | `src/app/api/dashboard/route.ts:185` | ❌ |
| 2 | STORE_ADMIN can read tasks for any store (`where.storeId` overwritten) | `src/app/api/tasks/route.ts:232 → 243` | ❌ |
| 3 | `/api/tasks/archive` has no authentication | `src/app/api/tasks/archive/route.ts:9` | ❌ |
| 4 | STORE_ADMIN can PATCH any task (only OPS_AGENT-not-own is checked) | `src/app/api/tasks/[id]/route.ts:63` | ❌ |
| 5 | DELETE team-member wipes completion audit history | `src/app/api/team/[id]/route.ts` | ✅ Team W1.2 — preserves COMPLETED tasks, stamps `previousAssigneeId` in metadata |
| 6 | Metadata conditions silently never match (column not selected) | `src/lib/engine/labstack.ts` | ✅ Engine W1.1 |
| 7 | SQL injection in `data-sources/validate` | `src/app/api/data-sources/validate/route.ts` | ✅ Whitelist validators |
| 8 | `now.setHours(0,0,0,0)` mutates shared `now` in dashboard | `src/app/api/dashboard/route.ts:67` | ❌ |
| 9 | `computeRosterStatus` uses local Node TZ via `toTimeString` | `src/lib/roster/availability.ts:57` | ❌ |
| 10 | Round-robin starvation when candidate set changes (`currentIndex === -1` always picks 0) | `src/lib/engine/taskCreator.ts:385` | ❌ |
| 11 | Triple roster mechanism (dailyRoster still actively written from 4 places) | `src/app/api/roster/route.ts:93`, `team/me/roster/route.ts:33`, `lib/task-creation/roster-validator.ts:56` | ❌ |
| 12 | `POST /api/team` accepts arbitrary `role` string | `src/app/api/team/route.ts` | ✅ Team W1.1 — zod schema in `lib/validation/team.ts` |

The four with security blast radius are **#3 (open archive endpoint), #2 (cross-tenant read), #4 (cross-store write)** — three are still live. **#12** (role escalation) was closed by Team W1.

---

## Roadmap phase scoreboard

From [10-roadmap.md](./10-roadmap.md).

| Phase | Theme | Status | Notes |
|---|---|---|---|
| **Phase 1 — Stabilize** | P0 bugs, auth/validation sweep, setup, skills tab, tests | 🟡 partial | 4 of 12 P0s done. Validation sweep partially done (Team, Data Sources). Auth sweep on `/api/tasks` family still open. Test scaffolding still open. |
| **Phase 2 — Strengthen** | Engine perf, dead code, roster consolidation, TZ | 🟡 partial | Engine perf section largely done (W2). TZ item 17 delivered as inline `AT TIME ZONE` casts (W5). `dailyRoster` consolidation still open (P0 #11). `src/lib/polling/` still ships disabled. |
| **Phase 3 — Extend** | Agent console, rule simulator, onboarding, filters, team CSV | 🟡 partial | **Rule simulator shipped** (Task Rules W5.2). Clone shipped (W4.1). Agent execution console untouched. Onboarding/filters untouched. |
| **Phase 4 — Polish** | Realtime, source health, dry-run, analytics, throttling, webhooks | 🟡 partial | Per-rule fire log (W4) and assignment strategies (W4.2) shipped. Realtime, source-health alerting, analytics depth, throttling, webhook ingestion all untouched. |

---

## Recommended next moves

Three security/correctness items still live in `/api/tasks` family — these are the highest-leverage remaining work on the board:

1. **`/api/tasks` auth + scoping sweep** (~half a day). Closes **P0 #2** (cross-store read), **#3** (open archive endpoint), **#4** (any-task PATCH). One file's worth of changes for #2 and #4; archive needs a session+role gate. Eliminates Store Overview's inherited bug too.
2. **Command Center P0 #1 + dailyRoster removal** (~half to 1 day). Stop reading dead `dailyRoster` in dashboard; flip to `computeRosterStatus`. Then either delete the table + writers, or keep them as a deprecated read-side and document the deprecation. Closes the visible "whole team OFF" regression.
3. **Round-robin starvation #10 + roster TZ #9 + setHours #8** (~half a day). Three small mechanical fixes that close the rest of the engine/dashboard P0s.

That's roughly 1.5 days to clear all 8 remaining P0s.

After that, the highest product-leverage move is the **Agent Execution Console** (Phase 3). The audit estimates ~5 days; it's described as "the biggest single product investment" in feature 05. SOPs per task type, "why this task?" panel, customer 360, structured outcome capture.

---

## How to keep this current

- After each meaningful ship, update the relevant row's **Status** column and **What's shipped** entry.
- When a P0 lands, flip its row in the P0 scoreboard from ❌ to ✅ with the wave/commit identifier.
- Don't promote a row to 🟢 until at least the audit's P0/P1 list for that feature is addressed.
- This doc is the living version of [10-roadmap.md](./10-roadmap.md) — the roadmap is the plan, this is the score.
