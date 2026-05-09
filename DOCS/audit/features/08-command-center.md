# 8. Command Center

> **What it is**: OPS_HEAD home — 8 KPI tiles, per-source open-task chips, Risk Zone (at-SLA-risk tasks with inline assign), Live Alerts feed, Team Status. Polls every 60s.
>
> **Primary user**: OPS_HEAD
>
> **Verdict**: 🟡 PM · 🔴 Architect · 🔴 QA — heaviest single request in the app + currently shows whole team OFF (regression)

## Strengths

- Dense, single-glance view — KPIs, risk, team load all visible without scrolling on a wide monitor.
- Risk Zone has inline-assign dropdown for unassigned at-risk tasks (highest-leverage interaction in the screen).
- **Per-source chip counts now correct** (fixed in this audit cycle by switching from dead `taskRuleSourceScope` join to direct `dataSource.taskRules → tasks` count).
- Auto-refreshes 60s + manual refresh + last-synced timestamp.
- "Create Task" CTA front and center for ad-hoc work.
- Color-coded SLA Health (green/amber/red).

## Product gaps (PM)

| Priority | Gap |
|---|---|
| P1 | **No drill-in.** Clicking "Breached: 4" doesn't take you to the breached tasks. Same for every KPI tile. |
| P1 | **Live Alerts has no severity sort / unread badge / acknowledge-all.** |
| P1 | **Team Status shows load bars but not roster status** (currently showing OFF for everyone — regression bug below). |
| P1 | **No "sources health" tile** (was the last poll successful?). |
| P2 | No customizable layout / hidden tiles. |
| P2 | Risk Zone caps at unspecified count; no pagination. |
| P2 | No quick filter ("show only urgent risks"). |

## UX friction

- KPI tiles look clickable but aren't.
- "Done Today" and "Breached Today" sit at the end of the KPI strip — important but easily missed.
- The 60s auto-refresh is silent; no shimmer or "new data" indicator.
- "Live Alerts" appears below the fold on smaller screens.
- Dismissed alerts disappear immediately with no undo.

## Empty state

- "All clear — No tasks at risk right now" is delightful, but the rest of the dashboard isn't designed for empty (e.g., zero stats, zero team, zero sources). On a fresh install: 8 zero tiles, "No team members", "No active alerts" — disorienting.

## Architecture findings — heaviest single request in the app

- **`/api/dashboard` runs 12 queries in `Promise.all`.** Every connected ops-head client triggers all 12 every 60s. With 5 clients = ~60 queries/min just for the dashboard.
- **`now.setHours` mutates `now`** before subsequent queries reference it (line 68). Subtle landmine for the next edit.
- **`fetchAllActiveOrders().then(o => o.length).catch(() => 0)`** — runs the heaviest query in the codebase **just to get a count**, with full join, and silently returns 0 on failure (indistinguishable from "no active orders"). Pure observability hole.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P0** | **Whole team shows OFF** because dashboard reads dead `dailyRosters` table. Replaced by `weekly_schedules`+`roster_exceptions` in `lib/roster/availability.ts` but the dashboard wasn't migrated. | `dashboard/route.ts:102, 185` |
| 🔴 **P0** | **`now.setHours(0,0,0,0)` mutates the shared `now`** before subsequent queries use it. Subtle off-by-one. | `dashboard/route.ts:68` |
| 🔴 **P1** | **No role check** on `/api/dashboard` — any authenticated user incl. OPS_AGENT gets full dashboard with team load, breaches, alerts. | `dashboard/route.ts:11-12` |
| 🔴 **P1** | **"Completed today" / "Breached today" use server-local midnight.** Same TZ bug as analytics — IST/UTC mismatch. | `dashboard/route.ts:68, 76, 105` |
| 🔴 **P1** | **`fetchAllActiveOrders().then(o => o.length).catch(() => 0)`** silences labstack outage entirely. The `0` is indistinguishable from "no active orders". | `dashboard/route.ts:32` |
| 🟡 | `lastPollAt` returned but no SLA on freshness — UI must compute "stale poll" alert client-side. | — |
| 🟡 | `recentAlerts` only `PENDING` — silenced alerts that re-breach not surfaced. | — |
| 🟡 | 0 open tasks → `slaHealth = 100` (correctly handled). | — |

## Future PM roadmap (ranked)

1. **Drill-in on every KPI tile** (clicking "Breached: 4" → All Tasks filtered to those 4).
2. **Source health card** — last poll, success rate, tasks created last hour.
3. **Roster glance tile** — "12 active, 3 on field, 2 on leave, 5 off".
4. **Custom tiles** — head pins their KPIs.
5. **Date-range toggle** — Today / This shift / This week.
6. **At-risk forecast** — "12 tasks will breach in next 30 min if not actioned" predictive.
7. **Onboarding banner on empty install** — "Let's get started: 1) Register a data source, 2) Add agents, 3) Create rules" — cross-link.
8. **Audio alert / desktop notification** for new BREACHED.

## Feedback / decisions

> Add notes below.

-

