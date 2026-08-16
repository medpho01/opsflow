import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, Prisma } from "@prisma/client";

// POST /api/whatsapp/tickets/:id/forward
// Relay a lab/provider message (its TEXT and its captured IMAGE/DOCUMENT) back to
// the store group that raised the query — the "lab replied, post it to the store"
// step. General purpose: works for slots, reports, confirmations, anything.
//
// body: {
//   sourceWaMsgId: string,   // the lab message to forward (its media rides along)
//   storeGroupId?: string,   // target store group; else inferred from the order
//   text?: string,           // note to prepend/replace (defaults to the caption)
//   quote?: boolean,         // quote the store's original question (default true)
// }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const sourceWaMsgId = String(body?.sourceWaMsgId || "").trim();
  if (!sourceWaMsgId) return NextResponse.json({ error: "sourceWaMsgId is required" }, { status: 400 });

  const ticket = await prisma.waTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "ticket not found" }, { status: 404 });

  const source = await prisma.waMessage.findUnique({ where: { waMsgId: sourceWaMsgId } });
  if (!source) return NextResponse.json({ error: "source message not found" }, { status: 404 });

  // Resolve the target store group: explicit id wins; otherwise the SUPPORT group
  // where this order/request was raised (the origin of the query).
  let storeGroup: { id: string; jid: string; subject: string } | null = null;
  if (body?.storeGroupId) {
    const g = await prisma.waGroup.findFirst({
      where: { id: String(body.storeGroupId), role: "SUPPORT" },
      select: { id: true, jid: true, subject: true },
    });
    if (g) storeGroup = g;
  }
  if (!storeGroup && (ticket.orderId || ticket.requestId)) {
    const where: Prisma.WaMessageWhereInput = {
      group: { role: "SUPPORT" },
      ...(ticket.orderId ? { orderIds: { has: ticket.orderId } } : { requestIds: { has: ticket.requestId! } }),
    };
    const originMsg = await prisma.waMessage.findFirst({
      where, orderBy: { ts: "desc" },
      include: { group: { select: { id: true, jid: true, subject: true } } },
    });
    if (originMsg?.group) storeGroup = originMsg.group;
  }
  if (!storeGroup) return NextResponse.json({ error: "no store group found for this order — pick one" }, { status: 400 });

  // Quote the store's most recent question so the relay lands in that thread.
  let quotedWaId: string | null = null;
  if (body?.quote !== false && (ticket.orderId || ticket.requestId)) {
    const q = await prisma.waMessage.findFirst({
      where: {
        groupId: storeGroup.id, fromMe: false,
        ...(ticket.orderId ? { orderIds: { has: ticket.orderId } } : { requestIds: { has: ticket.requestId! } }),
      },
      orderBy: { ts: "desc" }, select: { waMsgId: true },
    });
    quotedWaId = q?.waMsgId || null;
  }

  // Carry the lab's captured media (the slot screenshot / report) if we have the
  // bytes. Without them we still relay the text so the store isn't left blank.
  const srcMedia = source.mediaType ? await prisma.waMedia.findUnique({ where: { waMsgId: sourceWaMsgId } }) : null;
  const note = String(body?.text || "").trim();
  const text = note || source.text || "";
  if (!text && !srcMedia) return NextResponse.json({ error: "nothing to forward (no note, no media)" }, { status: 400 });

  // Link the relay to the store's own open case so it threads and reopens there.
  const storeTicket = (ticket.orderId || ticket.requestId)
    ? await prisma.waTicket.findFirst({
        where: {
          groupId: storeGroup.id, status: { not: "RESOLVED" },
          ...(ticket.orderId ? { orderId: ticket.orderId } : { requestId: ticket.requestId! }),
        },
        orderBy: { lastActivityAt: "desc" }, select: { id: true },
      })
    : null;

  await prisma.waOutbound.create({
    data: {
      targetJid: storeGroup.jid, text, groupId: storeGroup.id,
      ticketId: storeTicket?.id || null, createdById: user.id, quotedWaId,
      ...(srcMedia ? { mediaMime: srcMedia.mime, mediaName: source.mediaType === "document" ? "attachment" : "image.jpg", mediaBytes: srcMedia.bytes } : {}),
    },
  });

  // The store case now has a fresh update from us and is awaiting the store's action.
  if (storeTicket) {
    await prisma.waTicket.update({
      where: { id: storeTicket.id },
      data: { status: "ANSWERED", lastActivityAt: new Date() },
    }).catch(() => {});
  }

  return NextResponse.json({
    ok: true, queuedTo: storeGroup.subject, hadMedia: !!srcMedia, quoted: !!quotedWaId,
  });
}
