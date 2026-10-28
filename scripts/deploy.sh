#!/usr/bin/env bash
# Deploy a prebuilt package on the VM — one command, refuses to build the wrong commit.
#
#   bash scripts/deploy.sh ~/prebuilt-next-<sha>.tar.gz
#
# Pulls, checks that HEAD is the package's commit (the sha is in the file name — a
# pull that ran before the push landed builds old source, 28 Oct 2026), extracts,
# builds app + gateway, restarts, and prints the health check.
set -euo pipefail
PKG="${1:-}"
[ -f "$PKG" ] || { echo "usage: bash scripts/deploy.sh ~/prebuilt-next-<sha>.tar.gz"; exit 2; }
SHA=$(basename "$PKG" | sed -E 's/^prebuilt-next-([0-9a-f]+)\.tar\.gz$/\1/')
cd "$(dirname "$0")/.."
git pull -q --ff-only
HEAD=$(git rev-parse --short=7 HEAD)
if [ "${HEAD#"${SHA}"}" = "$HEAD" ] && [ "${SHA#"${HEAD}"}" = "$SHA" ]; then
  echo "✗ checkout is at $HEAD but the package is $SHA — push that commit from your machine, then run this again"; exit 1
fi
rm -rf prebuilt-next ._prebuilt-next
tar xzf "$PKG"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.wa.yml"
$COMPOSE build app wa-gateway
$COMPOSE up -d app worker wa-gateway
$COMPOSE exec -T app npx tsx scripts/health.ts
