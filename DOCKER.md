# Running OpsFlow in Docker

The repo ships with a `Dockerfile` + `docker-compose.yml` that bring up
the full stack (Postgres + Next.js app) with one command.

## First-run

```bash
# 1. Copy the example env (defaults work for local dev as-is)
cp .env.example .env

# 2. Bring up the stack
docker compose up --build
```

The `app` container's entrypoint takes care of every DB-side step:

1. Waits for Postgres to be healthy.
2. Runs `prisma db push` — applies `prisma/schema.prisma` to the
   `taskos` schema. Creates every table the app needs on a fresh DB;
   no-op on an existing one.
3. Seeds exactly one OPS_HEAD admin user (idempotent upsert).
4. Starts Next.js on port 3000.

When you see `✓ Ready in ...` followed by `→ Starting Next.js on :3000…`,
open <http://localhost:3000> and log in.

| Field | Default |
|---|---|
| Email | `admin@opsflow.local` |
| Password | `changeme123` |

Both are configurable via `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`.
**Change the password before exposing the app to anyone.**

## What gets created

- `taskos` schema with all tables described in `prisma/schema.prisma`
- One OPS_HEAD admin user

That's it. Skill tags, task types, task rules, data sources are all
configured from the UI after you log in (Team → Skills, Task Rules → New, etc.).

There's intentionally **no labstack source schema mock**. OpsFlow expects
to point at a real labstack-owned database; the engine queries return
empty until you register a Data Source in the UI that points at one.

## Subsequent runs

```bash
docker compose up
```

`prisma db push` and the admin seed are both idempotent; nothing is
overwritten.

## Wiping the DB and starting fresh

```bash
docker compose down -v   # -v removes the named volume opsflow_pgdata
docker compose up --build
```

## Hitting the database directly

```bash
docker compose exec db psql -U opsflow opsflow
```

## Logs

```bash
docker compose logs -f app
docker compose logs -f db
```

## Troubleshooting

**Container exits with `DATABASE_URL is not set`** — check `.env` is
present and `docker compose` is reading it (it auto-reads `.env` from
the directory you ran the command in).

**`prisma db push` fails with "schema drift"** — your DB has tables
the schema doesn't know about (or vice-versa). Either accept by adding
`--accept-data-loss` (already passed by entrypoint) or drop the DB:
`docker compose down -v`.

**Login returns 401 with the right password** — the seed ran with a
different `ADMIN_PASSWORD` than what's currently in `.env`. The seed
upserts but doesn't overwrite the password. To force a reset, either
edit `docker/seed-admin.ts` to update `passwordHash` on the upsert's
`update` clause, or:

```bash
docker compose exec app node -e "
  const { PrismaClient } = require('@prisma/client');
  const bcrypt = require('bcryptjs');
  const p = new PrismaClient();
  bcrypt.hash(process.argv[1], 10).then(async h => {
    await p.user.update({ where: { email: 'admin@opsflow.local' }, data: { passwordHash: h }});
    console.log('done');
    await p.\$disconnect();
  });
" YOUR_NEW_PASSWORD
```
