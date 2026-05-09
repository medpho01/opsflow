# 5. All Tasks (head + agent)

> **What it is**: OPS_HEAD All Tasks board with filter/sort/bulk-actions/kanban; OPS_AGENT-facing My Tasks board with active/blocked/done tabs and a detail panel for checklist execution.
>
> **Primary users**: OPS_HEAD (board) + OPS_AGENT (My Tasks)
>
> **Verdict**: 🟢 head board strong · 🔴 agent board very thin · 🟡 Architect · 🔴 QA — biggest single product opportunity is the agent execution console

## Strengths (Head board)

- Unified Filter Bar (status, priority, assignee, source, SLA-risk, **data source — added in this audit cycle**).
- SLA-risk row coloring (safe/warning/critical/breached).
- Status-distribution widget with live counts.
- Bulk reassign / cancel / block.
- Table + Kanban toggle.
- Aging indicator + Assignment-method badge with rule-id tooltip.
- Order quick-view slide-over.
- Pagination + last-updated timestamp + manual refresh.
- **Data Source column — added in this audit cycle.**
- **Default sort changed to `appointmentTime asc` — added in this audit cycle.** Surfaces tasks needing attention now.

## Strengths (Agent board)

- Three-tab simplification (Active / Blocked / Done).
- Sorted by priority then SLA — surfaces what's urgent.
- Auto-refresh every 30s.
- Check-in widget on the board (set my roster status).
- Order ID filter.

## Product gaps — Head

| Priority | Gap |
|---|---|
| P1 | No saved views / filter presets ("My SLA risks", "Unassigned > 30 min"). |
| P1 | Bulk action lacks "reschedule SLA" or "change priority". |
| P2 | No CSV export. |
| P2 | Kanban is read-only (no inline edit for assignee/priority). |
| P2 | No SLA-trend sparkline per task. |

## Product gaps — Agent (the BIG opportunity)

The agent today gets:
- Title (e.g. "Rohit Kumar — Confirm Sample Collected")
- Status / priority / SLA badges
- 8 metadata fields (Patient, Order Type, Lab, Store, Phlebo, Phone, Appointment, Order Status)
- A 3-step checklist
- An "Order #N" link → OrderQuickView (read-only)

What's missing to actually fulfil the task:

| Need | Specific addition |
|---|---|
| **Why this task fired** | Rule name + plain-English trigger reason + matched fields ("order has been in PHLEBO_DISPATCHED for 47m, threshold 30m") |
| **Script / SOP** | Per-TaskType SOP body — 1-page rich text incl. opening line, key questions, objection handlers |
| **Customer context** | Past 5 orders for this patient, last 3 outcomes, complaint flags, preferred call window |
| **Phlebo context** | Their current location/last-checkin, current task load, contact card |
| **Order timeline** | Visual: BOOKED → CONFIRMED → PHLEBO_ASSIGNED → … with timestamps from the source |
| **Geographic context** | Patient address with "Open in Maps" — store-to-patient distance/ETA for HSC |
| **Linked source data** | Lab order details (tests, special instructions, fasting required) pulled from the source row |
| **Escalation contacts** | Names + numbers for "Phlebo Lead" and "Lab Coordinator" stored on TaskType or Source |
| **Suggested call script** | Templated paragraph with `{{patientName}}` already substituted — copy-paste into WhatsApp |
| **One-tap call / WhatsApp** | Phone number rendered as `tel:`/`wa.me/<phone>?text=<template>` deep-link |
| **Outcome capture** | Structured outcome at completion: "Confirmed", "Rescheduled", "Patient unreachable — voicemail", "Lab issue" — feeds analytics |
| **Help / SOP link** | "How do I do this?" link to internal docs / Loom |
| **Snooze** | "Ping me in 15 min" — task drops out of Active and reappears later |
| **In-task chat / @-mention head** | Replace flag-for-help with a real escalation channel |
| **Photo upload + GPS stamp** | Proof-of-collection for HSC tasks |

The current `TaskDetailPanel` is functional but spartan — a checkbox list, not a workflow tool. **This is the single highest-leverage product investment in TaskOs.**

## UX friction

- Head board: emoji icons (🔄, 📦, 📋, 📊) feel inconsistent with the otherwise clean dark-mode aesthetic.
- Agent My Tasks: no badge counts on tabs (Active 12 / Blocked 2 / Done 18).
- Agent: completing a checklist item doesn't auto-advance status; the "Mark Complete" button is a separate action — easy to leave tasks half-done.
- "Note" field has its own save button; users will assume status-change saves the note too.
- Agent has no "snooze" — only Block.

