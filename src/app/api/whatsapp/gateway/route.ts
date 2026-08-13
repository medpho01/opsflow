import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/gateway — connection status + live QR (as a data URL)
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  if (!gw) {
    return NextResponse.json({ status: "CONNECTING", online: false, connectedNumber: null, qrDataUrl: null, lastSeenAt: null });
  }
  const online = !!gw.lastSeenAt && Date.now() - new Date(gw.lastSeenAt).getTime() < 60_000;
  let qrDataUrl: string | null = null;
  if (gw.status === "QR" && gw.qr) {
    try { qrDataUrl = await QRCode.toDataURL(gw.qr, { width: 260, margin: 1 }); } catch { qrDataUrl = null; }
  }
  return NextResponse.json({
    status: gw.status,
    online,
    connectedNumber: gw.connectedNumber,
    lastSeenAt: gw.lastSeenAt,
    qrDataUrl,
  });
}

// POST /api/whatsapp/gateway — issue an admin command (RELINK | LOGOUT)
export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const command = String(body?.command || "").toUpperCase();
  if (!["RELINK", "LOGOUT"].includes(command))
    return NextResponse.json({ error: "command must be RELINK or LOGOUT" }, { status: 400 });

  await prisma.waGateway.upsert({
    where: { id: "default" },
    create: { id: "default", status: "CONNECTING", command, commandRequestedAt: new Date() },
    update: { command, commandRequestedAt: new Date() },
  });
  return NextResponse.json({ ok: true, command });
}
