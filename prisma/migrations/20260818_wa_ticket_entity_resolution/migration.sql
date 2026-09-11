-- WhatsApp entity-resolution provenance on cases.
-- A bare number can name an Order, a Request, or an Appointment at once; the
-- resolver now ranks candidates and may pick a Request over a stale Order. Store
-- which namespace it chose, how confident it is, any staleness warning, and the
-- runner-up so the console can show a confidence chip + a one-click switch.
-- Additive only, IF NOT EXISTS → safe and re-runnable.

ALTER TABLE "wa_tickets" ADD COLUMN IF NOT EXISTS "entityKind"   TEXT;
ALTER TABLE "wa_tickets" ADD COLUMN IF NOT EXISTS "idConfidence" TEXT;
ALTER TABLE "wa_tickets" ADD COLUMN IF NOT EXISTS "idWarning"    TEXT;
ALTER TABLE "wa_tickets" ADD COLUMN IF NOT EXISTS "idAlt"        JSONB;
