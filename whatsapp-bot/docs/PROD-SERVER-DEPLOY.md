# Production Deployment — WhatsApp Control Tower (server)

End-to-end steps to run the Control Tower on a Linux server with Docker Compose.
Everything is headless: **the WhatsApp QR is scanned from the console**, so no
terminal access to the gateway is needed.

## Architecture on the server

```
             ┌──────────────┐        ┌──────────────────────┐
 WhatsApp ──▶│  wa-gateway  │──────▶ │                      │
             │  (Baileys)   │◀────── │   Postgres (taskos)  │◀──▶  app (Next.js console)
             └──────────────┘  queue │   = the bus          │
                    │                └──────────────────────┘
                    └──▶ LabStack replica (read-only) for order/request context
```

Three containers via one compose project: **db**, **app**, **wa-gateway**.

---

## 1. Prerequisites

- Linux host with **Docker Engine + Compose v2**.
- Network reachability from the host to: the **taskos Postgres** (bundled `db`
  or external) and the **LabStack replica** (read-only).
- A strong **`JWT_SECRET`** (≥32 chars).
- The **WhatsApp ops phone** to scan the QR (a dedicated number is recommended
  before enabling send).
- A reverse proxy (nginx/Caddy) + TLS in front of the console (port 3000).

---

## 2. Get the code

```bash
git clone <your-remote> opsflow && cd opsflow
git checkout main   # or the release branch containing the WhatsApp commit
```

---

## 3. Configure environment (`.env` at repo root)

```dotenv
# taskos DB (the console + gateway write here)
DATABASE_URL=postgresql://USER:PASS@db:5432/opsflow?schema=taskos
# LabStack replica — READ ONLY. Leave blank to fall back to DATABASE_URL.
SOURCE_DATABASE_URL=postgresql://reader:PASS@labstack-host:5432/labstack
# auth
JWT_SECRET=<64+ random chars>

# WhatsApp gateway
WA_DRY_RUN=true        # keep true until validated; flip to false to allow sending
WA_GROUP_FILTER=labstack
# If you use the bundled db, also set POSTGRES_USER/PASSWORD/DB.
```

> `TASKOS_DATABASE_URL` for the gateway is derived from `DATABASE_URL` in
> `docker-compose.wa.yml` — you don't set it separately.

---

## 4. Apply the database migration (additive, idempotent)

```bash
# bring up just the DB first (if using the bundled one)
docker compose up -d db

# apply the WhatsApp tables (safe to re-run)
docker compose run --rm app node node_modules/prisma/build/index.js migrate deploy
#   — OR, if you manage migrations out-of-band, apply the SQL directly:
#   psql "$DATABASE_URL" -f prisma/migrations/20260812_whatsapp_control_tower/migration.sql

# verify
psql "$DATABASE_URL" -c "\dt wa_*"   # wa_groups, wa_messages, wa_tickets, wa_outbound, wa_gateway
```

---

## 5. Build & start everything

```bash
docker compose -f docker-compose.yml -f docker-compose.wa.yml build
docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d
docker compose ps           # db, app, wa-gateway all Up
```

The `app` image runs `prisma generate` + `next build` at build time, so it
already has the new models and routes. The `wa-gateway` image bundles Baileys.

---

## 6. Link WhatsApp (from the console — no terminal)

1. Open the console → **Settings → Integrations → WhatsApp**.
2. The connection card shows a **live QR** (the gateway published it to the DB).
3. On the ops phone: **WhatsApp → Settings → Linked Devices → Link a Device** →
   scan. Status flips to **Connected**; the `wa_auth` volume persists it.
4. On connect the gateway **auto-registers** every in-scope group into the
   console. Classify each: **Customer** (SUPPORT) / **Provider** / Internal /
   Ignore, and map Customer→store, Provider→lab.

---

## 7. Go live with sending (deliberate)

Sending is double-gated. To enable:

1. Move to a **dedicated number** (a ban would otherwise take the linked
   account with it). Re-link if you switched numbers.
2. Set **`WA_DRY_RUN=false`** in `.env`, then
   `docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d wa-gateway`.
3. In the console, toggle **Send** on for the pilot group(s) only.
4. Rate-limiting + human-paced spacing are built in.

---

## 8. Verify end-to-end

- `psql "$DATABASE_URL" -c "select status, \"connectedNumber\" from wa_gateway"` → `CONNECTED`.
- Post a message with an order id in a Customer group → a **ticket** appears in
  the console with live order context.
- Reply from the console → the `wa_outbound` row goes `QUEUED → SENT` and lands
  in the group.

---

## 9. Operations

- **Logs:** `docker compose logs -f wa-gateway` · `... logs -f app`.
- **Restart gateway:** `docker compose -f ... -f docker-compose.wa.yml restart wa-gateway`.
- **Re-link / unlink:** buttons in the console Settings (writes a command the
  gateway consumes) — no shell needed.
- **Backups:** `pg_dump` the taskos DB before every migration.
- **Rollback:** redeploy the previous `app` image tag; the WhatsApp tables are
  isolated (`DROP TABLE wa_* CASCADE` + the enums) if you must remove them.
- **PII / DPDP:** partner messages (names, DOB, phone, address) are stored in
  taskos and shown in the console — enforce access control + a retention policy;
  the replica stays read-only.

---

## 10. Upgrades

```bash
git pull
docker compose run --rm app node node_modules/prisma/build/index.js migrate deploy   # if new migrations
docker compose -f docker-compose.yml -f docker-compose.wa.yml build
docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d
```
The `wa_auth` volume persists, so no re-link is needed across upgrades.
