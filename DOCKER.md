# Running OpsFlow in Docker

The shipping setup assumes the **database already exists** — typically
the labstack Postgres your real deployment connects to. Docker just
runs the app container, which:

1. Connects to the existing DB via `DATABASE_URL`.
2. Applies the `taskos` schema (`prisma db push`) — creates the
   schema + tables if missing, no-op if already present. The labstack
   `public` schema is never touched (the engine only reads from it).
3. Seeds exactly one OPS_HEAD admin user (idempotent upsert).
4. Starts Next.js on port 3000.

## Quickstart (production-ish — points at your real DB)

```bash
# 1. Copy the example and edit DATABASE_URL to your real DB
cp .env.example .env
# →  edit .env: DATABASE_URL=postgresql://user:pass@host:5432/labstack?schema=taskos

# 2. Bring up the app
docker compose up --build
```

When you see `→ Starting Next.js on :3000…`, open
<http://localhost:3000>. Default login:

| Field | Default |
|---|---|
| Email | `admin@opsflow.local` |
| Password | `changeme123` |

Change either before exposing the app to anyone — `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env` (only effective on **first** boot; see
"Resetting the admin password" below for after).

## Quickstart (purely-local stack — fresh Postgres in a container too)

If you don't have a labstack DB to point at and just want to spin a
clean stack to play with:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The dev overlay adds a `db` service running Postgres 16 and overrides
`DATABASE_URL` to point at it. The polling engine has nothing to act
on (no labstack data) but the rest of the UI works.

## What the bootstrap creates

- `taskos` schema with all tables described in `prisma/schema.prisma`
- One OPS_HEAD admin user

That's it. Skill tags, task types, task rules, data sources are all
configured from the UI after you log in.

## Subsequent runs

```bash
docker compose up
```

Both `prisma db push` and the admin seed are idempotent; nothing is
overwritten.

## Resetting the admin password

The seed only sets the password on **first** boot — subsequent boots
don't overwrite it (so a deploy doesn't reset your password). To
change it:

```bash
docker compose exec app node -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();
(async () => {
  const hash = await bcrypt.hash(process.argv[1], 10);
  await p.user.update({ where: { email: 'admin@opsflow.local' }, data: { passwordHash: hash } });
  console.log('done');
  await p.\$disconnect();
})();
" YOUR_NEW_PASSWORD
```

## Logs

```bash
docker compose logs -f app
```

## Splitting source DB from taskos DB

OpsFlow reads source data (orders, appointments, users, stores) from
labstack's `public` schema and writes its own data (tasks, alerts,
sessions, rules) into the `taskos` schema. These can live in **two
different Postgres instances** if you want.

```env
# .env — taskos schema (OpsFlow owns this, writes here)
DATABASE_URL=postgresql://opsflow:secret@taskos-db:5432/opsflow?schema=taskos

# .env — labstack source (read-only; OpsFlow never writes)
LABSTACK_DATABASE_URL=postgresql://reader:secret@labstack-prod:5432/labstack?sslmode=require
```

When `LABSTACK_DATABASE_URL` is unset, it falls back to `DATABASE_URL` —
single-DB deployments don't need to set anything new.

To grant the labstack reader credential only what it needs:

```sql
CREATE USER opsflow_reader WITH PASSWORD '...';
GRANT CONNECT ON DATABASE labstack TO opsflow_reader;
GRANT USAGE ON SCHEMA public TO opsflow_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO opsflow_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO opsflow_reader;
```

OpsFlow never writes to labstack; SELECT-only is sufficient.

What cross-DB looks like at runtime:
- Engine fetches orders → labstack DB
- Engine creates tasks → taskos DB
- Dashboard "active orders" count → labstack DB (degrades to 0 + warning if labstack is unreachable)
- Store-name labels in analytics → taskos query for ids, then labstack lookup for names (two-step; no cross-DB JOIN)

## Connecting to a Postgres on the host (macOS / Windows / Linux)

In `.env`, point `DATABASE_URL` at `host.docker.internal` instead of
`localhost`:

```
DATABASE_URL=postgresql://USER:PASS@host.docker.internal:5432/labstack?schema=taskos
```

The compose file already adds the `host-gateway` mapping for Linux,
where `host.docker.internal` doesn't resolve by default.

## Connecting to managed Postgres (RDS, Supabase, etc.)

Most providers require SSL. Add `?sslmode=require` to `DATABASE_URL`:

```
DATABASE_URL=postgresql://user:pass@db.example.com:5432/labstack?schema=taskos&sslmode=require
```

## Troubleshooting

**`✘ DATABASE_URL is not set`** — `.env` missing or `DATABASE_URL` not
filled in. Check `cat .env | grep DATABASE_URL`.

**`✘ database not reachable after 60s`** — the app container can't
reach the DB host you configured. Test from inside:

```bash
docker compose exec app sh
pg_isready -h <host> -p <port>
```

If you're pointing at a host-machine Postgres, make sure it's actually
listening on the IP Docker sees (typically `0.0.0.0`, not just
`localhost`).

**`prisma db push` complains about drift** — your DB has columns the
schema doesn't know about. Either accept (`--accept-data-loss` is
already passed) or drop the schema:

```bash
docker compose exec app sh -c '
node -e "
const { PrismaClient } = require(\"@prisma/client\");
const p = new PrismaClient();
p.\$executeRawUnsafe(\"DROP SCHEMA IF EXISTS taskos CASCADE\").then(() => { console.log(\"dropped\"); return p.\$disconnect(); });
"'
docker compose restart app
```
