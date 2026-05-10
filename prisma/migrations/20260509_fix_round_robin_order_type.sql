-- Fix round_robin_states.orderType column
-- The column is NOT NULL without a default but isn't included in the Prisma model,
-- causing silent insert failures when round-robin tries to create state for a new data source.
-- Adding a default empty string resolves this without changing the Prisma model.

ALTER TABLE taskos.round_robin_states
  ALTER COLUMN "orderType" SET DEFAULT '';
