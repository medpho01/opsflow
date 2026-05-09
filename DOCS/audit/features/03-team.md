# 3. Team

> **What it is**: Manage Ops Agents and Store Admins — profile, skills, store access, data-source capabilities, weekly schedule, today's roster status.
>
> **Primary user**: OPS_HEAD
>
> **Verdict**: 🔴 PM · 🔴 Architect · 🔴 QA — has both a closed-loop functional break (no Skills UI) AND a privilege-escalation bug

## Strengths

- Compact card per agent with load bar (open/max), skill badges, store count, current roster status.
- Inline "Mark Active" / "Mark Off" / "Revert Exception" — distinguishes scheduled vs exception status.
- Edit drawer organized into Profile / Sources / Stores / Schedule.
- Bulk store select-all toggle.
- Capability assignment couples agent to data source (gates which tasks the auto-assigner will route to them).

## Product gaps (PM) — one of these is a hard functional break

| Priority | Gap |
|---|---|
| **🔴 P0** | **No Skill management UI.** Drawer has Profile/Sources/Stores/Schedule but **no Skills tab**. Yet rules require skills, and `pickAssignee` filters on skill match. Today an agent will never be auto-assigned a skill-required task unless skills are inserted via raw SQL. **The Task Rules drawer says "No skill tags defined — create them in Team" — pointing at a section that doesn't exist. Closed-loop dead-end.** |
| **P0** | **No CSV bulk import** of agents. Teams of 50+ start with 50 manual creates. |
| **P1** | **No agent-side onboarding email / forced password change** on first login. Head sets a password and shares verbally. |
| **P1** | **No team-wide weekly schedule view** ("who's working Saturday?"). |
| **P1** | **No store-first lens** — can't ask "which agents are tied to Store X". |
| P2 | "Sources" tab label is ambiguous (vs Stores). Could be "Capabilities" or "Data Sources". |
| P2 | "Mark Active" / "Revert Exception" buttons swap based on hidden state; action unpredictable. |
| P2 | "max concurrent tasks" buried in Profile; no team-wide view to compare/balance. |
| P2 | No "Send welcome email" affordance on add. |

## Architecture findings

- **Triple roster mechanism** — the most damaging architectural issue in the codebase:

| Mechanism | Owner | Used by |
|---|---|---|
| `WeeklySchedule` (HH:MM strings) | day-of-week template | `pickAssignee`, `GET /api/team`, manual task assign |
| `RosterException` (DATE) | per-day override | same |
| `DailyRoster` (DATE+status) | older API+UI surface | `GET /api/dashboard:102`, `/api/roster/route.ts:40,93`, `/api/team/me/roster`, `lib/task-creation/roster-validator.ts:56` |

`DailyRoster` is the legacy mechanism; the consolidated `lib/roster/availability.ts` does not consult it. `pickAssignee` runs on the new mechanism. `dashboard/route.ts:185` reads `dailyRosters?.[0]?.status ?? "OFF"` — **Command Center display is on the legacy mechanism, while assignment runs on the new one. Two views, two truths.**

`analytics/agents/route.ts:32-89` re-implements `calculateRosterStatus` from scratch — uses local `now.getDay()` not UTC, references nonexistent columns `breakStartTime`/`breakEndTime` (schema has `breakStart`/`breakEnd`). Break-window check is silently a no-op.

`lib/task-creation/roster-validator.ts:73` is a fourth implementation with `date.getDay()` not `getUTCDay()`.

- **`RoundRobinState.orderType`** exists in PG (NOT NULL) but is **not in the Prisma model**. The 2026-05-09 migration `20260509_fix_round_robin_order_type.sql` band-aids it with `DEFAULT ''`. **Drop the column.**
- **`team_member_order_types`** table — created by `20260503_add_order_type_assignments.sql`, replaced by `team_member_capabilities` in `20260509_refactor_datasource_rules.sql`. The refactor migration **never drops the old table**. Whether it's gone depends on which migrations a fresh DB ran.
- **`GET /api/team` runs `calculateTaskStats(userId, "month")` and `..."week"` per member** sequentially-await'd inside `Promise.all` (route.ts:104-107). Each stat call is one Prisma query → **2N queries per dashboard refresh**. At 50 agents that's ~100 queries.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P0** | **Promote-to-OPS_HEAD privilege escalation**: POST `/team` accepts any `role` string with no enum check; PATCH has the same hole | `src/app/api/team/route.ts:165-169`; `[id]/route.ts:41` |
| 🔴 **P0** | **DELETE team-member wipes audit history** — nulls `assignedToId` on every task the user ever owned, including COMPLETED. `where: { assignedToId: targetId }` has no status filter. | `src/app/api/team/[id]/route.ts:100-103` |
| 🔴 **P1** | **GET `/api/team` is open to any authenticated user**, including OPS_AGENT. Agents can enumerate peer emails, performance stats, store assignments, current load. | `src/app/api/team/route.ts:58-60` |
| 🔴 **P1** | **`storeId` flatten-to-first-assignment** — `storeAssignments?.[0]?.storeId \|\| 0`. For multi-store agents, the team UI shows the wrong store. The `\|\| 0` default also collides with a real store id of 0. | `src/app/api/team/route.ts:123` |
| 🟡 P2 | **`hasException` always `false`** — the actual query is commented out. Frontend depends on this for "needs schedule" hints. | `src/app/api/team/route.ts:104-109` |
| 🟡 | `getUTCDayOfWeek` for IST-anchored schedules — at 04:00 IST Monday, UTC is Sunday 22:30 — day-of-week says Sunday while local IST says Monday. Edge case: schedules straddling IST midnight assign wrong day. | `lib/roster/availability.ts:83-85` |
| 🟡 | Member with no schedule rows + no exception → returned as "OFF" — silent lockout (no warning to head). | — |
| 🟡 | Race between PATCH `/team/[id]` and active session — token still valid until expiry. | — |
| 🟡 | Reset password length check (8) but no complexity check, no rate limit. | — |
| 🟡 | POST `email` — no email regex, just `.toLowerCase()` + `findUnique`. | — |
| 🟡 | `maxConcurrentTasks` accepts any positive int including absurd 10^9. | `[id]/route.ts:60-66` |

## Future PM roadmap (ranked)

1. **Skills UI** in the team drawer (P0 — fixes the closed-loop break).
2. **CSV bulk import** (Name, Email, Role, Phone, Stores, Skills, Capabilities, Max Tasks).
3. **Team weekly heatmap** — agents × days grid; one-click conflict detection.
4. **Auto-forward on OOO** — when marking Off/Leave, prompt "Reassign their N open tasks to..." with least-loaded suggestion.
5. **Agent self-service profile** — agent edits own phone/photo, head approves.
6. **Team performance leaderboard** in Team panel itself (not buried in Analytics).
7. **Skill matrix view** — which skills are under-staffed.
8. **Shift handover view** — end-of-shift handoff to next agent.

## Feedback / decisions

> Add notes below.

-

