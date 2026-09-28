-- Replace the full unique index on (orderId, milestone) with a partial one
-- scoped to ACTIVE rows only.
--
-- The full index made the idempotency guarantee permanent instead of
-- ACTIVE-only: once an order's appointment was rescheduled past a breached
-- deadline, the event was closed CANCELLED/RESCHEDULED (not deleted) — and
-- the full unique index then blocked every future breach for that same
-- (orderId, milestone) pair forever, because detection's `create` always hit
-- the same P2002 the code already treats as "an ACTIVE event already exists,
-- nothing to do." The same permanent block applied to any event that reached
-- CAPPED. A partial index — unique only while status = 'ACTIVE' — keeps the
-- real invariant (at most one open event per pair) while letting a fresh
-- breach be recorded once the previous one has actually closed.
DROP INDEX IF EXISTS "sla_breach_events_orderId_milestone_key";

CREATE UNIQUE INDEX "sla_breach_events_orderId_milestone_active_key"
  ON "sla_breach_events" ("orderId", "milestone")
  WHERE "status" = 'ACTIVE';
