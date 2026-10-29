#!/usr/bin/env bash
# Build Next here, ship only the output (27 Oct 2026). The VM cannot run
# `next build` (memory), but can do everything else: npm install is cached,
# prisma generate is light. So:
#
#   bash scripts/prebuilt-next.sh            → ~/Downloads/prebuilt-next-<sha>.tar.gz
#
# then on the VM (after uploading the file to the home folder):
#
#   cd ~/opsflow && git pull && rm -rf prebuilt-next && tar xzf ~/prebuilt-next-<sha>.tar.gz \
#     && docker compose -f docker-compose.yml -f docker-compose.wa.yml build app wa-gateway \
#     && docker compose -f docker-compose.yml -f docker-compose.wa.yml up -d app worker wa-gateway
#
# The build is made from a clean export of HEAD with no .env, exactly as the
# Docker build sees the source (NEXT_PUBLIC_* values are inlined at build time;
# the server image has never had them, so neither does this). The tarball must
# match the commit the VM pulls: the script refuses a dirty tree.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "commit or stash your changes first: the VM pulls HEAD and the build must match it" >&2; exit 1; fi
SHA=$(git rev-parse --short HEAD)
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.14.0/bin}"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git archive HEAD | tar -x -C "$WORK"
ln -s "$PWD/node_modules" "$WORK/node_modules"
( cd "$WORK" && NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build >/dev/null )
rm -rf "$WORK/build/cache"
OUT="$HOME/Downloads/prebuilt-next-$SHA.tar.gz"
# macOS tar adds extended attributes (com.apple.provenance) that GNU tar on the VM prints a
# warning for, once per file; leave them out.
export COPYFILE_DISABLE=1
tar -C "$WORK" -czf "$OUT" --transform 's,^build,prebuilt-next,' build 2>/dev/null \
  || tar -C "$WORK" --no-xattrs --no-mac-metadata -s ',^build,prebuilt-next,' -czf "$OUT" build 2>/dev/null \
  || tar -C "$WORK" -s ',^build,prebuilt-next,' -czf "$OUT" build
echo "$OUT ($(du -h "$OUT" | cut -f1)) — built from $SHA"
