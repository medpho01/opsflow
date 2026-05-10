# syntax=docker/dockerfile:1.6
#
# OpsFlow / TaskOs — production-ish container.
#
# Two-stage build:
#   1. `builder` — install all deps, generate Prisma client (linux-musl
#      target, see schema.prisma generator block), and build Next.
#   2. `runner`  — minimal Alpine + node_modules + build output. Runs as
#      a non-root user.
#
# Node 20 LTS on Debian bullseye (glibc 2.31). Prisma 4.16's query
# engine binary heap-corrupts on glibc 2.36 (bookworm) — both library
# and binary engines trip "malloc(): unaligned tcache chunk detected"
# / "malloc_consolidate(): invalid chunk size" within a few queries.
# Prisma 4.16 was released against bullseye-era glibc and runs cleanly
# there. jemalloc LD_PRELOAD didn't help because the Rust engine has
# its own statically-linked allocator.
ARG NODE_VERSION=20-bullseye-slim

# ── Build stage ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Debian system packages:
#   openssl + ca-certificates — Prisma's binary engine SSL deps
#   python3 + build-essential — node-gyp deps for any optional native pkg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install deps — copy lockfile-first for cache stability
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

# Copy source. Build artifacts and node_modules are excluded by .dockerignore.
COPY . .

# Generate Prisma client (uses linux-musl binary target from schema.prisma)
RUN node node_modules/prisma/build/index.js generate

# Build Next.js. distDir=build (set in next.config.ts) so the output
# lives under build/ not .next/.
ENV NEXT_TELEMETRY_DISABLED=1
RUN node node_modules/next/dist/bin/next build

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# Runtime needs:
#   openssl + ca-certificates — Prisma engine SSL
#   postgresql-client         — pg_isready in entrypoint
#   tini                      — proper PID-1 signal handling
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates postgresql-client tini && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TZ=Asia/Kolkata

# Copy what the runtime actually needs:
#   - package.json so node resolves modules
#   - node_modules with prisma + tsx + next
#   - prisma/schema.prisma (db push reads it at startup)
#   - docker/ (entrypoint + admin seed)
#   - build/ (Next compiled output)
#   - public/ (static assets)
#   - next.config.ts (used by `next start` to find build/)
#   - src/lib/auth/password (imported by seed if you swap it later)
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/package-lock.json* ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/docker ./docker
COPY --from=builder --chown=app:app /app/build ./build
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=app:app /app/tsconfig.json ./tsconfig.json
# tsx needs the source for seed-admin.ts; pull only what's referenced
COPY --from=builder --chown=app:app /app/src/lib ./src/lib
COPY --from=builder --chown=app:app /app/src/types ./src/types

USER app

EXPOSE 3000

# tini reaps zombies + forwards SIGTERM to Next so docker stop is clean.
# (Debian's tini ships at /usr/bin/tini, not /sbin/tini like Alpine.)
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
