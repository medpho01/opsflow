# Executive Summary

**Bottom line**: The product is **feature-rich on the configuration side, shallow on the agent execution side**, and carries a serious **silent-failure problem** under the hood. ~40 confirmed bugs across the 8 features; **12 are P0** (data leak, auth bypass, or wrong results). The codebase shows multiple incomplete migrations: three coexisting roster mechanisms, a dead `task_rule_source_scopes` table, a fully-disabled-but-shipping 1,100-line "multi-source polling" subsystem, two `next.config` files, and a `prisma/seed.ts` that no longer compiles against the current schema.

**Good news**: most issues have a clear, scoped fix. **No fundamental architecture rewrite required.** Hot paths (polling, rule evaluation, assignment) need targeted hardening for scale, not redesign.

## Verdict per feature

| # | Feature | Product (PM) | Architecture | Quality (QA) |
|---|---|---|---|---|
| 1 | Data Sources | 🟡 functional, lacks preview/templates | 🟢 mostly clean, dead `ruleScopes` table | 🟡 SQL-injection in validate, silent error swallowing |
| 2 | Task Rules | 🟡 powerful but no simulator/clone | 🟡 JSON triggers unvalidated; `MANUAL` magic-string | 🟡 POST skips status validation that PATCH applies |
| 3 | Team | 🔴 **no Skill mgmt UI**, blocks rule auto-assign | 🔴 **3+ roster impls; `RoundRobinState.orderType` band-aid** | 🔴 GET /team open to all roles; role can be set to any string |
| 4 | Task Creation + Assignment | 🟡 strategies advertised but not implemented | 🔴 N+1 isDuplicate, no `since` filter, fragile IST | 🔴 metadata column not fetched → metadata conditions always fail |
| 5 | All Tasks | 🟢 head board strong; agent board very thin | 🟡 `_backup.tsx`/`_v2.tsx` shipping; raw SQL in archive | 🔴 STORE_ADMIN scoping bypassable; `/tasks/archive` unauth |
| 6 | Store Overview | 🟡 read-only observer only | 🟡 4 fetches/refresh; relies on broken /api/tasks scoping | 🔴 inherits cross-store bypass; `/api/stores` returns all |
| 7 | Analytics | 🔴 no source/rule/store-level analytics | 🔴 third re-impl of `calculateRosterStatus` w/ wrong cols | 🟡 "today" anchored to UTC midnight, IST off by 5:30h |
| 8 | Command Center | 🟡 dense + useful, no drill-in | 🔴 12 queries/refresh; reads dead `dailyRosters` | 🔴 No role check; **whole team shows OFF** |

## Top recurring patterns

| # | Theme | Where |
|---|---|---|
| 1 | **Three coexisting roster mechanisms** with different bugs in each. Display ≠ assignment ≠ analytics. | `dailyRosters`, `weekly_schedules`+`roster_exceptions`, `analytics/agents`, `roster-validator` |
| 2 | **STORE_ADMIN scoping consistently broken** — only role with row-level visibility limits, fixed inconsistently | 5+ endpoints |
| 3 | **Silent-failure / catch-and-return-null** patterns | `pickAssignee.catch()`, `appendOrderNote.catch()`, `fetchAllActiveOrders().catch(() => 0)`, `/api/stores` triple try/catch |
| 4 | **Timezone fragility** — server in UTC + DB in IST + naive timestamps + `setHours` localisation = 5:30h drift in 5+ places | `dashboard`, `analytics/*`, `roster-validator`, `availability.ts:57` |
| 5 | **Migration drift**: standalone `.sql` files Prisma-migrate ignores; seed broken; `OrderType` enum dropped but still imported | `prisma/migrations/`, `prisma/seed.ts` |
| 6 | **Dead code shipping**: 1,500+ LOC of disabled subsystems, backup component files, dropped-but-not-cleaned tables | `src/lib/polling/`, `_backup.tsx`/`_v2.tsx`, `task_rule_source_scopes`, `team_member_order_types` |

## Single biggest product opportunity

**The agent execution console.** Today an OPS_AGENT gets a title + 3-step checklist + 8 metadata fields + read-only OrderQuickView. Everything they need to actually fulfil the task is missing: SOP/script per task type, customer history, clickable phone (`tel:`/`wa.me/`), order timeline, escalation contacts, structured outcome capture. The current `TaskDetailPanel` is a checkbox list, not a workflow tool. **This unlocks ROI on the rule engine you've already built.**

## 90-day roadmap shape

- **Phase 1 — Stabilize (Weeks 1-3)**: kill the 12 P0 bugs, lock down auth, fix setup ergonomics. Adds Skills UI to Team.
- **Phase 2 — Strengthen (Weeks 4-6)**: engine performance (batch isDuplicate, $since filter, advisory lock, transaction wrap), kill dead code, consolidate roster, harden timezones, add missing indexes.
- **Phase 3 — Extend (Weeks 7-10)**: rule simulator + clone + template library; **agent execution console**; onboarding artifacts; saved filter views; Command Center drill-in; Skills CSV import.
- **Phase 4 — Polish & realtime (Weeks 11-13)**: SSE + Postgres LISTEN/NOTIFY for near-realtime; source health; per-source/rule/store analytics; implement the assignment strategies; webhook ingestion; engine dry-run/replay.

Detailed plan in [10-roadmap.md](./10-roadmap.md). P0 details in [p0-fixes.md](./p0-fixes.md).

## Quick stats

- Confirmed bugs: ~40
- Suspected bugs: ~20
- P0 issues: 12 · P1: ~20
- Duplicate-source-of-truth instances: 4
- Dead code surface: ~1,500 LOC
- Authorization gaps: 7 endpoints
- Timezone-fragile sites: ~15 (5 broken, 6 fragile-but-working, 4 correct)
- Automated test coverage: effectively zero on production code
