#!/usr/bin/env bash
#
# OpsFlow PR smoke test — automated pre-merge confidence check.
#
# Runs against the CURRENT git checkout (check out the PR branch first). It does
# NOT touch the running dev stack or its data; the schema check uses a throwaway
# database that is dropped afterward.
#
# Checks (weighted → confidence score /100):
#   • Prisma client generates            (10)
#   • Type-check adds no NEW errors       (20)   vs the known pre-existing set
#   • next build succeeds                 (40)   BLOCKER
#   • Prisma schema applies (scratch DB)  (30)   BLOCKER
#
# A blocker failing caps the recommendation at HOLD regardless of score.
#
# Usage:
#   git fetch origin && git checkout <pr-branch>
#   ./scripts/smoke-test.sh
#
# Requires: docker (a node:20 container is used for build/tsc; the dev `db`
# container is used to spin the scratch database).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

NODE_IMG="node:20-bullseye-slim"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.wa.yml"
BRANCH="$(git branch --show-current || echo detached)"
HEAD_SHA="$(git rev-parse --short HEAD)"

# Known pre-existing tsc errors live in scripts/.tsc-baseline.txt (line/col
# normalised). Regenerate after intentionally accepting a new pre-existing
# error:  ./scripts/smoke-test.sh --update-baseline
TSC_BASELINE="scripts/.tsc-baseline.txt"
normalize_tsc() { grep -E '^src/' "$1" | grep 'error TS' | grep -vE '__tests__|\.test\.' \
  | sed -E 's/\([0-9]+,[0-9]+\)/(L,C)/' | sort -u; }

score=0; MAX=100
declare -a PASS FAIL NOTE
blocker_failed=0
run_node() { docker run --rm -v "$PWD":/work -w /work -e NEXT_TELEMETRY_DISABLED=1 "$NODE_IMG" "$@"; }

echo "════════════════════════════════════════════════════════════════"
echo " OpsFlow smoke test — branch: $BRANCH ($HEAD_SHA)   $(date '+%F %T')"
echo "════════════════════════════════════════════════════════════════"

# ── 1. Prisma generate (10) ──────────────────────────────────────────
echo "→ [1/4] prisma generate…"
if run_node node node_modules/prisma/build/index.js generate >/tmp/smoke_gen.log 2>&1; then
  score=$((score+10)); PASS+=("Prisma client generates (+10)")
else
  FAIL+=("Prisma generate FAILED — see /tmp/smoke_gen.log"); tail -5 /tmp/smoke_gen.log
fi

# ── 2. Type-check: no NEW errors vs baseline (20) ────────────────────
echo "→ [2/4] type-check (new errors vs baseline)…"
run_node ./node_modules/.bin/tsc --noEmit --skipLibCheck --incremental false >/tmp/smoke_tsc.log 2>&1
normalize_tsc /tmp/smoke_tsc.log > /tmp/smoke_tsc_cur.txt
if [ "${1:-}" = "--update-baseline" ]; then
  cp /tmp/smoke_tsc_cur.txt "$TSC_BASELINE"; echo "  ↳ baseline updated ($(wc -l < "$TSC_BASELINE") errors). Re-run without the flag."; exit 0
fi
BASE="$TSC_BASELINE"; [ -f "$BASE" ] || BASE=/dev/null
NEW_TS=$(comm -13 "$BASE" /tmp/smoke_tsc_cur.txt)
NEW_TS_N=$(printf '%s' "$NEW_TS" | grep -c 'error TS' || true)
if [ "${NEW_TS_N:-0}" -eq 0 ]; then
  score=$((score+20)); PASS+=("No new type errors (+20)")
else
  FAIL+=("$NEW_TS_N NEW type error(s) vs baseline:"); printf '%s\n' "$NEW_TS" | sed 's/^/     /'
fi

# ── 3. Production image build (40, BLOCKER) ──────────────────────────
# The real deploy build: fresh npm install + prisma generate + next build in
# the Debian image. Catches native-module / build issues host tooling can't.
echo "→ [3/4] production image build (docker compose build app; a few min)…"
if $COMPOSE build app >/tmp/smoke_build.log 2>&1; then
  score=$((score+40)); PASS+=("Production image builds (+40)")
else
  blocker_failed=1; FAIL+=("BLOCKER: image build FAILED"); tail -30 /tmp/smoke_build.log
fi

# ── 4. Prisma schema applies on a scratch DB (30, BLOCKER) ───────────
echo "→ [4/4] prisma db push on a throwaway database…"
SCRATCH="smoke_${HEAD_SHA}_$$"
DBURL="postgresql://opsflow:opsflow_dev_password@host.docker.internal:5433/${SCRATCH}?schema=taskos"
if $COMPOSE exec -T db psql -U opsflow -d opsflow -c "CREATE DATABASE \"$SCRATCH\";" >/tmp/smoke_dbcreate.log 2>&1; then
  if docker run --rm -v "$PWD":/work -w /work -e DATABASE_URL="$DBURL" "$NODE_IMG" \
       node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss >/tmp/smoke_push.log 2>&1; then
    score=$((score+30)); PASS+=("Schema applies cleanly (+30)")
  else
    blocker_failed=1; FAIL+=("BLOCKER: prisma db push FAILED"); tail -20 /tmp/smoke_push.log
  fi
  $COMPOSE exec -T db psql -U opsflow -d opsflow -c "DROP DATABASE IF EXISTS \"$SCRATCH\";" >/dev/null 2>&1
else
  NOTE+=("db push SKIPPED — could not create scratch DB (dev 'db' container not up?)")
fi

# ── Verdict ──────────────────────────────────────────────────────────
echo
echo "──────────────────────── RESULT ────────────────────────"
for p in "${PASS[@]:-}"; do [ -n "$p" ] && echo "  ✅ $p"; done
for n in "${NOTE[@]:-}"; do [ -n "$n" ] && echo "  ⚠️  $n"; done
for f in "${FAIL[@]:-}"; do [ -n "$f" ] && echo "  ❌ $f"; done
echo "─────────────────────────────────────────────────────────"
echo "  CONFIDENCE: ${score}/${MAX}"
if [ "$blocker_failed" -eq 1 ]; then
  echo "  RECOMMENDATION: ❌ HOLD — a blocker failed. Do not merge."
  exit 1
elif [ "$score" -ge 85 ]; then
  echo "  RECOMMENDATION: ✅ MERGE — high confidence."
elif [ "$score" -ge 70 ]; then
  echo "  RECOMMENDATION: 🟡 MERGE WITH REVIEW — check the notes above."
else
  echo "  RECOMMENDATION: ❌ HOLD — low confidence."
  exit 1
fi
echo "  Logs: /tmp/smoke_{gen,tsc,build,push}.log"
