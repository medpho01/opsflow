import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";
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
  // Accept JSON (text only) or multipart/form-data (text + an attachment).
  let body: Record<string, unknown> = {};
  let media: { mime: string; name: string; bytes: Buffer } | null = null;
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, unknown>;
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > 16 * 1024 * 1024) return NextResponse.json({ error: "attachment too large (max 16MB)" }, { status: 400 });
      if (buf.length > 0) media = { mime: file.type || "application/octet-stream", name: file.name || "file", bytes: buf };
    }
  } else {
    body = await request.json().catch(() => ({}));
  }
  const text = String(body?.text || "").trim();
  const target = String(body?.target || "store");
  if (!text && !media) return NextResponse.json({ error: "text or an attachment is required" }, { status: 400 });

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
    // Prefer an explicitly chosen provider group (the dropdown); otherwise
    // resolve the order's OWN lab, then the store group's mapped lab.
    let lab = null;
    if (body?.labGroupId) {
      lab = await prisma.waGroup.findFirst({ where: { id: String(body.labGroupId), role: "PROVIDER" } });
    }
    if (!lab) {
      let labId = ticket.group.labId;
      if (ticket.orderId) {
        const rows = await labstackOr(
          labstack.$queryRaw<Array<{ labId: number | null }>>`SELECT "labId" FROM public."Order" WHERE id = ${ticket.orderId} LIMIT 1`,
          [] as Array<{ labId: number | null }>, 3000, { breakerKey: "wa-reply-lab" }
        );
        labId = rows[0]?.labId ?? labId;
      }
      if (labId) lab = await prisma.waGroup.findFirst({ where: { role: "PROVIDER", labId } });
    }
    if (!lab) return NextResponse.json({ error: "no provider group for this order's lab — pick one from the list" }, { status: 400 });
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

  // Optional threaded reply: quote a specific message (the gateway only
  // renders the quote when it lives in the same target chat).
  const quotedWaId = body?.quotedWaMsgId ? String(body.quotedWaMsgId) : null;

  await prisma.waOutbound.create({
    data: {
      targetJid, text, groupId: targetGroupId, ticketId: ticket.id, createdById: user.id, quotedWaId,
      ...(media ? { mediaMime: media.mime, mediaName: media.name, mediaBytes: media.bytes } : {}),
    },
  });
  if (nextStatus) {
    await prisma.waTicket.update({ where: { id: ticket.id }, data: { status: nextStatus, lastActivityAt: new Date() } });
  }

  return NextResponse.json({ ok: true, queuedTo: targetJid, ticketStatus: nextStatus });
}
