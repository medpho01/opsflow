-- WhatsApp Control Tower (Phase 1): inbox tables.
-- Additive only — creates 4 enums + 4 tables. Safe to apply on top of the
-- existing schema; guarded with IF NOT EXISTS so it is re-runnable.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WaGroupRole" AS ENUM ('SUPPORT', 'PROVIDER', 'INTERNAL', 'IGNORE');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "WaTicketStatus" AS ENUM ('NEW', 'OPEN', 'WAITING_INFO', 'WAITING_LAB', 'ANSWERED', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "WaMsgDirection" AS ENUM ('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "WaOutboundStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "WaGatewayStatus" AS ENUM ('CONNECTING', 'QR', 'CONNECTED', 'LOGGED_OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "wa_groups" (
    "id" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "role" "WaGroupRole" NOT NULL DEFAULT 'SUPPORT',
    "storeId" INTEGER,
    "labId" INTEGER,
    "autoAskIdOnMissing" BOOLEAN NOT NULL DEFAULT true,
    "sendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wa_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wa_tickets" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "storeId" INTEGER,
    "status" "WaTicketStatus" NOT NULL DEFAULT 'NEW',
    "orderId" INTEGER,
    "requestId" INTEGER,
    "intent" TEXT,
    "contextSnapshot" JSONB,
    "assignedToId" INTEGER,
    "slaDueAt" TIMESTAMP(3),
    "firstMessageId" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wa_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wa_messages" (
    "id" TEXT NOT NULL,
    "waMsgId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "ticketId" TEXT,
    "direction" "WaMsgDirection" NOT NULL DEFAULT 'IN',
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mediaType" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "replyToWaId" TEXT,
    "intent" TEXT,
    "orderIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "requestIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wa_outbound" (
    "id" TEXT NOT NULL,
    "targetJid" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "WaOutboundStatus" NOT NULL DEFAULT 'QUEUED',
    "ticketId" TEXT,
    "groupId" TEXT,
    "createdById" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentWaMsgId" TEXT,
    "quotedWaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "wa_outbound_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wa_gateway" (
    "id" TEXT NOT NULL,
    "status" "WaGatewayStatus" NOT NULL DEFAULT 'CONNECTING',
    "qr" TEXT,
    "qrUpdatedAt" TIMESTAMP(3),
    "connectedNumber" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "command" TEXT,
    "commandRequestedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wa_gateway_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wa_groups_jid_key" ON "wa_groups"("jid");
CREATE INDEX IF NOT EXISTS "wa_groups_role_idx" ON "wa_groups"("role");
CREATE INDEX IF NOT EXISTS "wa_groups_active_idx" ON "wa_groups"("active");
CREATE UNIQUE INDEX IF NOT EXISTS "wa_messages_waMsgId_key" ON "wa_messages"("waMsgId");
CREATE INDEX IF NOT EXISTS "wa_messages_groupId_ts_idx" ON "wa_messages"("groupId", "ts");
CREATE INDEX IF NOT EXISTS "wa_messages_ticketId_idx" ON "wa_messages"("ticketId");
CREATE INDEX IF NOT EXISTS "wa_messages_ts_idx" ON "wa_messages"("ts");
CREATE INDEX IF NOT EXISTS "wa_tickets_status_idx" ON "wa_tickets"("status");
CREATE INDEX IF NOT EXISTS "wa_tickets_groupId_idx" ON "wa_tickets"("groupId");
CREATE INDEX IF NOT EXISTS "wa_tickets_orderId_idx" ON "wa_tickets"("orderId");
CREATE INDEX IF NOT EXISTS "wa_tickets_assignedToId_idx" ON "wa_tickets"("assignedToId");
CREATE INDEX IF NOT EXISTS "wa_tickets_lastActivityAt_idx" ON "wa_tickets"("lastActivityAt");
CREATE INDEX IF NOT EXISTS "wa_outbound_status_idx" ON "wa_outbound"("status");
CREATE INDEX IF NOT EXISTS "wa_outbound_ticketId_idx" ON "wa_outbound"("ticketId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "wa_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "wa_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "wa_tickets" ADD CONSTRAINT "wa_tickets_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "wa_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "wa_outbound" ADD CONSTRAINT "wa_outbound_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "wa_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "wa_outbound" ADD CONSTRAINT "wa_outbound_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "wa_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
