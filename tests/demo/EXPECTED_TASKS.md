# OpsFlow Demo — Expected Tasks Per Seed Order

Run `./tests/demo/run-demo.sh demo` to execute and verify automatically.

All demo rows are reserved in the **8800001–8800099** ID range across `Appointment`, `Order`, and `PharmaOrder`. Cleanup is keyed on this range.

## Important: Engine reality

The legacy poller in `src/lib/engine/poller.ts` polls **only `public."Order"` (Lab Orders)**. Rules registered against `Appointments` and `PharmaOrder` exist in the DB but the multi-source engine that would poll those sources is intentionally disabled in `src/instrumentation.ts` (it created duplicate cron jobs that tripled DB load). Until that's re-architected, **only Lab Orders demo rows will produce tasks**.

The demo seeds Appointment + PharmaOrder rows anyway — they're useful to:
1. Show in `/head/data-sources` that the source ingestion path works
2. Demonstrate the limitation explicitly to the team
3. Be ready to assert the correct task counts the moment multi-source polling is re-enabled

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

⚠️ All 10 rows currently produce **0 tasks** because the legacy poller doesn't fetch from `public.Appointment`. Once multi-source polling is re-enabled, these are the expected results:

| ID | appointmentType | appointmentStatus | Triggers (when polling enabled) | Expected (now) | Expected (future) |
|----|-----------------|-------------------|---------------------------------|----------------|-------------------|
| 8800001 | CENTER_VISIT | CREATED | R6 | 0 | 1 |
| 8800002 | CENTER_VISIT | PENDING | R6 | 0 | 1 |
| 8800003 | CENTER_VISIT | CONFIRMED | R7a + R7b | 0 | 2 |
| 8800004 | CENTER_VISIT | CHECKED_IN | R10 | 0 | 1 |
| 8800005 | CENTER_VISIT | COMPLETED | (terminal) | 0 | 0 |
| 8800006 | HOME_VISIT | CREATED | R6 (any-type) | 0 | 1 |
| 8800007 | ONLINE | CONFIRMED | (R7 wants CENTER_VISIT) | 0 | 0 |
| 8800008 | CENTER_VISIT | CANCELED | (terminal) | 0 | 0 |
| 8800009 | CENTER_VISIT | DELAYED | (no rule) | 0 | 0 |
| 8800010 | CENTER_VISIT | RESCHEDULED | (no rule) | 0 | 0 |

**Appointments subtotal: 0 tasks now / 6 once polling re-enabled**

## PharmaOrder (`public.PharmaOrder`) — 3 rows, 8800001..8800003

No rules registered. Used to demonstrate "source ingested but no rule fired".

| ID | orderType | orderStatus | Expected |
|----|-----------|-------------|----------|
| 8800001 | HOME_DELIVERY | CREATED | 0 |
| 8800002 | HOME_DELIVERY | CONFIRMED | 0 |
| 8800003 | PICKUP | SHIPPED | 0 |

## Grand totals

| | Now | If multi-source polling enabled |
|---|---|---|
| Lab Orders tasks | 8 | 8 |
| Appointments tasks | 0 | 6 |
| PharmaOrder tasks | 0 | 0 |
| **Total** | **8** | **14** |

`verify.ts` asserts the "Now" column. When multi-source polling is re-enabled, update the `EXPECTATIONS` array in `verify.ts` to use the "future" column.

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
