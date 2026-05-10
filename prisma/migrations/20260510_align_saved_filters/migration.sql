-- W6 — Align user_saved_filters with the Prisma model in schema.prisma.
--
-- Live table predated the model and used different column names + was
-- missing usageCount + had no (userId, filterName) unique constraint, so
-- every Prisma call against the model 500'd ("column filterName does not
-- exist"). Realigning the live schema rather than backing the model out
-- because saved filters are about to ship via the head All Tasks UI and
-- the model is the right shape going forward.
--
-- Safe to run: the table was empty when this was authored.
ALTER TABLE taskos.user_saved_filters
  RENAME COLUMN "name"    TO "filterName";

ALTER TABLE taskos.user_saved_filters
  RENAME COLUMN "filters" TO "filterJson";

ALTER TABLE taskos.user_saved_filters
  ADD COLUMN IF NOT EXISTS "usageCount" INT NOT NULL DEFAULT 0;

-- filterName as varchar(255) per Prisma model.
ALTER TABLE taskos.user_saved_filters
  ALTER COLUMN "filterName" TYPE VARCHAR(255);

-- Drop the bare-name uniqueness expectation (model uses composite).
-- (No prior unique constraint on `name` to drop; safe to skip.)

ALTER TABLE taskos.user_saved_filters
  ADD CONSTRAINT "user_saved_filters_userId_filterName_key"
  UNIQUE ("userId", "filterName");
