# 7. Analytics

> **What it is**: Two stacked panels at `/head/analytics` — Agent Performance (per-agent completed/open/breached/SLA score/load over Today/7d/30d) and Daily Summary (per-day stats + agent breakdown + poll-cycle health).
>
> **Primary user**: OPS_HEAD
>
> **Verdict**: 🔴 PM · 🔴 Architect · 🟡 QA — missing the dimensions ops actually wants to slice by

## Strengths

- Range selector (Today / 7d / 30d) on Agent Performance.
- Per-agent SLA bar with traffic-light coloring.
- Load bar visualizing capacity utilization.
- Daily Summary covers ops + engine health (poll cycles, errors, avg duration).
- Quick-date chips (Today / Yesterday / 2 days ago).

## Product gaps (PM)

| Priority | Gap |
|---|---|
| **P0** | **No source-level analytics.** Cannot answer "are LabStack home-sample tasks doing better than centre-visit?". |
| **P0** | **No rule-level analytics.** Cannot answer "which rules are firing most? which produce the most cancelled tasks (false positives)?". |
| **P1** | **No SLA trend over time** (line chart). Only point-in-time scores. |
| **P1** | **No volume forecast / capacity planning.** |
| **P1** | **No store-level analytics** (Store Overview shows current state, not trend). |
| **P1** | **No CSV / chart export** for QBR. |
| P2 | No anomaly detection ("today's breach rate is 3σ above 7d avg"). |
| P2 | No funnel analytics (BOOKED → CONFIRMED → COLLECTED → DELIVERED conversion at each step). |
| P2 | No CSAT integration. |

## UX friction

- One long page with two panels stacked — no tabs, no in-page nav.
- "Avg Time" column on Agent Performance is just `mins` with no breakdown by task type.
- Daily Summary's "poll summary" bundles ops poll metrics into the same view as agent performance — different audiences, same screen.
- Range chips don't include "This quarter" or custom range.

## Architecture findings

- **`analytics/agents/route.ts:32-89` is the third re-implementation of `calculateRosterStatus`** — uses local `now.getDay()` not UTC, references nonexistent columns `breakStartTime`/`breakEndTime` (schema has `breakStart`/`breakEnd`). Break window check is **silently a no-op**.
- **`getRangeStart` (line 26) uses local `setHours(0,0,0,0)`.** With Node in UTC and DB in IST, "today" is misaligned by 5:30h.
- **`agents/route.ts:111-112` uses `Date.UTC` correctly for `rosterExceptions` filter — inconsistent with the rest of the same file.**
- **`summary/route.ts` mixes `Date.UTC` and `setHours` paths.**
- Loads all users + nested tasks since `since` per user — no aggregation push-down; **will OOM at large agent + task counts**. No pagination.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P1** | **"Today" anchored to UTC midnight, not IST midnight.** With Node in UTC, `dayStart = 00:00 UTC = 05:30 IST`. Tasks completed between IST midnight and 05:30 IST counted under wrong day. | `summary/route.ts:30-37`; `agents/route.ts:14-29` |
| 🟡 P2 | SLA health calc uses `agentStats` only (STORE_ADMIN + OPS_AGENT). If an OPS_HEAD ever completes a task, it's missing from numerator but `totalCompleted` counts ALL roles → divisor > numerator. | `summary/route.ts:84-95` |
| 🟡 | Day with zero completed tasks → `slaHealthPercent = 0` (not 100, not null) — disagrees with dashboard which returns 100. | — |
| 🟡 | `date` query param: regex matches but no NaN check on the resulting Date — `9999-99-99` produces garbage but no crash. | — |
| 🟡 | `analytics/agents` references nonexistent columns `breakStartTime`/`breakEndTime` — break check silently no-ops. | line 84-87 |

## Future PM roadmap (ranked)

1. **Source / rule / store / task-type analytics** — break the single Agent Performance view into a Funnel.
2. **Time-series charts** — SLA% over time, completion volume, breach trend.
3. **Cohort analysis** — agents hired this month vs last month.
4. **Cancelled-tasks audit** — quality signal on rule precision.
5. **Custom dashboard builder** — head picks widgets.
6. **Scheduled email digest** — daily/weekly auto-email.
7. **Slice by data source** — every metric drillable by source.
8. **CSAT integration** — pull patient feedback from external source.
9. **CSV / chart export** for QBR.

## Feedback / decisions

> Add notes below.

-

