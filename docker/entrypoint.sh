#!/bin/sh
# Docker container entrypoint.
#
# Order of operations (each step is idempotent):
#   1. Wait for Postgres to accept connections.
#   2. `prisma db push` — applies schema.prisma to the DB. On a fresh
#      database this creates every table OpsFlow needs in the taskos
#      schema. On an existing database it's a no-op (no schema changes).
#      We use db-push rather than `migrate deploy` because the migrations
#      directory has a few legacy bare-SQL files that aren't directory-
#      format Prisma migrations; schema.prisma is the source of truth.
#   3. Seed exactly one OPS_HEAD admin user. Idempotent (upsert).
#   4. Start Next.js on port 3000.
#
# Customise via env:
#   DATABASE_URL    — required
#   ADMIN_EMAIL     — default admin@opsflow.local
#   ADMIN_PASSWORD  — default changeme123 (CHANGE IN PROD)
#   PORT            — default 3000
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "✘ DATABASE_URL is not set. Aborting." >&2
  exit 1
fi

PORT="${PORT:-3000}"

# pg_isready doesn't understand Prisma's `?schema=...` URI extension —
# parse the hostname + port out and pass them directly. Falls back to
# DB_HOST / DB_PORT env vars if the URL isn't in the standard shape.
PG_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-z+]+://[^@]*@([^:/?]+).*|\1|')"
PG_PORT="$(printf '%s' "$DATABASE_URL" | sed -nE 's|^[a-z+]+://[^@]*@[^:/]+:([0-9]+).*|\1|p')"
PG_HOST="${PG_HOST:-${DB_HOST:-db}}"
PG_PORT="${PG_PORT:-${DB_PORT:-5432}}"

echo "→ Waiting for database at ${PG_HOST}:${PG_PORT}…"
for i in $(seq 1 60); do
  if pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
    echo "✔ database reachable"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "✘ database not reachable after 60s — check DATABASE_URL" >&2
    exit 1
  fi
  sleep 1
done

# `prisma db push` reconciles the running schema to schema.prisma. On a
# fresh `taskos` schema this just creates everything (the production
# case). On a database whose `taskos` schema has accumulated drift from
# manual SQL (orphaned enum values, etc.), Prisma may fail trying to
# alter an enum that's referenced by a column default. In that case
# set SKIP_PRISMA_PUSH=true and bring the schema in line yourself.
if [ "${SKIP_PRISMA_PUSH:-false}" = "true" ]; then
  echo "→ Skipping prisma db push (SKIP_PRISMA_PUSH=true)"
else
  echo "→ Applying schema (prisma db push)…"
  node node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate
fi

echo "→ Seeding admin user…"
node node_modules/.bin/tsx docker/seed-admin.ts

echo "→ Starting Next.js on :${PORT}…"
exec node node_modules/next/dist/bin/next start -p "$PORT"
