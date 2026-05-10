# OpsFlow Demo — Expected Tasks Per Seed Order

Run `./tests/demo/run-demo.sh demo` to execute and verify automatically.

All demo rows are reserved in the **8800001–8800099** ID range across `Appointment`, `Order`, and `PharmaOrder`. Cleanup is keyed on this range.

## How sources are polled

| Source | Poll path |
|---|---|
| Lab Orders (`public."Order"`) | Legacy poller in `src/lib/engine/poller.ts` (auto, every 5 min). Manual trigger: `GET /api/debug/trigger-poller`. |
| Appointments (`public."Appointment"`) | Demo helper `tests/demo/poll-appointments.ts` (scoped to demo ID range). The multi-source engine that would auto-poll this is disabled in `src/instrumentation.ts` due to a duplicate-cron issue — `run-demo.sh poll` invokes the helper directly so the demo still exercises every Appointments rule end-to-end. |
| PharmaOrder | Same as Appointments — would be polled by the multi-source engine if it were enabled. No active rules are registered today, so the demo seeds rows but expects 0 tasks. |

## Active rules (10)

| # | Rule | Source | Allowed types | Statuses | Wait | Priority |
|---|------|--------|---------------|----------|------|----------|
| R1 | HSC · Pre-Visit: Confirm Phlebo | Lab Orders | `HOME_SAMPLE` | `ORDER_SCHEDULED`, `PHLEBO_ASSIGNED` | — | HIGH |
| R2 | HSC · Confirm New Order | Lab Orders | `HOME_SAMPLE` | `PENDING`, `CREATED`, `ORDER_SCHEDULED` | — | HIGH |
| R4 | HSC · Capture Report ETA | Lab Orders | `HOME_SAMPLE` | `SAMPLE_DELIVERED` | — | MEDIUM |
| R5 | HSC · Report Follow-Up & Upload | Lab Orders | `HOME_SAMPLE` | `SAMPLE_PROCESSED` | — | MEDIUM |
| R8 | HSC · Collection Follow-Up | Lab Orders | `HOME_SAMPLE` | `PHLEBO_ASSIGNED`, `SAMPLE_COLLECTED` | **appt ≥ 30m past** | HIGH |
| R9 | HSC · Sample Delivery Check | Lab Orders | `HOME_SAMPLE` | `SAMPLE_COLLECTED` | **status held ≥ 30m** | HIGH |
| R6 | CV · Confirm Centre Appointment | Appointments | _(any)_ | `CREATED`, `PENDING` | — | HIGH |
| R7a | CV · Day-of Check: Call Centre | Appointments | `CENTER_VISIT` | `CONFIRMED` | — | HIGH |
| R7b | CV · T-1: Reconfirm Centre Booking | Appointments | `CENTER_VISIT` | `CONFIRMED` | — | HIGH |
| R10 | CV · Post-Visit: Confirm Test Done | Appointments | `CENTER_VISIT` | `CHECKED_IN` | — | MEDIUM |

The wait conditions (R8 `minutesAfterAppointment ≥ 30`, R9 `minutesSinceStatusUpdated ≥ 30`) are why the demo carefully sets `appointmentTime` and `statusUpdatedAt` per row.

## Lab Orders (`public.Order`) — 10 rows, 8800001..8800010

| ID | orderType | orderStatus | appointmentTime | statusUpdatedAt | Triggers | Expected | Title pattern |
|----|-----------|-------------|-----------------|------------------|----------|----------|---------------|
| 8800001 | HOME_SAMPLE | ORDER_SCHEDULED | NOW + 4h | NOW | R1 + R2 | **2** | "Pre-Visit: Confirm Phlebo Assigned…" / "Confirm Order…" |
| 8800002 | HOME_SAMPLE | PHLEBO_ASSIGNED | NOW − 2h | NOW | R1 + R8 | **2** | "Pre-Visit…" / "Collection Check: Confirm Sample Collected…" |
| 8800003 | HOME_SAMPLE | SAMPLE_COLLECTED | NOW − 3h | NOW − 45m | R8 + R9 | **2** | "Collection Check…" / "Sample Delivery: Confirm Lab Receipt…" |
| 8800004 | HOME_SAMPLE | SAMPLE_DELIVERED | NOW − 1d | NOW | R4 | **1** | "Capture Report ETA…" |
| 8800005 | HOME_SAMPLE | SAMPLE_PROCESSED | NOW − 1d | NOW | R5 | **1** | "Reports Pending: Follow Up & Upload…" |
| 8800006 | HOME_SAMPLE | REPORT_DELIVERED | … | … | _(none — terminal)_ | 0 | — |
| 8800007 | CENTER_VISIT | ORDER_SCHEDULED | … | … | _(type mismatch)_ | 0 | — |
| 8800008 | CAMP | PHLEBO_ASSIGNED | … | … | _(type mismatch)_ | 0 | — |
| 8800009 | KIT_BASED | SAMPLE_COLLECTED | … | … | _(type mismatch)_ | 0 | — |
| 8800010 | HOME_SAMPLE | CANCELED | … | … | _(terminal)_ | 0 | — |

