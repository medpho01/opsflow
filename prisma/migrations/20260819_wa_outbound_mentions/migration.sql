-- Allow an outbound WhatsApp message to @-mention participants: the jids to
-- notify (the message text carries the matching "@<localpart>" tokens).
-- Additive, IF NOT EXISTS → safe and re-runnable.
ALTER TABLE "wa_outbound" ADD COLUMN IF NOT EXISTS "mentions" JSONB;
