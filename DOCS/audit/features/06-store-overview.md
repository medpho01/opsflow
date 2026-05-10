# 6. Store Overview

> **What it is**: Per-store summary — Open / Breached / Near SLA / Unassigned / Completed counts + filterable task table.
>
> **Primary users**: STORE_ADMIN (read-only their store), OPS_HEAD (any store)
>
> **Verdict**: 🟡 PM · 🟡 Architect · 🔴 QA — inherits the cross-store scoping bypass from `/api/tasks`

## Strengths

- Store dropdown with city subtitle; "All Stores" view for OPS_HEAD.
- 5-stat KPI strip is immediately scannable.
- Filter tabs (All / Open / Breached / Completed) + total count.
- Refreshes stats every 60s.

## Product gaps (PM)

| Priority | Gap |
|---|---|
| P1 | **Store admin is read-only.** No "I want to escalate this" button; no comment/note. They are an observer. |
| P1 | **No store-specific actions** (e.g. "Mark store closed for the day" → triggers reassignment of pending tasks). |
| P1 | **No store comparison** ("how does my store compare to peers?"). |
| P2 | No SLA trend chart for the store over time. |
| P2 | No phlebo-availability view (which phlebos are working at this store today). |
| P2 | No data-source filter — store admin sees all tasks regardless of source. |

## UX friction

- Store dropdown is at top-right but the page title "Store Overview" doesn't tell a multi-store admin which store is currently selected — only in the dropdown text.
- Stats card colors don't stand out as clickable (they aren't — but they should be, drilling into the filter tab).
- "Unassigned" stat is computed only from first 50 tasks (`limit=50`) — **inaccurate at scale**.
- The fetchStats function fires 4 separate API calls; perceptible UI flash on filter change.

## Architecture findings

- **No dedicated store endpoint** — reuses `/api/tasks`, so all the cross-store leak bugs apply directly here.
- Component does **4 fetches per refresh per client**: 3 stat counts + 1 warning-tasks list. At C clients × 60s polling, this is the heaviest read-amplification surface.
- Stats are computed by `?status=X&limit=1` and reading `pagination.total` — full filter+sort runs to compute a count. **Should use a dedicated count endpoint.**
- `useEffect` chain at lines 158-165 — closure capture issues if `storeQuery` changes (would need a ref or dep).

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P1** | **`/api/stores` returns ALL stores** with no scoping. STORE_ADMIN sees stores they aren't assigned to in the dropdown. | `app/api/stores/route.ts:24-26` |
| 🔴 **P1** | **Inherits the cross-store bypass** from `/api/tasks` (P0 in feature 5). | — |
| 🟡 | "Unassigned" KPI capped at 50 due to `limit=1` hack on a paginated query. | `StoreBoard.tsx` fetchStats |
| 🟡 | STORE_ADMIN with `storeIds: []` (no assignments) — `selectedStoreId` is null, board shows nothing or crashes. | — |
| 🟡 | Store deactivated in labstack but tasks remain — UI shows blank `storeName`. | — |
| 🟡 | City fallback uses `try/catch` → if any other error occurs (timeout) UI gets `{stores: []}` indistinguishable from "no stores". | — |

## Future PM roadmap (ranked)

1. **Store admin commenting / escalation** — let them flag a task to OPS_HEAD with context.
2. **Store closure / blackout** — schedule "Store X closed Tuesday" → engine reassigns or pauses.
3. **Store-vs-peer comparison** — anonymous benchmarking.
4. **Phlebo & inventory pane** — extend Store Overview to show on-duty phlebos and supplies.
5. **Customer feedback tile** — store-level CSAT pulled from order outcomes.
6. **Print / morning-huddle PDF** — daily 1-page summary store admin can post on the wall.
7. **Drill-in from KPI cards** — clicking "Breached: 4" filters the table to those 4.
8. **Dedicated `/api/stores/[id]/overview` endpoint** that returns counts in one query.

## Feedback / decisions

> Add notes below.

-

