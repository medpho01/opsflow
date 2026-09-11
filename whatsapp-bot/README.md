# LabStack WhatsApp ops bot (dry-run)

A separate Node service (not part of the Next app) that joins the partner
WhatsApp groups as a **linked device** (Baileys), classifies each message,
looks up live LabStack order/request status, and **logs what it would
reply — sending nothing**. Validate the answers against real traffic, then
enable sending on a dedicated number.

## Why dry-run first

Reading group messages via a linked device is low-risk (it's what WhatsApp
Web does). **Sending programmatically is where WhatsApp bans happen** — so
we prove the bot's answers are correct *before* any auto-reply, and only
enable sending on a **dedicated, throwaway-able number**, never a personal
one (a ban would take your personal WhatsApp with it).

## Setup

```bash
cd whatsapp-bot
cp .env.example .env      # fill SOURCE_DATABASE_URL (the replica)
npm install
npm run start            # first run prints a QR
```

On the phone holding the bot number: **WhatsApp → Settings → Linked
Devices → Link a Device → scan the QR.** Auth persists to `./auth/`, so it
reconnects without re-scanning.

On connect it prints every group the account is in as `jid → subject` —
use that to label partner vs lab groups in config (next iteration).

## What it does today (dry-run)

- Connects, auto-reconnects, discovers groups.
- Per incoming group message: classify → extract order/request ids →
  (for auto-answerable intents) look up live status on the replica →
  print + log **what it would reply**. Sends nothing.
- Two logs: readable console output + `dry-run.log.jsonl` (structured, for
  measuring answer accuracy over the trial).

## Going live (later, deliberately)

1. Move to a **dedicated number**.
2. Confirm `dry-run.log.jsonl` answers are correct.
3. Enable sending (guarded, per-group opt-in) at the marked spot in
   `index.mjs`, set `DRY_RUN=false`.
4. Add the LLM fallback for the REVIEW bucket and the route-to-console +
   lab-group escalation flows.

## Files

- `index.mjs` — Baileys connection + dry-run message handler
- `lib/classifier.mjs` — shared intent classifier (also used by the
  offline analysis in `../scripts/whatsapp-analysis`)
- `lib/lookup.mjs` — replica status lookup (read-only, timeout-bounded)
- `lib/reply.mjs` — composes the would-be reply / disposition note