**Lab Orders subtotal: 8 tasks**

## Appointments (`public.Appointment`) — 10 rows, 8800001..8800010

Polled by the demo helper `poll-appointments.ts`. Engine tags resulting tasks with `entityType="APPOINTMENTS"`.

| ID | appointmentType | appointmentStatus | Triggers | Expected | Title pattern |
|----|-----------------|-------------------|----------|----------|---------------|
| 8800001 | CENTER_VISIT | CREATED | R6 | **1** | "Confirm Centre Appointment…" |
| 8800002 | CENTER_VISIT | PENDING | R6 | **1** | "Confirm Centre Appointment…" |
| 8800003 | CENTER_VISIT | CONFIRMED | R7a + R7b | **2** | "Day-of Check: Call Centre…" / "T-1: Reconfirm Centre Booking…" |
| 8800004 | CENTER_VISIT | CHECKED_IN | R10 | **1** | "Post-Visit: Confirm Test Completed…" |
| 8800005 | CENTER_VISIT | COMPLETED | (terminal — filtered) | 0 | — |
| 8800006 | HOME_VISIT | CREATED | R6 (any-type) | **1** | "Confirm Centre Appointment…" |
| 8800007 | ONLINE | CONFIRMED | (R7 wants CENTER_VISIT) | 0 | — |
| 8800008 | CENTER_VISIT | CANCELED | (terminal — filtered) | 0 | — |
| 8800009 | CENTER_VISIT | DELAYED | (no rule for DELAYED) | 0 | — |
| 8800010 | CENTER_VISIT | RESCHEDULED | (no rule for RESCHEDULED) | 0 | — |

**Appointments subtotal: 6 tasks**

## PharmaOrder (`public.PharmaOrder`) — 3 rows, 8800001..8800003

No rules registered. Used to demonstrate "source ingested but no rule fired".

| ID | orderType | orderStatus | Expected |
|----|-----------|-------------|----------|
| 8800001 | HOME_DELIVERY | CREATED | 0 |
| 8800002 | HOME_DELIVERY | CONFIRMED | 0 |
| 8800003 | PICKUP | SHIPPED | 0 |

## Grand total

| Source | Tasks |
|---|---|
| Lab Orders | 8 |
| Appointments | 6 |
| PharmaOrder | 0 |
| **Total** | **14** |

`verify.ts` asserts all 23 expectation rows (10 Lab Orders + 10 Appointments + 3 PharmaOrder), including the negative cases.

## Negative cases verified

- Type mismatches (R1–R5/R8/R9 require HOME_SAMPLE): rows 8800007–8800009
- Terminal statuses (REPORT_DELIVERED, COMPLETED, CANCELED): row 8800006, 8800010
- Status with no rule (DELAYED, RESCHEDULED): rows 8800009, 8800010 (Appointment side)
- Any-type rule (R6) would fire on HOME_VISIT: row 8800006 (Appointment)
- Specific-type rule (R7) doesn't fire on ONLINE: row 8800007 (Appointment)
- Timing condition (R8 needs appt ≥ 30m past): rows that satisfy vs not
- Timing condition (R9 needs status held ≥ 30m): row 8800003 satisfies, others don't

## Idempotency

- `seed-orders.sql` uses `INSERT … ON CONFLICT (id) DO NOTHING` — safe to re-run
- The engine de-duplicates tasks via `@@unique([taskRuleId, entityId])` constraint — re-polling does not duplicate
- `cleanup.sql` is double-scoped (ID range AND `internalNotes LIKE '[DEMO-OPSFLOW]%'`) so it can never touch real labstack rows

To start from a clean baseline, always run `./run-demo.sh cleanup` first (or use `./run-demo.sh demo` which does it automatically).