## Architecture findings

- **`AllTasksBoard.tsx` is 600+ lines, plus `_backup.tsx` and `_v2.tsx` siblings shipping in the bundle.** Code-hygiene problem.
- **`Task.assignedToId` (User FK) and `Task.teamMemberId` (TeamMember FK)** are both written in some paths and only one in others. `taskCreator.ts:444` sets only `assignedToId`; manual-task POST sets both. Latent inconsistency: queries that filter by `teamMemberId` will miss auto-assigned tasks.
- **`archive/route.ts` mixes raw SQL JOINs with subselect-per-column** for `taskTypeName`, `dataSourceName` — 4 subselects per row, no index, perf sink at archive scale.
- **`slaRiskOnly` filter is applied post-pagination** (`tasks/route.ts:377-381`) — paginated `total` is wrong; "next page" can show different ratios.
- The role-scope branch (`tasks/route.ts:226-233`) for `STORE_ADMIN` does an extra `prisma.teamMember.findFirst` per request just to derive store IDs — should be cached on the session.
- `appliedFilters` calculation overlaps and partially conflicts with the `where` building — duplicated, easy to drift.

## Confirmed / suspected bugs (QA)

| Severity | Bug | File:line |
|---|---|---|
| 🔴 **P0** | **STORE_ADMIN scoping bypassable**: `where.storeId = { in: ids }` is overwritten by `?storeId=...` query param two lines later | `tasks/route.ts:233 → 243` |
| 🔴 **P0** | **`/api/tasks/archive` has NO authentication** — public endpoint exposes archived tasks and triggers archive job | `tasks/archive/route.ts:9, 30` |
| 🔴 **P0** | **PATCH `/tasks/[id]` allows STORE_ADMIN to edit any task** — no scoping, only OPS_AGENT-not-own is blocked | `tasks/[id]/route.ts:60-62` |
| 🔴 **P1** | **PATCH allows OPS_AGENT to toggle ANY checklist item** if they know the id — no check that `checklistItem.taskId === task.id` | `tasks/[id]/route.ts:101-106` |
| 🔴 **P1** | **Reassignment without validation** — `assignedToId` accepted as-is, no existence/role/roster check. POST does roster check; PATCH doesn't. | `tasks/[id]/route.ts:109-111` |
| 🔴 **P1** | **Archive `EXTRACT(DAY FROM NOW() - ...)` returns 0-30**, not absolute days. UI's `daysSinceAppointment` is wrong for any task older than a month. | `tasks/archive/route.ts:85` |
| 🟡 | `priorityFilter` not enum-validated — Prisma will throw 500 for invalid values | `tasks/route.ts:179-181` |
| 🟡 | `dateTo` is inclusive `lte` — UI passing date-only "2026-05-09" yields midnight, missing all tasks during that day | `tasks/route.ts:213-216` |
| 🟡 | `Math.max(0, minutesRemaining)` returns 0 for breached — UI may rely on the negative value to show "breached by Xm" | `tasks/route.ts:366` |
| 🟡 | Task with `slaDeadline = null` (manual task with bad input) → `new Date(null).getTime() = 0` → "breached by 56 years" | — |
| 🟡 | Task whose assignee was deleted — `assignedTo` becomes null, agent UI may break | — |
| 🟡 | `appendOrderNote` failure swallowed (`.catch(...)`) | `tasks/[id]/route.ts:94-96` |
| 🟡 | `parseInt(id, 10)` not NaN-checked in tasks/[id] — inconsistent with team route | — |

## Future PM roadmap (ranked)

1. **Agent execution console** — SOP, customer history, clickable phone, order timeline, structured outcome capture, snooze, in-task chat. **Highest single product investment.**
2. **Saved filter views** for head ("My SLA risks", "Unassigned > 30 min").
3. **Task detail "Why this task?"** — rule + matched trigger condition + order field values.
4. **Customer 360** sidebar in TaskDetailPanel (patient history, no-shows, complaints).
5. **One-tap call/WhatsApp** — `tel:` + `wa.me/<phone>?text=<template>` deep links.
6. **Snooze** — agent says "ping me in 15 min", task drops out.
7. **In-task chat / @-mention head** — replace flag-for-help.
8. **Photo upload + GPS stamp** — proof-of-collection for HSC tasks.
9. **Voice note to text** — agent records 10s, transcribes into note.
10. **CSV export** of head board for QBR.

## Feedback / decisions

> Add notes below — especially what data/guidance the agent needs first.

-

