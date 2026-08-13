import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// POST /api/whatsapp/tickets/:id/reply
// body: { text, target: "store" | "lab" | "other", toNumber? }
// Enqueues an outbound message (the gateway sends it) and advances the ticket.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || "").trim();
  const target = String(body?.target || "store");
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const ticket = await prisma.waTicket.findUnique({ where: { id }, include: { group: true } });
  if (!ticket || !ticket.group) return NextResponse.json({ error: "ticket not found" }, { status: 404 });

  let targetJid: string | null = null;
  let targetGroupId: string | null = null;
  let nextStatus: "ANSWERED" | "WAITING_LAB" | null = null;

  if (target === "store") {
    targetJid = ticket.group.jid;
    targetGroupId = ticket.group.id;
    nextStatus = "ANSWERED";
  } else if (target === "lab") {
    if (!ticket.group.labId)
      return NextResponse.json({ error: "no lab linked to this group — set it in Settings" }, { status: 400 });
    const lab = await prisma.waGroup.findFirst({ where: { role: "PROVIDER", labId: ticket.group.labId } });
    if (!lab) return NextResponse.json({ error: "no provider group found for this lab" }, { status: 400 });
    targetJid = lab.jid;
    targetGroupId = lab.id;
    nextStatus = "WAITING_LAB";
  } else if (target === "other") {
    const digits = String(body?.toNumber || "").replace(/\D/g, "");
    if (digits.length < 8) return NextResponse.json({ error: "enter a valid number with country code" }, { status: 400 });
    targetJid = `${digits}@s.whatsapp.net`;
  } else {
    return NextResponse.json({ error: "target must be store, lab, or other" }, { status: 400 });
  }

  await prisma.waOutbound.create({
    data: { targetJid, text, groupId: targetGroupId, ticketId: ticket.id, createdById: user.id },
  });
  if (nextStatus) {
    await prisma.waTicket.update({ where: { id: ticket.id }, data: { status: nextStatus, lastActivityAt: new Date() } });
  }

  return NextResponse.json({ ok: true, queuedTo: targetJid, ticketStatus: nextStatus });
}
