-- Create PollingLock table for distributed polling coordination
-- Prevents concurrent polling cycles by using database-level locks

CREATE TABLE taskos."polling_locks" (
    "id" SERIAL PRIMARY KEY,
    "lockKey" INTEGER NOT NULL UNIQUE,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polling_locks_lockKey_key" UNIQUE ("lockKey")
);

-- Create index for efficient lock lookups
CREATE INDEX "polling_locks_lockedUntil_idx" ON taskos."polling_locks"("lockedUntil");

-- Add comment explaining the purpose
COMMENT ON TABLE taskos."polling_locks" IS 'Distributed lock table for preventing concurrent polling cycles. Fixed lockKey=1000 for single global lock.';
