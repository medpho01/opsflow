#!/usr/bin/env bash
# OpsFlow Demo runner — seed labstack source tables with synthetic orders
# that exercise every active task rule, trigger a poll cycle, and verify
# the engine created the expected tasks.
#
# Reads from tests/demo/{seed-orders.sql, cleanup.sql, verify.ts} and
# expects the OpsFlow Docker stack to be running on localhost:3000 with
# the labstack DB reachable from inside the container.
#
# Usage:
#   ./tests/demo/run-demo.sh seed       # insert demo orders
#   ./tests/demo/run-demo.sh poll       # trigger one engine poll cycle
#   ./tests/demo/run-demo.sh verify     # check actual vs expected tasks
#   ./tests/demo/run-demo.sh cleanup    # remove demo orders + their tasks
#   ./tests/demo/run-demo.sh demo       # cleanup → seed → poll → verify
#   ./tests/demo/run-demo.sh status     # print current demo-row + task counts
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
COMPOSE="docker compose -f $REPO_ROOT/docker-compose.yml"
APP_CONTAINER="taskos-app-1"

# Strip Prisma's `?schema=foo` URI extension before passing DATABASE_URL to
# psql / pg_isready, which don't understand it.
psql_in_container() {
  $COMPOSE exec -T app sh -c '
    CLEAN_URL=$(echo "$DATABASE_URL" | sed "s/?schema=[^&]*//; s/&schema=[^&]*//")
    psql "$CLEAN_URL" "$@"
  ' bash "$@"
}

# Copy SQL into the container and run it against the LABSTACK source DB.
# Demo seed/cleanup target labstack tables (public.Order, public.Appointment,
# public.PharmaOrder), so we use LABSTACK_DATABASE_URL when set, falling
# back to DATABASE_URL when source and taskos share the same DB.
#
# verify reads from the taskos schema, so it uses the default Prisma
# client (DATABASE_URL) via tests/demo/verify.ts.
run_labstack_sql_file() {
  local file="$1"
  local basename
  basename=$(basename "$file")
  docker cp "$file" "$APP_CONTAINER:/tmp/$basename" >/dev/null
  $COMPOSE exec -T app sh -c "
    URL=\${LABSTACK_DATABASE_URL:-\$DATABASE_URL}
    CLEAN_URL=\$(echo \"\$URL\" | sed 's/?schema=[^&]*//; s/&schema=[^&]*//')
    psql \"\$CLEAN_URL\" -v ON_ERROR_STOP=1 -f /tmp/$basename
  "
}

# Same but against the TASKOS DB (DATABASE_URL).
run_taskos_sql_file() {
  local file="$1"
  local basename
  basename=$(basename "$file")
  docker cp "$file" "$APP_CONTAINER:/tmp/$basename" >/dev/null
  $COMPOSE exec -T app sh -c "
    CLEAN_URL=\$(echo \"\$DATABASE_URL\" | sed 's/?schema=[^&]*//; s/&schema=[^&]*//')
    psql \"\$CLEAN_URL\" -v ON_ERROR_STOP=1 -f /tmp/$basename
  "
}

cmd_seed() {
  echo "→ Seeding demo orders…"
  run_labstack_sql_file "$DEMO_DIR/seed-orders.sql"
}

cmd_cleanup() {
  echo "→ Cleaning up demo orders (labstack) + tasks (taskos)…"
  run_labstack_sql_file "$DEMO_DIR/cleanup.sql"
  run_taskos_sql_file "$DEMO_DIR/cleanup-tasks.sql"
}

cmd_poll() {
  echo "→ Triggering manual poll cycle (Lab Orders via legacy poller)…"
  local resp
  resp=$(curl -s "http://localhost:3000/api/debug/trigger-poller")
  echo "   $resp"

  echo "→ Polling Appointments source (demo helper, scoped to demo ID range)…"
  docker cp "$DEMO_DIR/poll-appointments.ts" "$APP_CONTAINER:/tmp/poll-appointments.ts" >/dev/null
  $COMPOSE exec -T -e NODE_PATH=/app/node_modules -w /app app \
    node node_modules/.bin/tsx /tmp/poll-appointments.ts

  echo "→ Waiting 2s for engine to settle…"
  sleep 2
}

cmd_verify() {
  echo "→ Verifying tasks against expectations…"
  # Copy into /tmp (writable for non-root app user). NODE_PATH points at
  # /app/node_modules so the script can resolve @prisma/client from there.
  docker cp "$DEMO_DIR/verify.ts" "$APP_CONTAINER:/tmp/verify.ts" >/dev/null
  $COMPOSE exec -T -e NODE_PATH=/app/node_modules -w /app app node node_modules/.bin/tsx /tmp/verify.ts
}

cmd_status() {
  echo "→ Demo data status:"
  $COMPOSE exec -T app node -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    (async () => {
      const o = await p.\$queryRaw\`SELECT COUNT(*)::int c FROM public.\"Order\"       WHERE id BETWEEN 8800001 AND 8800099\`;
      const a = await p.\$queryRaw\`SELECT COUNT(*)::int c FROM public.\"Appointment\" WHERE id BETWEEN 8800001 AND 8800099\`;
      const ph = await p.\$queryRaw\`SELECT COUNT(*)::int c FROM public.\"PharmaOrder\" WHERE id BETWEEN 8800001 AND 8800099\`;
      const t = await p.task.count({ where: { entityId: { gte: 8800001, lte: 8800099 } } });
      console.log('   Lab Orders   (Order)     :', o[0].c);
      console.log('   Appointments             :', a[0].c);
      console.log('   PharmaOrders             :', ph[0].c);
      console.log('   Tasks created from demo  :', t);
      await p.\$disconnect();
    })();
  "
}

cmd_demo() {
  cmd_cleanup
  cmd_seed
  cmd_poll
  cmd_verify
}

usage() {
  cat <<EOF
Usage: $0 {seed|cleanup|poll|verify|status|demo}

  seed     Insert demo orders into labstack tables (idempotent)
  cleanup  Remove demo orders and their generated tasks
  poll     Trigger one OpsFlow engine poll cycle
  verify   Compare actual created tasks to EXPECTED_TASKS.md
  status   Print current demo row counts + tasks
  demo     cleanup → seed → poll → verify (the full live-demo flow)

See tests/demo/EXPECTED_TASKS.md for the expectation table.
EOF
  exit 1
}

case "${1:-}" in
  seed)    cmd_seed ;;
  cleanup) cmd_cleanup ;;
  poll)    cmd_poll ;;
  verify)  cmd_verify ;;
  status)  cmd_status ;;
  demo)    cmd_demo ;;
  *)       usage ;;
esac
