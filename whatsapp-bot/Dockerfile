# WhatsApp gateway (Baileys) — the bridge between WhatsApp and the taskos DB.
# Headless: the QR is rendered in the OpsFlow console (Settings), so no TTY is
# needed. Persist /app/auth as a volume so the linked-device session survives
# restarts.
FROM node:20-bookworm-slim

# git + ca-certificates: Baileys pulls libsignal via a git dependency at
# install time, and needs CA certs for the WhatsApp TLS connection.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

# DRY_RUN defaults on — sending stays disabled until explicitly turned off.
ENV DRY_RUN=true
ENV NODE_ENV=production

CMD ["node", "index.mjs"]
