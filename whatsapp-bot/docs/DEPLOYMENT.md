# WhatsApp Control Tower — Deployment Runbook

**Status of the build — the WhatsApp Control Tower is BUILT and verified end-to-end** (locally, against the taskos schema): data model, gateway↔DB integration, API routes, the dedicated Control Tower inbox, the Settings page (QR link + group classification), and the sidebar nav. Verified: real tickets render, live LabStack context loads in the panel, the QR renders in Settings, auth gates on OPS_HEAD.

Ship checklist (all four must land together in prod):
1. **Migration** — creates the 5 tables (`wa_groups/messages/tickets/outbound/gateway` + enums).
2. **App deps** — `qrcode` + `@types/qrcode` added to package.json (server-side QR render).
3. **Prisma client regenerated** in the app image (so `prisma.waTicket` etc. exist).
4. **Gateway** — needs `TASKOS_DATABASE_URL` (the taskos schema) so it can write messages/tickets and drain the outbound queue.

---

## 0. Prerequisites & pre-checks

```bash
# Node 20 for the Prisma CLI (Node 12 silently corrupts prisma/tsc)
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"

# Confirm WHICH database the running app actually uses (this is the one gap we
# flagged — the local host-Postgres looked behind the committed migrations).
docker compose exec -T app printenv DATABASE_URL     # the live URL the app talks to
```

- **Take a backup before any migration:**
  ```bash
  pg_dump "<LIVE_DATABASE_URL>" -Fc -f taskos-backup-$(date +%Y%m%d).dump
  ```

---

## 1. Apply the migration (additive, idempotent)

The migration is guarded with `IF NOT EXISTS` / `duplicate_object` catches, so it is safe to run and re-run. Two ways — pick based on your migration history:

**A. Direct SQL — recommended** (isolated to the WhatsApp tables, ignores any unrelated drift):
```bash
psql "<LIVE_DATABASE_URL>" -f prisma/migrations/20260812_whatsapp_control_tower/migration.sql
```

**B. Prisma migrate deploy** — only if the app's migration history is in sync in prod
(it will also try to apply any *other* pending migrations, so A is safer here):
```bash
docker compose exec -T app npx prisma migrate deploy
```

**Verify the tables exist:**
```bash
psql "<LIVE_DATABASE_URL>" -c "\dt wa_*"
# expect: wa_groups, wa_messages, wa_tickets, wa_outbound, wa_gateway
```

---

## 2. Ship the app with the new Prisma client

The app image must be rebuilt so its Prisma client knows the new models (only matters
once the API/UI code lands; harmless to do now):
```bash
docker compose exec -T app npx prisma generate     # or bake into the image build
docker compose build app
docker compose up -d app
```

---

## 3. (When built) Seed the 49 groups

```bash
node scripts/seed-wa-groups.mjs      # inserts jid+subject as WaGroup rows (role SUPPORT default)
```
Then classify each group in **Settings › Integrations › WhatsApp** (Customer / Provider / Internal / Ignore + store/lab mapping).

---

## 4. Gateway service (the Baileys bridge)

Already deployed on this Mac as a launchd agent (`ai.finclarity.wabot`) — see `whatsapp-bot/README`. For the Control Tower it must (a) point at the **live** DATABASE_URL and (b) run the DB ingestion + outbound-drain code (not yet built).

```bash
# health / control (current dry-run service)
launchctl list | grep finclarity
launchctl kickstart -k gui/$(id -u)/ai.finclarity.wabot   # restart
tail -f /tmp/wabot.launchd.out                            # logs
```

**Production caveat:** launchd on a laptop starts at **login** and stops on shutdown/sleep loss. For real production, run the gateway on an always-on host (a small VM / mini-server) as a systemd/pm2 service, pointed at the live DB. Keep `.env` there with `SOURCE_DATABASE_URL` (replica) + `DATABASE_URL` (taskos).

---

## 5. Link + go live (admin, in the console)

1. Open **Settings › Integrations › WhatsApp** → **Re-link (show QR)** → scan from the ops phone (**WhatsApp → Linked Devices → Link a Device**).
2. Classify groups; set `Active` on the ones to listen to.
3. **Sending stays off** until you flip `sendEnabled` per group. Reading is zero-risk; sending from the number carries ban risk (rate-limited + human-paced in code).

---

## 6. Verify end-to-end

- `wa_gateway.status = CONNECTED`, `connectedNumber` set, `lastSeenAt` fresh.
- New group messages appear as `wa_messages` rows and surface as tickets in the Inbox.
- Post a test reply from the console → `wa_outbound` row goes `QUEUED → SENT`, message lands in the group.
- Gateway-offline banner shows if you stop the service.

---

## Rollback

The WhatsApp tables are fully isolated — nothing else references them:
```sql
DROP TABLE IF EXISTS wa_outbound, wa_messages, wa_tickets, wa_groups, wa_gateway CASCADE;
DROP TYPE IF EXISTS "WaGatewayStatus","WaOutboundStatus","WaMsgDirection","WaTicketStatus","WaGroupRole";
```
Restore from the backup dump if needed. Removing the launchd agent:
```bash
launchctl bootout gui/$(id -u)/ai.finclarity.wabot
launchctl bootout gui/$(id -u)/ai.finclarity.wabot-refresh
```
