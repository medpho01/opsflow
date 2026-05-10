-- Add metadata JSON field to alerts table for storing escalation context, daily summary data, etc.
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
