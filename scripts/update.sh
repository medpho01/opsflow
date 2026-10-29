#!/usr/bin/env bash
# Bring the VM up to the pushed code with the least disruption (29 Oct 2026).
#
#   bash scripts/update.sh
#
# The worker (agent logic) and the WhatsApp gateway run from the checkout, so most fixes need only
# a pull and a restart of the container whose code changed — seconds, no image build. A change to
# the web app, the database schema, dependencies or the images still needs the full deploy
# (scripts/deploy.sh with a package built at the same commit); this script says so and stops.
set -euo pipefail
# The whole script is read before it runs: `git pull` below may replace this very file.
main() {
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.wa.yml"
BEFORE=$(git rev-parse HEAD)
git pull -q --ff-only
AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" = "$AFTER" ]; then echo "already at $(git rev-parse --short HEAD) — nothing to update"; exit 0; fi
CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
echo "updated $(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER"):"
git log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'

# What only a full deploy can bring: the web app's build, the Prisma client, dependencies, images.
FULL=$(echo "$CHANGED" | grep -E '^(prisma/|package(-lock)?\.json$|Dockerfile$|docker/|src/app/|src/components/|next\.config|public/|whatsapp-bot/(package(-lock)?\.json|Dockerfile)$)' || true)
if [ -n "$FULL" ]; then
  echo
  echo "✗ these changes need the full deploy (an image build), not just a restart:"
  echo "$FULL" | sed 's/^/    /'
  echo "  Build the package at $(git rev-parse --short HEAD) on the Mac (bash scripts/prebuilt-next.sh), upload it, then:"
  echo "    bash scripts/deploy.sh ~/prebuilt-next-$(git rev-parse --short=7 HEAD).tar.gz"
  exit 1
fi

# New mounts or settings in the compose files: recreate the containers (no build).
if echo "$CHANGED" | grep -qE '^docker-compose(\.wa)?\.yml$'; then
  echo "→ compose files changed: recreating app, worker and gateway (no build)"
  $COMPOSE up -d --no-build app worker wa-gateway
fi
if echo "$CHANGED" | grep -qE '^src/(lib|worker|types)/'; then echo "→ agent code changed: restarting the worker"; $COMPOSE restart worker; fi
if echo "$CHANGED" | grep -qE '^whatsapp-bot/(index\.mjs|lib/)'; then echo "→ gateway code changed: restarting the gateway"; $COMPOSE restart wa-gateway; fi
if echo "$CHANGED" | grep -qE '^src/lib/' ; then echo "  (the console's own pages keep the previous src/lib until the next full deploy — the agent runs the new code now)"; fi
sleep 8
$COMPOSE exec -T app npx tsx scripts/health.ts
}
main "$@"
