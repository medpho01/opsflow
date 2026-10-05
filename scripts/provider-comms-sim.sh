#!/usr/bin/env bash
# Local provider-communication scenarios (see scripts/provider-comms-scenarios.ts).
#
#   bash scripts/provider-comms-sim.sh            # all scenarios
#   bash scripts/provider-comms-sim.sh "phlebo"   # only matching ones
#
# Builds two THROWAWAY databases on the local Postgres and never touches others:
#   labstack_sim         — a copy of the local `labstack` DB's order tables
#   opsflow_comms_scratch — OpsFlow, schema pushed fresh each run
set -euo pipefail
cd "$(dirname "$0")/.."
PG="${PG_URL:-postgresql://$(whoami)@localhost:5432}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.14.0/bin}"
export PATH="$NODE_BIN:$PATH"

if ! psql "$PG/labstack_sim" -Atc "select 1" >/dev/null 2>&1; then
  echo "→ building labstack_sim from the local labstack DB (one-off)…"
  createdb labstack_sim
  pg_dump -s -d labstack | psql -q -d labstack_sim >/dev/null
  pg_dump -a --disable-triggers -d labstack \
    -t 'public."Order"' -t 'public."User"' -t 'public."Profile"' -t 'public."Lab"' -t 'public."Store"' \
    -t 'public."Package"' -t 'public."_OrderToPackage"' -t 'public."Master"' -t 'public."_MasterToPackage"' \
    -t 'public."_MasterToOrder"' -t 'public."OrderMetrics"' | psql -q -d labstack_sim >/dev/null
fi

echo "→ fresh opsflow_comms_scratch…"
dropdb --if-exists opsflow_comms_scratch >/dev/null 2>&1 || true
createdb opsflow_comms_scratch
export DATABASE_URL="$PG/opsflow_comms_scratch?schema=taskos"
export SOURCE_DATABASE_URL="$PG/labstack_sim"
export LABSTACK_CONFIRMATION_KEY="${LABSTACK_CONFIRMATION_KEY:-0123456789abcdef0123456789abcdef}"
export TIMEZONE="Asia/Kolkata"
npx prisma db push --skip-generate --accept-data-loss >/dev/null

if [ -n "${RAW:-}" ]; then npx tsx scripts/provider-comms-scenarios.ts "${1:-}"; else npx tsx scripts/provider-comms-scenarios.ts "${1:-}" 2>&1 | grep -v "^\[MessageRules\]\|^\[Replies\]\|^\[PollVotes\]\|^→"; fi
